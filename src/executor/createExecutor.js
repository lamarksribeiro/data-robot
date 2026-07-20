import { createSimTransport, createLiveTransportStub } from './transport.js';
import { createLiveTransport } from './liveTransport.js';

/**
 * Executor — traduz intent/OMS order → transport; não conhece strategy.
 */

/**
 * @param {object} opts
 * @param {object} opts.oms
 * @param {object} [opts.transport]
 * @param {() => number} [opts.clock]
 */
export function createExecutor(opts) {
  const oms = opts.oms;
  if (!oms) throw new Error('oms obrigatório');
  const transport = opts.transport ?? createSimTransport({ clock: opts.clock });
  const clock = opts.clock ?? (() => Date.now());

  /**
   * @param {import('../engine/schemas.js').TradeIntent} intent
   */
  async function executeIntent(intent) {
    const { order, deduped, request } = oms.registerIntent(intent);

    if (order.state === 'REJECTED') {
      return {
        accepted: false,
        deduped,
        events: [
          {
            eventId: `exec-rej-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'REJECT',
            side: intent.side,
            qty: 0,
            price: null,
            reason: order.reason,
            tsMs: clock(),
          },
        ],
      };
    }

    if (deduped) {
      return { accepted: true, deduped: true, events: [] };
    }

    if (intent.kind === 'CANCEL') {
      const raw = oms.getOrderRaw(intent.intentId);
      const result = await transport.cancel(raw ?? order);
      const events = [];
      for (const ev of result.events ?? []) {
        const applied = oms.applyExchangeEvent(ev);
        events.push(...(applied.executionEvents ?? []));
      }
      return { accepted: result.accepted, deduped: false, events };
    }

    const raw = oms.getOrderRaw(intent.intentId);
    const result = await transport.submit(request, raw);

    if (result.exchangeOrderId) {
      oms.bindExchangeId(intent.intentId, result.exchangeOrderId);
    }

    if (result.lostAck) {
      oms.markUnknown(intent.intentId, 'lost_ack');
      return {
        accepted: true,
        deduped: false,
        events: [
          {
            eventId: `exec-unknown-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'UNKNOWN',
            side: intent.side,
            qty: 0,
            price: null,
            reason: 'lost_ack',
            tsMs: clock(),
          },
        ],
      };
    }

    const events = [];
    for (const ev of result.events ?? []) {
      const applied = oms.applyExchangeEvent(ev);
      events.push(...(applied.executionEvents ?? []));
    }

    return { accepted: result.accepted !== false, deduped: false, events };
  }

  return { transport, executeIntent };
}

export function createTransportForMode(mode, opts = {}) {
  if (opts.transport) return opts.transport;
  if (mode === 'live') {
    if (opts.client && opts.Side && opts.OrderType) {
      return createLiveTransport(opts);
    }
    return createLiveTransportStub();
  }
  if (mode === 'dry-run') {
    return createSimTransport({ ...opts, behavior: opts.behavior ?? 'dry' });
  }
  return createSimTransport(opts);
}
