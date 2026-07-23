#!/usr/bin/env node
/**
 * Processo da engine (separado da UI sirv :3200).
 * Default: shadow + fixture-price-cross, control HTTP :3201.
 *
 *   npm run engine:serve
 *   ENGINE_PORT=3201 npm run engine:serve
 *
 * Não envia ordens reais (live stub / shadow only unless ENGINE_MODE=live + ENGINE_LIVE_ENABLED=1).
 */

import 'dotenv/config';
import path from 'node:path';
import { createEngineApp } from '../src/control/engineApp.js';
import { createSnapshotSource } from '../src/market/snapshotSources.js';
import { createDefaultRegistry } from '../src/composition/bootstrap.js';
import { prepareMidasCanaryRuntime, MIDAS_CANARY_HARD_CAP_USD } from '../src/composition/midasService.js';
import { createApprovalStore } from '../src/catalog/approvalStore.js';
import { canaryMidasPreset } from '../src/tfc/preset-midas.js';
import { MIDAS_V1_PRESET_ID, MIDAS_V1_STRATEGY_ID } from '../src/strategy/midasV1.js';

const mode = process.env.ENGINE_MODE || 'shadow';
const liveEnabled = process.env.ENGINE_LIVE_ENABLED === '1';
const host = process.env.ENGINE_HOST || '0.0.0.0';
const opsToken = process.env.ENGINE_OPS_TOKEN;
const sourceKind = process.env.ENGINE_SNAPSHOT_SOURCE || 'fixture';
const strategyId = process.env.ENGINE_STRATEGY_ID || 'fixture-price-cross';
const strategyInstanceId =
  process.env.ENGINE_STRATEGY_INSTANCE_ID || `${strategyId}:primary`;
const stateDir = process.env.ENGINE_STATE_DIR || 'runs';
const catalogStore = createApprovalStore({
  file: process.env.STRATEGY_CATALOG_PATH || path.join('config', 'strategy-catalog.json'),
});

if (mode === 'live' && !liveEnabled) {
  console.error('[engine:serve] Recusa: ENGINE_MODE=live exige ENGINE_LIVE_ENABLED=1');
  process.exit(2);
}

if (mode === 'live' && sourceKind !== 'btc5m') {
  console.error('[engine:serve] Recusa: ENGINE_MODE=live exige ENGINE_SNAPSHOT_SOURCE=btc5m');
  process.exit(2);
}

if (mode === 'live' && strategyId !== MIDAS_V1_STRATEGY_ID) {
  console.error('[engine:serve] Recusa: este deployment P9 live aprova somente midas-carry-v1');
  process.exit(2);
}

if (mode === 'live' && process.env.ENGINE_CANARY_MODE !== '1') {
  console.error('[engine:serve] Recusa: live exige ENGINE_CANARY_MODE=1');
  process.exit(2);
}

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !opsToken) {
  console.error('[engine:serve] Recusa: ENGINE_OPS_TOKEN é obrigatório fora de localhost');
  process.exit(2);
}

let snapshotSource;
try {
  snapshotSource = createSnapshotSource(sourceKind, {
    intervalMs: Number(process.env.ENGINE_SOURCE_INTERVAL_MS || 1000),
    syncIntervalMs: Number(process.env.ENGINE_MARKET_SYNC_MS || 15_000),
    retryMs: Number(process.env.ENGINE_SOURCE_RETRY_MS || 2000),
  });
} catch (error) {
  console.error(`[engine:serve] ${error.message}`);
  process.exit(2);
}

const registry = createDefaultRegistry();
const catalog = catalogStore.load();
const manifest = registry.resolve(strategyId).manifest;
const presetId = manifest.presetId ?? strategyId;
const marketScope = sourceKind === 'btc5m' ? 'btc-updown-5m' : 'fixture';
let catalogEntry;
try {
  catalogEntry = catalogStore.assertApproved({
    strategyId,
    version: manifest.version,
    presetId,
    marketScope,
    mode,
  });
} catch (error) {
  console.error(`[engine:serve] Recusa catálogo: ${error.message}`);
  process.exit(2);
}

