/**
 * Presets default por strategyId (composition — pode importar tfc/strategy).
 */

import { TFC_V7 } from '../tfc/preset-v7.js';
import { TFC_V7_STRATEGY_ID } from '../strategy/tfcV7.js';

/**
 * @param {string} strategyId
 * @param {object} [override]
 */
export function defaultPresetFor(strategyId, override = {}) {
  const clean = Object.fromEntries(
    Object.entries(override).filter(([, v]) => v !== undefined),
  );
  if (strategyId === TFC_V7_STRATEGY_ID) {
    return { ...TFC_V7, ...clean };
  }
  if (strategyId === 'fixture-spread-wide') {
    return { minSpread: 0.01, quantity: 3, budget: 1, ...clean };
  }
  if (strategyId === 'fixture-price-cross') {
    return { threshold: 1, budget: 1, maxPrice: 0.5, ...clean };
  }
  return { ...clean };
}
