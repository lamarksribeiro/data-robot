/**
 * Sizing canário para BUY marketable (FAK/FOK).
 * Polymarket exige notional ≥ $1 em BUY marketable.
 */

export const MARKETABLE_BUY_MIN_NOTIONAL = 1;

/**
 * @param {object} opts
 * @param {number} opts.ask
 * @param {number} opts.maxPrice
 * @param {number} opts.entryBudget
 * @param {number} [opts.minShares]
 * @param {number} [opts.minNotional]
 * @returns {{ quantity: number, notional: number, maxPrice: number }}
 */
export function sizeCanaryBuy(opts) {
  const maxPrice = Number(opts.maxPrice);
  const ask = Number(opts.ask);
  const entryBudget = Number(opts.entryBudget);
  const minShares = Math.max(1, Number(opts.minShares ?? 1) || 1);
  const minNotional = Number(opts.minNotional ?? MARKETABLE_BUY_MIN_NOTIONAL);

  let quantity = Math.max(
    minShares,
    Number.isFinite(entryBudget) && ask > 0 ? Math.floor(entryBudget / ask) : 0,
  );

  if (Number.isFinite(maxPrice) && maxPrice > 0 && Number.isFinite(minNotional) && minNotional > 0) {
    quantity = Math.max(quantity, Math.ceil(minNotional / maxPrice - 1e-12));
  }

  return {
    quantity,
    notional: quantity * maxPrice,
    maxPrice,
  };
}
