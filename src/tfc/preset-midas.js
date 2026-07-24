/**
 * Presets MIDAS Carry V1 — params lidos pelo runtime data-robot
 * (midasV1.js + evaluate.js + sizeCanaryBuy / resolveMidasEntryBudget).
 *
 * Paridade lab midas-carry-v1 (strategy.gls), sem walletSize de simulação.
 * Mecanismos de lab ficam presentes com defaults OFF (champion), para ligar
 * via preset/UI sem código morto.
 */

import { CANARY_LIMITS as TFC_CANARY_LIMITS, MICRO_TEST } from './preset-v7.js';
import { sigmaBudgetFactor } from './evaluate.js';

/** Núcleo operacional MIDAS (champion lab: dist 40, ask 0.94, tier 1.5×). */
export const MIDAS_V1 = {
  // sizing
  entryBudget: 10,
  maxEntryBudget: 30,
  minShares: 1,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.6,
  entryOrderType: 'GTC',
  exitOrderType: 'GTC',
  // entry gates
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
  velocityLookbackSecs: 5,
  maxAdverseSpotChange: 8.0,
  minObi: 0.0,
  obiLevels: 5,
  // z-score físico (sigma lookback) + gate de entrada
  sigmaLookbackSecs: 90,
  sigmaDivisor: 5.48,
  minEntryZ: 0.0,
  // sigma sizing (OFF no champion lab)
  sigmaSizingEnabled: false,
  zT1: 0.5,
  zT2: 1.0,
  zT3: 2.5,
  zT4: 4.0,
  wZ0: 0.4,
  wZ1: 0.7,
  wZ2: 1.0,
  wZ3: 1.4,
  wZ4: 1.8,
  // scoop — favorito barato / z alto (OFF no champion)
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
  // exits / reverse
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
  // danger contínuo z-based (OFF no champion)
  dangerContinuousEnabled: false,
  dangerContinuousStartSec: 8,
  dangerContinuousMinZ: 0.25,
  // early-warn (OFF no champion)
  earlyWarnEnabled: false,
  earlyWarnOppAsk: 0.45,
  earlyWarnStartSec: 20,
  earlyWarnEndSec: 8,
  earlyWarnOnlyIfLosing: true,
  // midas tier
  tierAskThreshold: 0.82,
  tierAskBudgetFactor: 1.5,
  // equity scale — usa accountEquityUsd real (sem walletSize fake)
  equityScaleEnabled: false,
  equityScalePct: 0.1,
};

/** Robust: dist 30. */
export const MIDAS_ROBUST_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 30,
};

/** Aggressive: tier 2.0×. */
export const MIDAS_AGGRESSIVE_V1 = {
  ...MIDAS_V1,
  maxDistAbs: 40,
  tierAskBudgetFactor: 2.0,
};

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

/** Keys do runtime MIDAS (UI + validação). */
export const MIDAS_RUNTIME_KEYS = Object.freeze(Object.keys(MIDAS_V1));

/**
 * Equity operacional sem walletSize de lab.
 * Preferência: accountEquityUsd (saldo real). Fallback: entryBudget + realizedPnl.
 * @param {object} params
 * @param {{ accountEquityUsd?: number|null, realizedPnl?: number|null }} [opts]
 */
export function resolveMidasEquityUsd(params, opts = {}) {
  // null/undefined ≠ 0: Number(null) === 0 e caparia o budget por engano.
  if (opts.accountEquityUsd != null && Number.isFinite(Number(opts.accountEquityUsd))) {
    const acct = Number(opts.accountEquityUsd);
    if (acct >= 0) return acct;
  }
  const base = Number(params.entryBudget);
  const realized = Number(opts.realizedPnl);
  if (Number.isFinite(base) && base >= 0) {
    return Math.max(0, base + (Number.isFinite(realized) ? realized : 0));
  }
  return null;
}

/**
 * Budget bruto antes de sigma/tier (equity scale opcional).
 * Paridade GLS: equityRawBudget = max(entryBudget, equity * pct) se scale on.
 */
export function resolveMidasEquityRawBudget(params, opts = {}) {
  const base = Number(params.entryBudget);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const scaleOn = params.equityScaleEnabled === true || params.equityScaleEnabled === 1;
  if (!scaleOn) return base;
  const equity = resolveMidasEquityUsd(params, opts);
  const pct = Number(params.equityScalePct ?? 0.1);
  if (!(Number.isFinite(equity) && equity >= 0) || !(Number.isFinite(pct) && pct > 0)) {
    return base;
  }
  return Math.max(base, equity * pct);
}

/**
 * Budget efetivo de entrada core:
 * equityRaw × sigmaFactor × tierFactor, capped por maxEntryBudget (e equity se real).
 *
 * @param {object} params
 * @param {number} ask
 * @param {{ z?: number, accountEquityUsd?: number|null, realizedPnl?: number|null }} [opts]
 */
export function resolveMidasEntryBudget(params, ask, opts = {}) {
  const raw = resolveMidasEquityRawBudget(params, opts);
  if (!(raw > 0)) return 0;

  let factor = 1;
  const z = Number(opts.z);
  if (Number.isFinite(z)) {
    factor *= sigmaBudgetFactor(z, params);
  }

  const threshold = Number(params.tierAskThreshold ?? Infinity);
  const tierFactor = Number(params.tierAskBudgetFactor ?? 1);
  const askN = Number(ask);
  if (Number.isFinite(askN) && Number.isFinite(threshold) && askN >= threshold) {
    factor *= Number.isFinite(tierFactor) && tierFactor > 0 ? tierFactor : 1;
  }

  let budget = raw * factor;
  const cap = Number(params.maxEntryBudget);
  if (Number.isFinite(cap) && cap > 0) budget = Math.min(budget, cap);

  // Cap por equity só com saldo de conta real (não com fallback entryBudget+pnl).
  if (opts.accountEquityUsd != null && Number.isFinite(Number(opts.accountEquityUsd))) {
    const acct = Number(opts.accountEquityUsd);
    if (acct >= 0) budget = Math.min(budget, acct);
  }

  return budget;
}

/**
 * Budget scoop (equityRaw × scoopBudgetFactor, caps iguais ao core).
 * @param {object} params
 * @param {{ accountEquityUsd?: number|null, realizedPnl?: number|null }} [opts]
 */
export function resolveMidasScoopBudget(params, opts = {}) {
  const raw = resolveMidasEquityRawBudget(params, opts);
  if (!(raw > 0)) return 0;
  const scoopFactor = Number(params.scoopBudgetFactor ?? 1);
  let budget = raw * (Number.isFinite(scoopFactor) && scoopFactor > 0 ? scoopFactor : 1);
  const cap = Number(params.maxEntryBudget);
  if (Number.isFinite(cap) && cap > 0) budget = Math.min(budget, cap);
  if (opts.accountEquityUsd != null && Number.isFinite(Number(opts.accountEquityUsd))) {
    const acct = Number(opts.accountEquityUsd);
    if (acct >= 0) budget = Math.min(budget, acct);
  }
  return budget;
}

/** Canário MIDAS: Aggressive + sizing micro $2/$4. */
export function canaryMidasPreset(override = {}) {
  return { ...MIDAS_AGGRESSIVE_V1, ...MICRO_AGGRESSIVE, ...override };
}
