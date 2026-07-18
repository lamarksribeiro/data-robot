/**
 * Risk mínimo P1: valida intents contra limites locais.
 * Risk completo (geoblock, circuit breakers) = P4.
 */

import { assertTradeIntent } from './schemas.js';

/**
 * @param {object} [opts]
 * @param {number} [opts.maxNotionalPerIntent]
 * @param {boolean} [opts.blockWhenUnhealthy]
 */
export function createBasicRisk(opts = {}) {
  const maxNotional = opts.maxNotionalPerIntent ?? 50;
  const blockWhenUnhealthy = opts.blockWhenUnhealthy !== false;

  return {
    /**
     * @param {import('./schemas.js').TradeIntent} intent
     * @param {{ health?: { ok?: boolean }, mode?: string }} ctx
     */
    evaluate(intent, ctx = {}) {
      assertTradeIntent(intent);

      if (blockWhenUnhealthy && ctx.health && ctx.health.ok === false) {
        return { allow: false, reasonCode: 'HEALTH_BLOCK' };
      }

      if (intent.kind === 'ENTER' || intent.kind === 'REVERSE') {
        const notional =
          intent.budget ??
          (intent.quantity != null && intent.maxPrice != null
            ? intent.quantity * intent.maxPrice
            : null);
        if (notional != null && notional > maxNotional) {
          return { allow: false, reasonCode: 'MAX_NOTIONAL', detail: { notional, maxNotional } };
        }
      }

      return { allow: true, reasonCode: 'OK' };
    },
  };
}