let runtime = null;
let preset;
let riskOpts;
if (strategyId === MIDAS_V1_STRATEGY_ID) {
  if (sourceKind !== 'btc5m') {
    console.error('[engine:serve] Recusa: MIDAS P9 exige ENGINE_SNAPSHOT_SOURCE=btc5m');
    process.exit(2);
  }
  preset = canaryMidasPreset({ lateFlipReverseEnabled: false });
  const maxCanaryBudget = Number(
    process.env.ENGINE_CANARY_MAX_BUDGET || MIDAS_CANARY_HARD_CAP_USD,
  );
  const controlWindowMs = Number(
    process.env.ENGINE_CONTROL_WINDOW_MS || 24 * 60 * 60 * 1000,
  );
  if (mode === 'live') {
    try {
      runtime = await prepareMidasCanaryRuntime({
        maxCanaryBudget,
        maxEntriesPerControlWindow: 1,
        controlWindowMs,
      });
      preset = runtime.preset;
      riskOpts = runtime.riskOpts;
    } catch (error) {
      console.error(`[engine:serve] Recusa preflight: ${error.message}`);
      process.exit(2);
    }
  } else {
    riskOpts = {
      canaryMode: true,
      maxCanaryBudget,
      maxNotionalPerOrder: maxCanaryBudget,
      maxNotionalPerEvent: maxCanaryBudget,
      maxEntriesPerControlWindow: 1,
      controlWindowMs,
      allowLiveReverse: false,
    };
  }
}

const deployment = {
  sourceCommit: process.env.SOURCE_COMMIT || process.env.ENGINE_SOURCE_COMMIT || null,
  deploymentId: process.env.ENGINE_DEPLOYMENT_ID || null,
  service: 'data-robot-engine',
};
const stateKey = `${mode}-${strategyInstanceId}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
const instanceStateDir = path.join(stateDir, 'instances', stateKey);

const app = createEngineApp({
  mode,
  liveEnabled,
  strategyId,
  strategyInstanceId,
  preset,
  sink: runtime?.sink,
  riskOpts,
  port: Number(process.env.ENGINE_PORT || 3201),
  host,
  opsToken,
  serveHttp: true,
  restoreOnStart: true,
  persistOnStop: true,
  autoCheckpointMs: Number(process.env.ENGINE_CHECKPOINT_MS || 30_000),
  backupDir: path.join(instanceStateDir, 'journal-backups'),
  executionAuditDir: path.join(instanceStateDir, 'execution-audit'),
  snapshotSource,
  catalogEntry,
  catalog,
  deployment,
  preflight: runtime?.preflight ?? null,
  beforeArm: runtime?.revalidatePreflight,
  startArmed:
    process.env.ENGINE_START_ARMED == null
      ? mode !== 'live'
      : process.env.ENGINE_START_ARMED === '1',
  canary:
    strategyId === MIDAS_V1_STRATEGY_ID
      ? {
          presetId: MIDAS_V1_PRESET_ID,
          hardCapUsd: Number(process.env.ENGINE_CANARY_MAX_BUDGET || MIDAS_CANARY_HARD_CAP_USD),
          maxEntriesPerControlWindow: 1,
          controlWindowMs: Number(
            process.env.ENGINE_CONTROL_WINDOW_MS || 24 * 60 * 60 * 1000,
          ),
          liveReverse: false,
        }
      : null,
  haltOnMarketRotationWithPosition: true,
});

await app.start();
console.log(
  `[engine:serve] mode=${mode} strategy=${strategyId} source=${sourceKind} approval=${catalogEntry.approval} port=${app.httpServer.port}`,
);

async function shutdown(signal) {
  console.log(`[engine:serve] ${signal} — shutdown`);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
