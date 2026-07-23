/** Parâmetros do preset campeão TFC V7 Danger Floor (data-backtest). */
export const TFC_V7 = {
  walletSize: 100,
  entryBudget: 10,
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
  minLiquidityRatio: 0.60,
  minShares: 1,
};

/** Budget mínimo para micro-testes reais (centavos). */
export const MICRO_TEST = {
  entryBudget: 0.10,
  minShares: 1,
  entryOrderType: 'FAK',
  exitOrderType: 'FAK',
};

/**
 * Cap de canário P7 — independente do entryBudget=$10 do preset campeão.
 * Preferência de sizing continua MICRO_TEST ($0.10), mas BUY marketable
 * exige >=$1 notional (CLOB); com ask < 1 isso pode ser 2 shares (~$1.5–2).
 */
export const CANARY_LIMITS = Object.freeze({
  maxCanaryBudget: 2.0,
  preferredEntryBudget: 0.1,
  maxSlippage: 0.02,
});

/** Preset efetivo para micro-live (gates V7 + sizing canário). */
export function canaryPreset(override = {}) {
  return { ...TFC_V7, ...MICRO_TEST, ...override };
}
