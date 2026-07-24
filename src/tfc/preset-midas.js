/**
 * Presets MIDAS Carry V1 — paridade com data-backtest labs/terminal/midas-carry-v1.
 * Defaults do lab + overrides champion/robust/aggressive.
 *
 * Runtime data-robot (midasV1.js + evaluate.js) consome o núcleo TFC + tier/budget.
 * Flags de lab (sigma/scoop/earlyWarn/dangerContinuous/equityScale) ficam no preset
 * para paridade e edição futura; o plugin atual não implementa esses ramos (default off).
 */

import { CANARY_LIMITS as TFC_CANARY_LIMITS, MICRO_TEST } from './preset-v7.js';

/** Defaults completos do lab midas-carry-v1/defaults.json */
export const MIDAS_LAB_DEFAULTS = Object.freeze({
  walletSize: 100,
  entryBudget: 10,
  minShares: 1,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.6,
  minSecondsLeft: 5,
  maxSecondsLeft: 30,
  maxDistAbs: 20,
  minAsk: 0.55,
  maxAsk: 0.82,
  maxSpread: 0.03,
  minOddsSum: 0.98,
  maxOddsSum: 1.06,
  minFlips: 0,
  flipWindowSecs: 60,
  velocityLookbackSecs: 5,
  maxAdverseSpotChange: 8.0,
  minObi: 0.0,
  obiLevels: 5,
  // sigma sizing (lab; não wired no plugin robot)
  sigmaSizingEnabled: false,
  sigmaLookbackSecs: 90,
  sigmaDivisor: 5.48,
  zT1: 0.5,
  zT2: 1.0,
  zT3: 2.5,
  zT4: 4.0,
  wZ0: 0.4,
  wZ1: 0.7,
  wZ2: 1.0,
  wZ3: 1.4,
  wZ4: 1.8,
  // scoop (lab; não wired)
  scoopEnabled: false,
  scoopMinZ: 1.5,
  scoopMinAsk: 0.1,
  scoopMaxAsk: 0.55,
  scoopMaxSpread: 0.05,
  scoopMaxDistAbs: 80,
  scoopMinSecondsLeft: 5,
  scoopMaxSecondsLeft: 30,
  scoopBudgetFactor: 1.0,
  scoopMinOddsSum: 0.9,
  scoopMaxOddsSum: 1.1,
  // exits
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
  dangerExitEnabled: true,
  dangerExitK: 0.3,
  dangerExitFloorSec: 4,
  dangerContinuousEnabled: false,
  dangerContinuousStartSec: 8,
  dangerContinuousMinZ: 0.25,
  earlyWarnEnabled: false,
  earlyWarnOppAsk: 0.45,
  earlyWarnStartSec: 20,
  earlyWarnEndSec: 8,
  earlyWarnOnlyIfLosing: true,
  // midas envelope
  minEntryZ: 0.0,
  tierAskThreshold: 0.82,
  tierAskBudgetFactor: 1.0,
  equityScaleEnabled: false,
  equityScalePct: 0.1,
  maxEntryBudget: 30,
  hedgeStopEnabled: false,
  hedgeLimitEnabled: false,
  entryMakerEnabled: false,
});

/**
 * Champion lab btc-champion-v1 (tier 1.5x, dist 40, ask 0.94).
 * = defaults + overrides do preset champion.
 */
export const MIDAS_V1 = {
  ...MIDAS_LAB_DEFAULTS,
  maxDistAbs: 40,
  minAsk: 0.55,
  maxAsk: 0.94,
  tierAskThreshold: 0.82,
  tierAskBudgetFactor: 1.5,
  maxEntryBudget: 30,
};

/** Espelho btc-robust-v1 (champion + maxDistAbs 30). */
export const MIDAS_ROBUST_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 30,
};

/** Espelho btc-aggressive-v1 (dist 40, tier 2.0x). */
export const MIDAS_AGGRESSIVE_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 40,
  tierAskBudgetFactor: 2.0,
};

/** Sizing micro canário. */
export const MICRO_AGGRESSIVE = Object.freeze({
  entryBudget: 2,
  maxEntryBudget: 4,
  minShares: 1,
  entryOrderType: 'FAK',
  exitOrderType: 'FAK',
});

/** @deprecated Prefer MICRO_AGGRESSIVE */
export const MICRO_ROBUST = Object.freeze({
  entryBudget: 2,
  maxEntryBudget: 3,
  minShares: 1,
  entryOrderType: 'FAK',
  exitOrderType: 'FAK',
});

export const CANARY_LIMITS = Object.freeze({
  maxCanaryBudget: MICRO_AGGRESSIVE.maxEntryBudget,
  preferredEntryBudget: MICRO_AGGRESSIVE.entryBudget,
  maxSlippage: TFC_CANARY_LIMITS.maxSlippage,
});

export { MICRO_TEST };

/**
 * Params que o runtime data-robot realmente lê (evaluate + midasV1).
 * O resto é paridade de lab / futuro.
 */
export const MIDAS_RUNTIME_KEYS = Object.freeze([
  'walletSize',
  'entryBudget',
  'maxEntryBudget',
  'minShares',
  'entrySlippageMax',
  'minLiquidityRatio',
  'entryOrderType',
  'exitOrderType',
  'minSecondsLeft',
  'maxSecondsLeft',
  'maxDistAbs',
  'minAsk',
  'maxAsk',
  'maxSpread',
  'minOddsSum',
  'maxOddsSum',
  'minFlips',
  'flipWindowSecs',
  'velocityLookbackSecs',
  'maxAdverseSpotChange',
  'minObi',
  'obiLevels',
  'stopMinBid',
  'lateFlipExitEnabled',
  'lateFlipExitSec',
  'lateFlipExitCrossDist',
  'lateFlipMinSec',
  'lateFlipReverseEnabled',
  'lateFlipReverseMaxAsk',
  'lateFlipReverseMinAsk',
  'lateFlipReverseBudgetFactor',
  'dangerExitEnabled',
  'dangerExitK',
  'dangerExitFloorSec',
  'tierAskThreshold',
  'tierAskBudgetFactor',
]);

/** Keys de lab presentes no preset mas sem ramo no plugin robot. */
export const MIDAS_LAB_ONLY_KEYS = Object.freeze(
  Object.keys(MIDAS_LAB_DEFAULTS).filter((k) => !MIDAS_RUNTIME_KEYS.includes(k)),
);

/**
 * Budget efetivo de entrada (tier quando ask >= threshold).
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
