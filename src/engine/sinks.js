/**
 * Execution sinks — mesmo pipeline; só o destino muda.
 * dry-run: registra intents sem fill
 * shadow: simula fill total determinístico
 * live: stub até P3 (OMS/CLOB)
 */

/**
 * @typedef {object} SinkResult
 * @property {boolean} accepted
 * @property {import('./schemas.js').ExecutionEvent[]} events
 */

export function createDryRunSink() {
  const log = [];
  return {
    mode: 'dry-run',
    log,
    /**
     * @param {import('./schemas.js').TradeIntent} intent
     * @returns {Promise<SinkResult>}
     */
    async submit(intent) {
      log.push({ tsMs: Date.now(), intent });
      return {
        accepted: true,
        events: [
          {
            eventId: `dry-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'ACK',
            side: intent.side,
            qty: 0,
            price: null,
            reason: 'dry-run',
            tsMs: Date.now(),
          },
        ],
      };
    },
  };
}

/**
 * @param {{ fillQty?: (intent: object) => number, fillPrice?: (intent: object) => number|null }} [opts]
 */
export function createShadowSink(opts = {}) {
  const log = [];
  const fillQty =
    opts.fillQty ??
    ((intent) => {
      if (intent.quantity != null) return intent.quantity;
      if (intent.budget != null && intent.maxPrice != null && intent.maxPrice > 0) {
        return Math.max(1, Math.floor(intent.budget / intent.maxPrice));
      }
      return 1;
    });
  const fillPrice = opts.fillPrice ?? ((intent) => intent.maxPrice ?? intent.minPrice ?? null);

  return {
    mode: 'shadow',
    log,
    async submit(intent) {
      log.push({ tsMs: Date.now(), intent });

      if (intent.kind === 'CANCEL') {
        return {
          accepted: true,
          events: [
            {
              eventId: `shadow-cancel-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'CANCEL',
              side: intent.side,
              qty: 0,
              price: null,
              reason: 'shadow-cancel',
              tsMs: Date.now(),
            },
          ],
        };
      }

      const qty = fillQty(intent);
      const price = fillPrice(intent);
      const tsMs = Date.now();

      return {
        accepted: true,
        events: [
          {
            eventId: `shadow-ack-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'ACK',
            side: intent.side,
            qty: 0,
            price: null,
            reason: 'shadow-ack',
            tsMs,
          },
          {
            eventId: `shadow-fill-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'FILL',
            side: intent.side,
            qty,
            price,
            reason: 'shadow-fill',
            tsMs: tsMs + 1,
          },
        ],
      };
    },
  };
}

/** Stub live até P3 — não chama CLOB. */
export function createLiveStubSink() {
  return {
    mode: 'live',
    async submit(intent) {
      return {
        accepted: false,
        events: [
          {
            eventId: `live-stub-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'REJECT',
            side: intent.side,
            qty: 0,
            price: null,
            reason: 'LIVE_SINK_NOT_IMPLEMENTED_P3',
            tsMs: Date.now(),
          },
        ],
      };
    },
  };
}

/**
 * @param {'dry-run'|'shadow'|'live'} mode
 */
export function createSinkForMode(mode) {
  if (mode === 'dry-run') return createDryRunSink();
  if (mode === 'shadow') return createShadowSink();
  if (mode === 'live') return createLiveStubSink();
  throw new Error(`mode inválido: ${mode}`);
}
