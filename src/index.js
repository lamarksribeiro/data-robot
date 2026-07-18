/**
 * Entry point da biblioteca (não é o processo de produção long-lived).
 * Composition root: src/composition/bootstrap.js
 */

export { default as config } from './config.js';
export { evaluateEntryGates, evaluateLateFlip, favoriteSide } from './tfc/evaluate.js';
export { TFC_V7, MICRO_TEST } from './tfc/preset-v7.js';
export { TFC_V6_HYBRID } from './tfc/preset-v6-hybrid.js';
export { calculateTakerFee, summarizeTradeFees } from './fees/polymarketFee.js';
export { RUN_SCHEMA_VERSION, sanitizeRunRecord } from './runs/schema.js';

export {
  ENGINE_STATES,
  INTENT_KINDS,
  EXECUTION_MODES,
  assertMarketSnapshot,
  assertTradeIntent,
  emptyPosition,
  makeIntentId,
} from './engine/schemas.js';
export { StrategyRegistry } from './engine/registry.js';
export { createEngine } from './engine/runtime.js';
export { createSinkForMode, createDryRunSink, createShadowSink } from './engine/sinks.js';
export { createBasicRisk } from './engine/risk.js';
export { bootstrapEngine, createDefaultRegistry } from './composition/bootstrap.js';
export { runConformanceSuite } from './strategy/conformance.js';
