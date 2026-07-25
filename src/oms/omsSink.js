/** Sink da engine respaldado por OMS, transport e user WS. */

import { createOms } from './createOms.js';
import { createExecutor, createTransportForMode } from '../executor/createExecutor.js';
import { createUserChannel, normalizeUserMessage } from '../executor/userChannel.js';
import { createReconciler } from './reconciler.js';
import { isTerminal } from './states.js';
import { executeReverseSaga } from './reverseSaga.js';

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
  let userDisconnectHaltTimer = null;
  const userDisconnectHaltMs = Number(opts.userDisconnectHaltMs ?? 60_000);

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

  function clearUserDisconnectHaltTimer() {
    if (userDisconnectHaltTimer) {
      clearTimeout(userDisconnectHaltTimer);
      userDisconnectHaltTimer = null;
    }
  }

  function applyExternalEvent(event, applyOpts = {}) {
    const notify = applyOpts.notify !== false;
    const applied = oms.applyExchangeEvent(event);
    if (notify) {
      for (const normalized of applied.executionEvents ?? []) notifyExecution(normalized);
    }
    return applied;
  }

  if (userChannel) {
    userChannel.onEvent((message) => {
      for (const event of normalizeUserMessage(message, oms, clock)) applyExternalEvent(event);
    });
    userChannel.onDisconnect?.((detail) => {
      // Blip de WS: cancela resting e degrada readiness, mas NÃO halt imediato.
      // O user channel reconecta com backoff; halt só se ficar down tempo demais.
      lastChannelError = { reason: 'USER_CHANNEL_DISCONNECTED', detail };
      if (mode === 'live') {
        void transport.cancelAll?.().catch(() => {});
        clearUserDisconnectHaltTimer();
        if (userDisconnectHaltMs > 0) {
          userDisconnectHaltTimer = setTimeout(() => {
            userDisconnectHaltTimer = null;
            if (userChannel?.connected) return;
            notifyCritical(lastChannelError ?? { reason: 'USER_CHANNEL_DISCONNECTED' });
          }, userDisconnectHaltMs);
          userDisconnectHaltTimer.unref?.();
        }
      }
    });
    userChannel.onReconnect?.((detail) => {
      clearUserDisconnectHaltTimer();
      if (lastChannelError?.reason === 'USER_CHANNEL_DISCONNECTED') {
        lastChannelError = null;
      }
      void detail;
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
      if (intent?.kind === 'REVERSE') {
        const result = await executeReverseSaga({
          intent,
          oms,
          executeIntent: (leg) => executor.executeIntent(leg),
          waitForFinal:
            mode === 'live' ? (intentId, waitOpts) => api.waitForFinal(intentId, waitOpts) : undefined,
          clock,
          legTimeoutMs: opts.reverseLegTimeoutMs,
        });
        return {
          accepted: result.accepted,
          events: result.events,
          deduped: result.deduped,
        };
      }
      const result = await executor.executeIntent(intent);
      const events = [...(result.events ?? [])];

      // FAK/FOK: POST só gera ACK. Sem poll/terminalização a ordem pode ficar LIVE
      // eternamente se o user WS não emitir kill — trava ENTRY_PENDING.
      const orderAfter = oms.getOrder(intent.intentId);
      const orderType = String(intent.orderType ?? orderAfter?.orderType ?? '').toUpperCase();
      const needsFinal =
        result.accepted !== false &&
        orderAfter &&
        !isTerminal(orderAfter.state) &&
        (orderType === 'FAK' || orderType === 'FOK') &&
        typeof transport.reconcile === 'function' &&
        (mode === 'live' || opts.finalizeImmediateOrders === true);
      if (needsFinal) {
        const waited = await api.waitForFinal(intent.intentId, {
          timeoutMs: Number(opts.immediateOrderTimeoutMs ?? 3_000),
          pollMs: Number(opts.immediateOrderPollMs ?? 100),
          killOnTimeout: true,
          // Caller (engine.dispatchIntent) ingere os events retornados — evita FILL duplo.
          notify: false,
        });
        if (Array.isArray(waited.executionEvents) && waited.executionEvents.length) {
          events.push(...waited.executionEvents);
        }
      }

      return {
        accepted: result.accepted,
        events,
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

    async cancelOpenOrders(reason = 'ops-cancel', predicate = () => true) {
      const canceled = [];
      const failed = [];
      for (const order of oms.openOrders().filter((order) => predicate(order))) {
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

    async cancelOpenEntries(reason = 'operator-disarm') {
      return api.cancelOpenOrders(
        reason,
        (order) => order.kind === 'ENTER' || order.kind === 'REVERSE',
      );
    },

    async reconcileOrder(intentId, reconcileOpts = {}) {
      const raw = oms.getOrderRaw(intentId);
      if (!raw) return { ok: false, events: [], executionEvents: [], reason: 'ORDER_NOT_FOUND' };
      const result = await transport.reconcile?.(raw);
      if (!result) return { ok: false, events: [], executionEvents: [], reason: 'RECONCILE_UNAVAILABLE' };
      const executionEvents = [];
      for (const event of result.events ?? []) {
        const applied = applyExternalEvent(event, { notify: reconcileOpts.notify !== false });
        executionEvents.push(...(applied.executionEvents ?? []));
      }
      return { ...result, executionEvents };
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
      const fakMaxLiveMs = Number(opts.fakMaxLiveMs ?? 5_000);
      for (const order of oms.openOrders()) {
        const orderType = String(order.orderType ?? '').toUpperCase();
        const immediate = orderType === 'FAK' || orderType === 'FOK';
        const ageMs = clock() - Number(order.createdAtMs ?? clock());
        if (immediate && ageMs >= fakMaxLiveMs) {
          const killed = await api.killImmediateOrder(order.intentId, 'fak_stale_live_killed');
          if (!killed.ok) {
            unresolved.push({ intentId: order.intentId, reason: killed.reason ?? 'FAK_STALE' });
            continue;
          }
        }
        const result = await api.reconcileOrder(order.intentId);
        const current = oms.getOrder(order.intentId);
        // FAK/FOK em LIVE não conta como resolvido — precisa terminalizar.
        const stillOpen =
          current &&
          !isTerminal(current.state) &&
          !(current.state === 'LIVE' && !immediate);
        if (!result.ok || stillOpen) {
          unresolved.push({ intentId: order.intentId, reason: result.reason ?? current?.state });
        }
      }
      return {
        ok: unresolved.length === 0 && lastRemoteOrphans.length === 0,
        unresolved,
        orphans: [...lastRemoteOrphans],
      };
    },

    /**
     * Cancela FAK/FOK no exchange e força CANCEL local se ainda não terminal.
     * @param {string} intentId
     * @param {string} reason
     * @param {{ notify?: boolean }} [killOpts]
     */
    async killImmediateOrder(intentId, reason = 'fak_killed', killOpts = {}) {
      const notify = killOpts.notify !== false;
      const raw = oms.getOrderRaw(intentId);
      if (!raw) return { ok: false, reason: 'ORDER_NOT_FOUND', events: [], executionEvents: [] };
      if (isTerminal(raw.state)) {
        return { ok: true, order: oms.getOrder(intentId), events: [], executionEvents: [] };
      }
      const executionEvents = [];
      try {
        const cancelResult = await transport.cancel(raw);
        for (const event of cancelResult.events ?? []) {
          const applied = applyExternalEvent(event, { notify });
          executionEvents.push(...(applied.executionEvents ?? []));
        }
      } catch (err) {
        lastChannelError = { reason: 'FAK_KILL_CANCEL_FAILED', detail: err.message };
      }
      const current = oms.getOrder(intentId);
      if (current && !isTerminal(current.state)) {
        const applied = applyExternalEvent(
          {
            eventId: `fak-kill-${intentId}-${clock()}`,
            intentId,
            exchangeOrderId: raw.exchangeOrderId,
            type: 'CANCEL',
            qty: 0,
            price: null,
            reason,
            tsMs: clock(),
          },
          { notify },
        );
        executionEvents.push(...(applied.executionEvents ?? []));
      }
      const finalOrder = oms.getOrder(intentId);
      return {
        ok: Boolean(finalOrder && isTerminal(finalOrder.state)),
        order: finalOrder,
        events: executionEvents,
        executionEvents,
        reason: finalOrder && isTerminal(finalOrder.state) ? null : reason,
      };
    },

    async waitForFinal(intentId, waitOpts = {}) {
      const timeoutMs = Number(waitOpts.timeoutMs ?? 15_000);
      const pollMs = Number(waitOpts.pollMs ?? 250);
      const killOnTimeout = waitOpts.killOnTimeout === true;
      const notify = waitOpts.notify !== false;
      const deadline = clock() + timeoutMs;
      const executionEvents = [];
      while (clock() < deadline) {
        const step = await api.reconcileOrder(intentId, { notify });
        if (Array.isArray(step.executionEvents) && step.executionEvents.length) {
          executionEvents.push(...step.executionEvents);
        }
        const order = oms.getOrder(intentId);
        if (order && isTerminal(order.state)) return { ok: true, order, executionEvents };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      const raw = oms.getOrderRaw(intentId);
      if (raw && !isTerminal(raw.state)) {
        const orderType = String(raw.orderType ?? '').toUpperCase();
        const immediate = orderType === 'FAK' || orderType === 'FOK';
        if (killOnTimeout && immediate) {
          const killed = await api.killImmediateOrder(intentId, 'fak_timeout_killed', { notify });
          executionEvents.push(...(killed.executionEvents ?? []));
          return {
            ok: killed.ok,
            order: killed.order,
            executionEvents,
            reason: killed.ok ? null : 'FAK_TIMEOUT_KILL_FAILED',
          };
        }
        const applied = applyExternalEvent(
          {
            eventId: `reconcile-timeout-${intentId}-${clock()}`,
            intentId,
            exchangeOrderId: raw.exchangeOrderId,
            type: 'UNKNOWN',
            qty: 0,
            price: null,
            reason: 'RECONCILE_TIMEOUT',
            tsMs: clock(),
          },
          { notify },
        );
        executionEvents.push(...(applied.executionEvents ?? []));
      }
      return {
        ok: false,
        order: oms.getOrder(intentId),
        executionEvents,
        reason: 'RECONCILE_TIMEOUT',
      };
    },

    dispose() {
      clearUserDisconnectHaltTimer();
      wsHeartbeatStop?.();
      clobHeartbeatStop?.();
      transport.stopHeartbeat?.();
      if (userChannel?.connected) userChannel.disconnect();
      executionListeners.clear();
      criticalListeners.clear();
      started = false;
    },

    /** Para reusar o sink entre engines (ex.: rotação de mercado no micro-live). */
    detachEngineListeners() {
      clearUserDisconnectHaltTimer();
      executionListeners.clear();
      criticalListeners.clear();
      lastChannelError = null;
    },
  };

  return api;
}
