/**
 * Presets MIDAS Carry V1 (data-backtest lab midas-carry-v1).
 * Canário P9: Aggressive (dist 40, tier 2.0x) + sizing micro $2/$4.
 */

import { CANARY_LIMITS as TFC_CANARY_LIMITS, MICRO_TEST } from './preset-v7.js';

/** Params espelhados de labs/.../midas-carry-v1/presets/btc-champion-v1.json */
export const MIDAS_V1 = {
  walletSize: 100,
  entryBudget: 10,
  minSecondsLeft: 5,
  maxSecondsLeft: 30,
  maxDistAbs: 40,
  minAsk: 0.55,
  maxAsk: 0.94,
  maxSpread: 0.03,
  minOddsSum: 0.98,
  maxOddsSum: 1.06,
  minFlips: 0,
  flipWindowSecs: 60,
  stopIfCrossed: false,
  stopCrossDist: 0,
  stopMinBid: 0.05,
  lateFlipExitEnabled: true,
  lateFlipExitSec: 8,
  lateFlipExitCrossDist: 0,
  lateFlipMinSec: 4,
  lateFlipReverseEnabled: true,
  lateFlipReverseMaxAsk: 0.95,
  lateFlipReverseMinAsk: 0.0,
  lateFlipReverseBudgetFactor: 1.0,
  velocityLookbackSecs: 5,
  maxAdverseSpotChange: 8.0,
  minObi: 0.0,
  obiLevels: 5,
  dangerExitEnabled: true,
  dangerExitK: 0.3,
  dangerExitFloorSec: 4,
  hedgeStopEnabled: false,
  hedgeLimitEnabled: false,
  entryMakerEnabled: false,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.6,
  minShares: 1,
  // MIDAS-only
  tierAskThreshold: 0.82,
  tierAskBudgetFactor: 1.5,
  maxEntryBudget: 30,
  minEntryZ: 0.0,
  sigmaSizingEnabled: false,
  scoopEnabled: false,
  dangerContinuousEnabled: false,
  earlyWarnEnabled: false,
};

/** Espelho de labs/.../presets/btc-robust-v1.json (champion + maxDistAbs 30). */
export const MIDAS_ROBUST_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 30,
};

/** Espelho de labs/.../presets/btc-aggressive-v1.json (dist 40, tier 2.0x). */
export const MIDAS_AGGRESSIVE_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 40,
  tierAskBudgetFactor: 2.0,
};

/**
 * Sizing micro para Aggressive: entry $2 / tier 2.0× teto $4.
 * Wallet ~$34 aguenta com folga (cap ~12%).
 */
export const MICRO_AGGRESSIVE = Object.freeze({
  entryBudget: 2,
  maxEntryBudget: 4,
  minShares: 1,
  entryOrderType: 'FAK',
  exitOrderType: 'FAK',
});

/** @deprecated Prefer MICRO_AGGRESSIVE — mantido para testes/docs legados. */
export const MICRO_ROBUST = Object.freeze({
  entryBudget: 2,
  maxEntryBudget: 3,
  minShares: 1,
  entryOrderType: 'FAK',
  exitOrderType: 'FAK',
});

/**
 * Cap de canário MIDAS — alinhado a maxEntryBudget do micro aggressive.
 */
export const CANARY_LIMITS = Object.freeze({
  maxCanaryBudget: MICRO_AGGRESSIVE.maxEntryBudget,
  preferredEntryBudget: MICRO_AGGRESSIVE.entryBudget,
  maxSlippage: TFC_CANARY_LIMITS.maxSlippage,
});

export { MICRO_TEST };

/**
 * Budget efetivo de entrada (tier quando ask >= threshold).
 * @param {object} params
 * @param {number} ask
 */
export function resolveMidasEntryBudget(params, ask) {
  const base = Number(params.entryBudget);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const threshold = Number(params.tierAskThreshold ?? Infinity);
  const factor = Number(params.tierAskBudgetFactor ?? 1);
  const askN = Number(ask);
  let budget = base;
  if (Number.isFinite(askN) && Number.isFinite(threshold) && askN >= threshold) {
    budget = base * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  }
  const cap = Number(params.maxEntryBudget);
  if (Number.isFinite(cap) && cap > 0) budget = Math.min(budget, cap);
  return budget;
}

/** Preset efetivo para canário MIDAS (Aggressive + sizing micro $2/$4). */
export function canaryMidasPreset(override = {}) {
  return { ...MIDAS_AGGRESSIVE_V1, ...MICRO_AGGRESSIVE, ...override };
}
