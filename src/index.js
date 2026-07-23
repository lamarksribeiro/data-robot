/**
 * Entry point da biblioteca (não é o processo de produção long-lived).
 * Composition root: src/composition/bootstrap.js
 */

export { default as config } from './config.js';
export {
  evaluateEntryGates,
  evaluateLateFlip,
  evaluateLateFlipAction,
  evaluateDangerExit,
  favoriteSide,
  oppositeSide,
  signedDistance,
  spotVolatility,
  orderBookImbalance,
} from './tfc/evaluate.js';
export { TFC_V7, MICRO_TEST, CANARY_LIMITS, canaryPreset } from './tfc/preset-v7.js';
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
export { bootstrapEngine, createDefaultRegistry } from './composition/bootstrap.js';
export { runConformanceSuite } from './strategy/conformance.js';

export {
  STALENESS,
  BTC5M_STALENESS,
  evaluateFeedHealth,
  evaluateClockSkew,
} from './market/health.js';
export { runLivePreflight, preflightChecksFromResult } from './risk/livePreflight.js';
export { buildMarketSnapshot, marketIdFromEvent } from './market/normalize.js';
export { evaluateSnapshotEligibility } from './market/eligibility.js';
export {
  filterSnapshotForCapabilities,
  assertCapabilitiesHonored,
} from './market/capabilities.js';
export { createMarketHub } from './market/hub.js';
export {
  createSnapshotSource,
  createFixtureSnapshotSource,
  createBtc5mSnapshotSource,
} from './market/snapshotSources.js';
export {
  canonicalize,
  createReplayRecorder,
  loadReplayJsonl,
  assertReplayDeterministic,
  replaySnapshots,
} from './market/replay.js';

export { createOms } from './oms/createOms.js';
export { createOmsSink } from './oms/omsSink.js';
export { createReconciler } from './oms/reconciler.js';
export { ORDER_STATES, isTerminal } from './oms/states.js';
export { createExecutor, createTransportForMode } from './executor/createExecutor.js';
export { createSimTransport, createLiveTransportStub } from './executor/transport.js';
export { createUserChannel } from './executor/userChannel.js';

export { createRiskEngine, createBasicRisk } from './risk/createRiskEngine.js';
export { createAccountRiskBook } from './risk/accountBook.js';
export { createPreflight } from './risk/preflight.js';
export { createKillSwitch } from './risk/killSwitch.js';
export { RISK_REASON } from './risk/reasons.js';

export { createMetrics } from './observability/metrics.js';
export { createLogger } from './observability/logger.js';
export { createAlertHub } from './observability/alerts.js';
export { evaluateSlos, DEFAULT_SLOS } from './observability/slo.js';
export { createJournalBackup } from './observability/journalBackup.js';
export { buildHealthReport } from './control/health.js';
export { createControlServer } from './control/httpServer.js';
export { createEngineApp } from './control/engineApp.js';
export { runSoak } from './control/soak.js';

export {
  createTfcV7Strategy,
  TFC_V7_STRATEGY_ID,
  TFC_V7_PRESET_ID,
  mergeTfcV7Preset,
} from './strategy/tfcV7.js';
export {
  createMidasV1Strategy,
  MIDAS_V1_STRATEGY_ID,
  MIDAS_V1_PRESET_ID,
  mergeMidasV1Preset,
} from './strategy/midasV1.js';
export {
  MIDAS_V1,
  MIDAS_ROBUST_V1,
  MICRO_ROBUST,
  CANARY_LIMITS as MIDAS_CANARY_LIMITS,
  canaryMidasPreset,
  resolveMidasEntryBudget,
} from './tfc/preset-midas.js';
export { defaultPresetFor } from './composition/presets.js';
export { bootstrapTfcCanaryEngine } from './composition/tfcCanary.js';
export { bootstrapMidasCanaryEngine } from './composition/midasCanary.js';
export { createLiveTransport, createMockClobClient } from './executor/liveTransport.js';
export { buildMicroLiveReport, compareIntentParity } from './oms/microLiveReport.js';
