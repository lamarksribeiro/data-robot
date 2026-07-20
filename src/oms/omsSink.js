/** Sink da engine respaldado por OMS, transport e user WS. */

import { createOms } from './createOms.js';
import { createExecutor, createTransportForMode } from '../executor/createExecutor.js';
import { createUserChannel, normalizeUserMessage } from '../executor/userChannel.js';
import { createReconciler } from './reconciler.js';
import { isTerminal } from './states.js';

export function createOmsSink(opts = {}) {
  const mode = opts.mode ?? 'shadow';
  const clock = opts.clock ?? (() => Date.now());
  const oms = opts.oms ?? createOms({ clock, marketRules: opts.marketRules });
  const transport =
    opts.transport ??
    createTransportForMode(mode, {
      clock,
      behavior: opts.simBehavior,
      client: opts.client,
      Side: opts.Side,
      OrderType: opts.OrderType,
      postOnly: opts.postOnly,
      resolveTokenId: opts.resolveTokenId,
    });
  const executor = createExecutor({ oms, transport, clock });
  const userChannel =
    opts.userChannel ??
    (opts.withUserChannel
      ? createUserChannel({
          kind: opts.userChannelKind ?? 'sim',
          clock,
          ...(opts.userChannelOpts ?? {}),
        })
      : null);
  const reconciler = createReconciler(oms);
  const executionListeners = new Set();
  const criticalListeners = new Set();
  let started = false;
  let wsHeartbeatStop = null;
  let clobHeartbeatStop = null;
  let lastChannelError = null;
  let lastRemoteOrphans = [];

  function notifyExecution(event) {
    for (const listener of executionListeners) {
      Promise.resolve(listener(event)).catch(() => {});
    }
  }

  function notifyCritical(detail) {
    for (const listener of criticalListeners) {
      Promise.resolve(listener(detail)).catch(() => {});
    }
  }

  function applyExternalEvent(event) {
    const applied = oms.applyExchangeEvent(event);
    for (const normalized of applied.executionEvents ?? []) notifyExecution(normalized);
    return applied;
  }

  if (userChannel) {
    userChannel.onEvent((message) => {
      for (const event of normalizeUserMessage(message, oms, clock)) applyExternalEvent(event);
    });
    userChannel.onDisconnect?.((detail) => {
      lastChannelError = { reason: 'USER_CHANNEL_DISCONNECTED', detail };
      if (mode === 'live') {
        void transport.cancelAll?.().catch(() => {});
        notifyCritical(lastChannelError);
      }
    });
    if (userChannel.kind === 'sim') userChannel.connect();
  }

  async function start() {
    if (started) return { ok: true };
    if (mode === 'live' && (!userChannel || userChannel.kind !== 'ws')) {
      throw new Error('live exige user WebSocket autenticado real');
    }
    if (userChannel && !userChannel.connected) await userChannel.connect();
    if (userChannel) {
      wsHeartbeatStop = userChannel.startHeartbeat(opts.userWsHeartbeatMs ?? 10_000);
    }
    if (mode === 'live') {
      clobHeartbeatStop = await transport.startHeartbeat?.((err) => {
        lastChannelError = { reason: 'CLOB_HEARTBEAT_FAILED', detail: err.message };
        void transport.cancelAll?.().catch(() => {});
        notifyCritical(lastChannelError);
      }, opts.clobHeartbeatMs ?? 5000);
      if (typeof transport.startHeartbeat !== 'function') {
        throw new Error('live exige heartbeat CLOB real');
      }
    }
    started = true;
    return { ok: true };
  }

  const api = {
    mode,
    oms,
    executor,
    transport,
    userChannel,
    reconciler,

    get started() {
      return started;
    },

    get lastChannelError() {
      return lastChannelError;
    },

    get orphanCount() {
      return lastRemoteOrphans.length;
    },

    onExecutionEvent(listener) {
      executionListeners.add(listener);
      return () => executionListeners.delete(listener);
    },

    onCritical(listener) {
      criticalListeners.add(listener);
      return () => criticalListeners.delete(listener);
    },

    async start() {
      return start();
    },

    assertReady() {
      if (mode !== 'live') return true;
      const heartbeatAgeMs =
        userChannel?.lastHeartbeatMs == null ? Infinity : clock() - userChannel.lastHeartbeatMs;
      if (
        !started ||
        !userChannel?.connected ||
        heartbeatAgeMs > Number(opts.userWsStaleMs ?? 30_000) ||
        lastChannelError
      ) {
        throw new Error(lastChannelError?.reason ?? 'LIVE_SINK_NOT_READY');
      }
      return true;
    },

    async submit(intent) {
      if (mode === 'live') api.assertReady();
      const result = await executor.executeIntent(intent);
      return {
        accepted: result.accepted,
        events: result.events,
        deduped: result.deduped,
      };
    },

    cancelOnDisconnect() {
      if (mode === 'live') return api.cancelOpenOrders('cancel-on-disconnect');
      if (!userChannel) return { canceled: [] };
      const canceled = [];
      for (const order of oms.openOrders()) {
        oms.applyExchangeEvent({
          eventId: `cod-${order.intentId}`,
          intentId: order.intentId,
          type: 'CANCEL',
          reason: 'cancel-on-disconnect',
          tsMs: clock(),
        });
        canceled.push(order.intentId);
      }
      userChannel.disconnect({ cancelOnDisconnect: true });
      return { canceled };
    },

    async cancelOpenOrders(reason = 'ops-cancel') {
      const canceled = [];
      const failed = [];
      for (const order of oms.openOrders()) {
        const raw = oms.getOrderRaw(order.intentId);
        if (!raw) continue;
        const result = await transport.cancel(raw);
        for (const event of result.events ?? []) applyExternalEvent(event);
        if (result.accepted) canceled.push(order.intentId);
        else failed.push({ intentId: order.intentId, reason: result.events?.[0]?.reason ?? reason });
      }
      if (mode === 'live' && failed.length) {
        try {
          await transport.cancelAll?.();
          const after = await transport.getOpenOrders?.();
          if (Array.isArray(after) && after.length === 0) {
            for (const row of failed.splice(0)) {
              applyExternalEvent({
                eventId: `cancel-all-${row.intentId}-${clock()}`,
                intentId: row.intentId,
                type: 'CANCEL',
                qty: 0,
                price: null,
                reason: 'cancel_all_verified',
                tsMs: clock(),
              });
              canceled.push(row.intentId);
            }
          }
        } catch (err) {
          lastChannelError = { reason: 'REMOTE_CANCEL_FAILED', detail: err.message };
          notifyCritical(lastChannelError);
        }
      }
      return { canceled, failed };
    },

    async reconcileOrder(intentId) {
      const raw = oms.getOrderRaw(intentId);
      if (!raw) return { ok: false, events: [], reason: 'ORDER_NOT_FOUND' };
      const result = await transport.reconcile?.(raw);
      if (!result) return { ok: false, events: [], reason: 'RECONCILE_UNAVAILABLE' };
      for (const event of result.events ?? []) applyExternalEvent(event);
      return result;
    },

    async reconcileAll() {
      const unresolved = [];
      try {
        const remoteOpen = (await transport.getOpenOrders?.()) ?? [];
        const knownExchangeIds = new Set(
          oms
            .listOrders()
            .map((order) => oms.getOrderRaw(order.intentId)?.exchangeOrderId)
            .filter(Boolean),
        );
        lastRemoteOrphans = remoteOpen.filter((order) => {
          const id = order.id ?? order.orderID ?? order.exchangeOrderId;
          return id && !knownExchangeIds.has(id);
        });
      } catch (err) {
        unresolved.push({ intentId: null, reason: `REMOTE_OPEN_ORDERS_FAILED:${err.message}` });
      }
      for (const order of oms.openOrders()) {
        const result = await api.reconcileOrder(order.intentId);
        const current = oms.getOrder(order.intentId);
        if (!result.ok || (current && !isTerminal(current.state) && current.state !== 'LIVE')) {
          unresolved.push({ intentId: order.intentId, reason: result.reason ?? current?.state });
        }
      }
      return {
        ok: unresolved.length === 0 && lastRemoteOrphans.length === 0,
        unresolved,
        orphans: [...lastRemoteOrphans],
      };
    },

    async waitForFinal(intentId, waitOpts = {}) {
      const timeoutMs = Number(waitOpts.timeoutMs ?? 15_000);
      const pollMs = Number(waitOpts.pollMs ?? 250);
      const deadline = clock() + timeoutMs;
      while (clock() < deadline) {
        await api.reconcileOrder(intentId);
        const order = oms.getOrder(intentId);
        if (order && isTerminal(order.state)) return { ok: true, order };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      const raw = oms.getOrderRaw(intentId);
      if (raw && !isTerminal(raw.state)) {
        applyExternalEvent({
          eventId: `reconcile-timeout-${intentId}-${clock()}`,
          intentId,
          exchangeOrderId: raw.exchangeOrderId,
          type: 'UNKNOWN',
          qty: 0,
          price: null,
          reason: 'RECONCILE_TIMEOUT',
          tsMs: clock(),
        });
      }
      return { ok: false, order: oms.getOrder(intentId), reason: 'RECONCILE_TIMEOUT' };
    },

    dispose() {
      wsHeartbeatStop?.();
      clobHeartbeatStop?.();
      transport.stopHeartbeat?.();
      if (userChannel?.connected) userChannel.disconnect();
      started = false;
    },
  };

  return api;
}
