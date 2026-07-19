/**
 * Sink da engine respaldado por OMS+executor.
 * Strategy continua vendo só ExecutionEvents (intentId), nunca exchangeOrderId.
 */

import { createOms } from './createOms.js';
import { createExecutor, createTransportForMode } from '../executor/createExecutor.js';
import { createUserChannel } from '../executor/userChannel.js';
import { createReconciler } from './reconciler.js';

/**
 * @param {object} [opts]
 * @param {'dry-run'|'shadow'|'live'} [opts.mode]
 * @param {object} [opts.oms]
 * @param {object} [opts.transport]
 * @param {object} [opts.marketRules]
 * @param {() => number} [opts.clock]
 * @param {boolean} [opts.withUserChannel]
 */
export function createOmsSink(opts = {}) {
  const mode = opts.mode ?? 'shadow';
  const clock = opts.clock ?? (() => Date.now());
  const oms = opts.oms ?? createOms({ clock, marketRules: opts.marketRules });
  const transport = opts.transport ?? createTransportForMode(mode, { clock, behavior: opts.simBehavior });
  const executor = createExecutor({ oms, transport, clock });
  const userChannel = opts.withUserChannel ? createUserChannel({ kind: 'sim' }) : null;
  if (userChannel) userChannel.connect();
  const reconciler = createReconciler(oms);

  const heartbeat = {
    stop: null,
    lastMs: null,
  };
  if (userChannel && opts.heartbeat !== false) {
    heartbeat.stop = userChannel.startHeartbeat(opts.heartbeatMs ?? 10_000, (ms) => {
      heartbeat.lastMs = ms;
      oms.journal.append('heartbeat', { ms });
    });
  }

  return {
    mode,
    oms,
    executor,
    userChannel,
    reconciler,
    heartbeat,

    /**
     * Interface sink da engine.
     * @param {import('../engine/schemas.js').TradeIntent} intent
     */
    async submit(intent) {
      if (userChannel && !userChannel.connected && mode === 'live') {
        return {
          accepted: false,
          events: [
            {
              eventId: `sink-offline-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'REJECT',
              side: intent.side,
              qty: 0,
              price: null,
              reason: 'USER_CHANNEL_DISCONNECTED',
              tsMs: clock(),
            },
          ],
        };
      }

      const result = await executor.executeIntent(intent);

      // Espelha eventos no user channel (fonte primária simulada)
      if (userChannel) {
        for (const ev of result.events) {
          userChannel.push({ ...ev, eventId: `uc-${ev.eventId}` });
        }
      }

      return {
        accepted: result.accepted,
        events: result.events,
        deduped: result.deduped,
      };
    },

    cancelOnDisconnect() {
      if (!userChannel) return { canceled: [] };
      const canceled = [];
      for (const order of oms.openOrders()) {
        // marca cancel protetivo
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

    dispose() {
      if (typeof heartbeat.stop === 'function') heartbeat.stop();
      if (userChannel?.connected) userChannel.disconnect();
    },
  };
}
