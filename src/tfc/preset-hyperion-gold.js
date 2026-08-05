/**
 * Preset e constantes da nova estratégia Hyperion Gold V1 (hyperion-gold-v1).
 * Unifica o Binance Lead-Lag, MIDAS High-Ask Carry Envelope e a gestão de inventário E-Gold.
 */

export const HYPERION_GOLD_V1 = Object.freeze({
  // Identificação
  strategyId: 'hyperion-gold-v1',
  presetId: 'btc-hyperion-gold-v1',

  // Envelope High-Ask (MIDAS Fee Optimization: 0.82–0.94)
  minAsk: 0.82,
  maxAsk: 0.94,
  maxDistAbs: 40,
  minNotional: 2.0,

  // Binance Lead-Lag Gate (Sniper de Latência < 50ms)
  binanceLeadEnabled: true,
  binanceLeadMinDeltaUsd: 15.0, // Variação mínima de $15 no spot Binance em 1.5s
  binanceLeadLookbackMs: 1500,

  // Janela Tática de Entrada (últimos 30s até 9s)
  maxSecondsLeft: 30,
  minSecondsLeft: 9,

  // Budget & Size (E-Gold Tiering)
  entryBudget: 10.0,
  maxEntryBudget: 30.0,
  tierAskThreshold: 0.82,
  tierAskBudgetFactor: 1.5,

  // Ordens de Execução
  entryOrderType: 'FAK', // Entrada rápida Fill-and-Kill
  exitOrderType: 'GTC',  // Saída garantida com retry

  // Proteções de Saída (Odds Shock & Danger Exit)
  oddsShockEnabled: true,
  oddsShockDeltaMin: 0.15,
  oddsShockLookbackSec: 2,
  oddsShockMinOppAsk: 0.50,
  oddsShockMinEntryAskRatio: 0.55,
  oddsShockFraction: 0.50, // Vende 50% em choque

  dangerExitEnabled: true,
  dangerExitFloorSec: 4,
  stopMinBid: 0.05,
  entrySlippageMax: 0.02,
});

export function resolveHyperionEntryBudget(ask, params = HYPERION_GOLD_V1) {
  const baseBudget = Number(params.entryBudget ?? 10.0);
  const maxBudget = Number(params.maxEntryBudget ?? 30.0);
  const threshold = Number(params.tierAskThreshold ?? 0.82);
  const factor = Number(params.tierAskBudgetFactor ?? 1.5);

  if (ask >= threshold) {
    return Math.min(maxBudget, baseBudget * factor);
  }
  return baseBudget;
}
