/**
 * Transport simulado determinístico (sandbox sem dinheiro).
 * Emite ACK + fills (full ou partial) sem exchange id exposto à strategy.
 */

/**
 * @param {object} [opts]
 * @param {'full'|'partial'|'reject'|'ack-only'|'lost-ack'} [opts.behavior]
 * @param {number} [opts.partialRatio] — 0..1 para partial
 * @param {() => number} [opts.clock]
 * @param {() => string} [opts.nextExchangeId]
 */
export function createSimTransport(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  let exSeq = 0;
  const nextExchangeId =
    opts.nextExchangeId ??
    (() => {
      exSeq += 1;
      return `sim-ex-${exSeq}`;
    });
  const behavior = opts.behavior ?? 'full';
  const partialRatio = opts.partialRatio ?? 0.4;
  const log = [];

  return {
    kind: 'sim',
    log,
    /**
     * @param {object} request — materializeOrderRequest
     * @param {object} order — public/raw order CREATED
     */
    async submit(request, order) {
      const tsMs = clock();
      const exchangeOrderId = nextExchangeId();
      log.push({ action: 'submit', intentId: order.intentId, exchangeOrderId, tsMs });

      if (behavior === 'reject') {
        return {
          accepted: false,
          exchangeOrderId: null,
          events: [
            {
              eventId: `sim-rej-${order.intentId}`,
              intentId: order.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: 'sim-reject',
              tsMs,
            },
          ],
        };
      }

      if (behavior === 'dry') {
        return {
          accepted: true,
          exchangeOrderId,
          events: [
            {
              eventId: `sim-ack-${order.intentId}`,
              intentId: order.intentId,
              exchangeOrderId,
              type: 'ACK',
              qty: 0,
              price: null,
              reason: 'dry-run-ack',
              tsMs,
            },
            {
              eventId: `sim-cancel-${order.intentId}`,
              intentId: order.intentId,
              exchangeOrderId,
              type: 'CANCEL',
              qty: 0,
              price: null,
              reason: 'dry-run-no-resting',
              tsMs: tsMs + 1,
            },
          ],
        };
      }

      if (behavior === 'lost-ack') {
        // Aceite local sem evento — OMS deve reconciliar UNKNOWN
        return {
          accepted: true,
          exchangeOrderId,
          events: [],
          lostAck: true,
        };
      }

      const events = [
        {
          eventId: `sim-ack-${order.intentId}`,
          intentId: order.intentId,
          exchangeOrderId,
          type: 'ACK',
          qty: 0,
          price: null,
          reason: 'sim-ack',
          tsMs,
        },
      ];

      if (behavior === 'ack-only') {
        return { accepted: true, exchangeOrderId, events };
      }

      const size = request.size ?? order.qty ?? 1;
      const price = request.price ?? order.price;

      if (behavior === 'partial') {
        const part = Math.max(1, Math.floor(size * partialRatio));
        events.push({
          eventId: `sim-partial-${order.intentId}`,
          intentId: order.intentId,
          exchangeOrderId,
          type: 'PARTIAL',
          qty: part,
          price,
          reason: 'sim-partial',
          tsMs: tsMs + 1,
        });
        events.push({
          eventId: `sim-fill-${order.intentId}`,
          intentId: order.intentId,
          exchangeOrderId,
          type: 'FILL',
          qty: size - part,
          price,
          reason: 'sim-fill-rest',
          tsMs: tsMs + 2,
        });
      } else {
        events.push({
          eventId: `sim-fill-${order.intentId}`,
          intentId: order.intentId,
          exchangeOrderId,
          type: 'FILL',
          qty: size,
          price,
          reason: 'sim-fill',
          tsMs: tsMs + 1,
        });
      }

      return { accepted: true, exchangeOrderId, events };
    },

    async cancel(order) {
      const tsMs = clock();
      return {
        accepted: true,
        events: [
          {
            eventId: `sim-cancel-${order.intentId}`,
            intentId: order.intentId,
            exchangeOrderId: order.exchangeOrderId,
            type: 'CANCEL',
            qty: 0,
            price: null,
            reason: 'sim-cancel',
            tsMs,
          },
        ],
      };
    },
  };
}

/** Live stub — estrutura pronta; rejeita até CLOB user-WS (ainda P3 interface). */
export function createLiveTransportStub() {
  return {
    kind: 'live-stub',
    async submit(_request, order) {
      return {
        accepted: false,
        exchangeOrderId: null,
        events: [
          {
            eventId: `live-stub-${order.intentId}`,
            intentId: order.intentId,
            type: 'REJECT',
            qty: 0,
            price: null,
            reason: 'LIVE_CLOB_TRANSPORT_PENDING',
            tsMs: Date.now(),
          },
        ],
      };
    },
    async cancel(order) {
      return {
        accepted: false,
        events: [
          {
            eventId: `live-stub-cancel-${order.intentId}`,
            intentId: order.intentId,
            type: 'REJECT',
            qty: 0,
            price: null,
            reason: 'LIVE_CLOB_TRANSPORT_PENDING',
            tsMs: Date.now(),
          },
        ],
      };
    },
  };
}
