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
import '../src/net/httpBootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { createEngineApp } from '../src/control/engineApp.js';
import { createSnapshotSource } from '../src/market/snapshotSources.js';
import { createDefaultRegistry } from '../src/composition/bootstrap.js';
import {
  prepareMidasCanaryRuntime,
  fetchWalletSnapshot,
  MIDAS_CANARY_HARD_CAP_USD,
} from '../src/composition/midasService.js';
import { createApprovalStore } from '../src/catalog/approvalStore.js';
import { createStrategyLibrary } from '../src/catalog/strategyLibrary.js';
import { describeMidasPreset, resolveMidasCanaryCap, resolveMidasLivePreset, resolveMidasPortfolioAccountExposure } from '../src/tfc/preset-midas.js';
import { defaultPresetFor } from '../src/composition/presets.js';
import { MIDAS_V1_PRESET_ID, MIDAS_V1_STRATEGY_ID } from '../src/strategy/midasV1.js';
import { TFC_V7_STRATEGY_ID } from '../src/strategy/tfcV7.js';
import { isCrypto5mSourceKind, resolveCrypto5mAsset } from '../src/markets/crypto5m.js';
import config from '../src/config.js';

const mode = process.env.ENGINE_MODE || 'shadow';
const liveEnabled = process.env.ENGINE_LIVE_ENABLED === '1';
const host = process.env.ENGINE_HOST || '0.0.0.0';
const opsToken = process.env.ENGINE_OPS_TOKEN;
const sourceKind = process.env.ENGINE_SNAPSHOT_SOURCE || 'fixture';
const stateDir = process.env.ENGINE_STATE_DIR || 'runs';
// active-strategy + custom presets sob o volume persistente (runs/), não em config/ efêmero da imagem.
const strategyConfigDir =
  process.env.STRATEGY_CONFIG_DIR || path.join(stateDir, 'strategy-config');
const snapshotAssetKey = isCrypto5mSourceKind(sourceKind)
  ? resolveCrypto5mAsset(sourceKind).assetKey
  : null;
const volumeActive = path.join(strategyConfigDir, 'active-strategy.json');
const bundledActive = snapshotAssetKey
  ? path.join('config', 'portfolio', `${snapshotAssetKey}.json`)
  : volumeActive;
const activeStrategyFile =
  process.env.STRATEGY_ACTIVE_FILE ||
  (fs.existsSync(volumeActive) ? volumeActive : bundledActive);
const strategyLibrary = createStrategyLibrary({
  rootDir: strategyConfigDir,
  activeFile: activeStrategyFile,
});
console.log(`[engine:serve] active-strategy-file ${activeStrategyFile}`);
const activeStrategy = strategyLibrary.loadActive();
// Prioridade: active-strategy.json (UI) → env → fixture.
const strategyId =
  activeStrategy?.pluginId ||
  process.env.ENGINE_STRATEGY_ID ||
  'fixture-price-cross';
const strategyInstanceId =
  process.env.ENGINE_STRATEGY_INSTANCE_ID ||
  activeStrategy?.presetId ||
  `${strategyId}:primary`;
const catalogStore = createApprovalStore({
  file: process.env.STRATEGY_CATALOG_PATH || path.join('config', 'strategy-catalog.json'),
});

if (mode === 'live' && !liveEnabled) {
  console.error('[engine:serve] Recusa: ENGINE_MODE=live exige ENGINE_LIVE_ENABLED=1');
  process.exit(2);
}

if (mode === 'live' && !isCrypto5mSourceKind(sourceKind)) {
  console.error(
    '[engine:serve] Recusa: ENGINE_MODE=live exige ENGINE_SNAPSHOT_SOURCE=btc5m|eth5m|sol5m|xrp5m|doge5m',
  );
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
    // RTDS/CLOB acordam a engine por evento; o timer é watchdog + cadência adaptativa.
    // idle: longe do slot; hot: pré-entrada (antes dos 30s) até o fim do evento.
    intervalMs: Number(process.env.ENGINE_SOURCE_HOT_INTERVAL_MS || 50),
    idleIntervalMs: Number(process.env.ENGINE_SOURCE_IDLE_INTERVAL_MS || 500),
    hotIntervalMs: Number(process.env.ENGINE_SOURCE_HOT_INTERVAL_MS || 50),
    /** τ ≤ este valor → hot (default 45 = antes da janela maxSecondsLeft=30). */
    preEntryHotSecs: Number(process.env.ENGINE_SOURCE_PRE_ENTRY_SECS || 45),
    syncIntervalMs: Number(process.env.ENGINE_MARKET_SYNC_MS || 15_000),
    retryMs: Number(process.env.ENGINE_SOURCE_RETRY_MS || 2000),
  });
} catch (error) {
  console.error(`[engine:serve] ${error.message}`);
  process.exit(2);
}

const registry = createDefaultRegistry();
const catalog = catalogStore.load();
let manifest;
try {
  manifest = registry.resolve(strategyId).manifest;
} catch (error) {
  console.error(`[engine:serve] plugin não registrado: ${strategyId} (${error.message})`);
  process.exit(2);
}
const presetId =
  activeStrategy?.presetId || manifest.presetId || strategyId;
const strategyVersion = activeStrategy?.version || manifest.version;
const marketScope =
  activeStrategy?.marketScope ||
  (isCrypto5mSourceKind(sourceKind)
    ? resolveCrypto5mAsset(sourceKind).marketScope
    : 'fixture');

/** 0 = ilimitado na janela (1 ENTER/evento já vem de ONE_INTENT_PER_EVENT). */
function resolveMaxEntriesPerControlWindow() {
  const raw = process.env.ENGINE_CANARY_MAX_ENTRIES;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function buildCanaryStatus(strategyId, preset, presetId) {
  if (strategyId !== MIDAS_V1_STRATEGY_ID && strategyId !== TFC_V7_STRATEGY_ID) return null;
  const envCap = process.env.ENGINE_CANARY_MAX_BUDGET;
  const hardCapUsd =
    strategyId === MIDAS_V1_STRATEGY_ID
      ? resolveMidasCanaryCap(preset, envCap)
      : Number(envCap || 2);
  const midasDesc =
    strategyId === MIDAS_V1_STRATEGY_ID ? describeMidasPreset(presetId, preset) : null;
  const entryBudgetUsd = midasDesc?.entryBudgetUsd ?? Number(preset.entryBudget);
  return {
    presetId,
    hardCapUsd,
    entryBudgetUsd: Number.isFinite(entryBudgetUsd) ? entryBudgetUsd : null,
    maxEntryBudgetUsd: midasDesc?.maxEntryBudgetUsd ?? hardCapUsd,
    budgetLabel: midasDesc?.budgetLabel ?? null,
    backtestVersion: midasDesc?.backtestVersion ?? null,
    displayTitle: midasDesc?.displayTitle ?? presetId,
    maxEntriesPerControlWindow: resolveMaxEntriesPerControlWindow(),
    controlWindowMs: Number(process.env.ENGINE_CONTROL_WINDOW_MS || 24 * 60 * 60 * 1000),
    liveReverse: strategyId === MIDAS_V1_STRATEGY_ID,
  };
}

// Garante entrada no catálogo para presets custom/ativados via UI.
function ensureCatalogEntry(resolvedPreset) {
  const existing = catalog.strategies.find(
    (e) =>
      e.strategyId === strategyId &&
      e.version === strategyVersion &&
      e.presetId === presetId,
  );
  if (existing) return existing;
  const approval = mode === 'live' ? 'canary-approved' : 'shadow-approved';
  const entry = {
    strategyId,
    version: strategyVersion,
    presetId,
    marketScope: Array.isArray(activeStrategy?.marketScope)
      ? activeStrategy.marketScope
      : [marketScope],
    approval: mode === 'live' && strategyId !== MIDAS_V1_STRATEGY_ID ? 'registered' : approval,
    canary: (() => {
      const c = buildCanaryStatus(strategyId, resolvedPreset, presetId);
      return {
        hardCapUsd: c?.hardCapUsd ?? Number(process.env.ENGINE_CANARY_MAX_BUDGET || MIDAS_CANARY_HARD_CAP_USD),
        maxEntriesPerControlWindow: resolveMaxEntriesPerControlWindow(),
        controlWindowHours: 24,
        liveReverse: strategyId === MIDAS_V1_STRATEGY_ID,
      };
    })(),
    evidence: activeStrategy ? [`${strategyConfigDir}/active-strategy.json`] : [],
  };
  const next = {
    ...catalog,
    strategies: [...catalog.strategies, entry],
  };
  catalogStore.save(next);
  return entry;
}

let catalogEntry;
try {
  const catalogPreset =
    strategyId === MIDAS_V1_STRATEGY_ID
      ? resolveMidasLivePreset(presetId, activeStrategy?.params || {})
      : defaultPresetFor(strategyId, activeStrategy?.params || {});
  ensureCatalogEntry(catalogPreset);
  catalogEntry = catalogStore.assertApproved({
    strategyId,
    version: strategyVersion,
    presetId,
    marketScope,
    mode,
  });
} catch (error) {
  console.error(`[engine:serve] Recusa catálogo: ${error.message}`);
  process.exit(2);
}

let runtime = null;
let preset = defaultPresetFor(strategyId, activeStrategy?.params || {});
let riskOpts;
if (activeStrategy?.params && Object.keys(activeStrategy.params).length) {
  preset = { ...preset, ...activeStrategy.params };
  console.log(
    `[engine:serve] active-strategy ${strategyId} · ${presetId} · v${strategyVersion}`,
  );
}

if (strategyId === MIDAS_V1_STRATEGY_ID) {
  if (!isCrypto5mSourceKind(sourceKind)) {
    console.error(
      '[engine:serve] Recusa: MIDAS P9 exige ENGINE_SNAPSHOT_SOURCE=btc5m|eth5m|sol5m|xrp5m|doge5m',
    );
    process.exit(2);
  }
  // Live MIDAS: portfolio $2.5/$4 (Gold IDs) ou micro $2/$4.
  preset = resolveMidasLivePreset(presetId, preset);
  const maxCanaryBudget = resolveMidasCanaryCap(
    preset,
    process.env.ENGINE_CANARY_MAX_BUDGET,
  );
  const maxAccountExposure = resolveMidasPortfolioAccountExposure(
    preset,
    process.env.ENGINE_MAX_ACCOUNT_EXPOSURE,
  );
  console.log(
    `[engine:serve] midas-live-preset ${presetId} · entry=$${Number(preset.entryBudget)} · cap=$${maxCanaryBudget} · accountExposure=$${maxAccountExposure}`,
  );
  const controlWindowMs = Number(
    process.env.ENGINE_CONTROL_WINDOW_MS || 24 * 60 * 60 * 1000,
  );
  const maxEntriesPerControlWindow = resolveMaxEntriesPerControlWindow();
  if (mode === 'live') {
    try {
      runtime = await prepareMidasCanaryRuntime({
        maxCanaryBudget,
        maxAccountExposure,
        maxDailyLoss: maxAccountExposure,
        maxEntriesPerControlWindow,
        controlWindowMs,
        allowLiveReverse: true,
        preset,
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
      maxAccountExposure,
      maxEntriesPerControlWindow,
      controlWindowMs,
      allowLiveReverse: true,
    };
    if (config.polymarketPrivateKey) {
      try {
        runtime = {
          preflight: await fetchWalletSnapshot(),
          revalidatePreflight: async () => fetchWalletSnapshot(),
        };
        console.log(
          `[engine:serve] wallet portfolio=$${Number(runtime.preflight.checks.balance.balanceUsd).toFixed(2)} (cash=$${Number(runtime.preflight.checks.balance.cashUsd ?? runtime.preflight.checks.balance.balanceUsd).toFixed(2)} · pos=$${Number(runtime.preflight.checks.balance.positionsValueUsd ?? 0).toFixed(2)}; display-only)`,
        );
      } catch (error) {
        console.warn(`[engine:serve] wallet snapshot indisponível: ${error.message}`);
      }
    }
  }
} else if (strategyId === TFC_V7_STRATEGY_ID && isCrypto5mSourceKind(sourceKind)) {
  riskOpts = {
    canaryMode: true,
    maxCanaryBudget: Number(process.env.ENGINE_CANARY_MAX_BUDGET || 2),
    maxNotionalPerOrder: Number(process.env.ENGINE_CANARY_MAX_BUDGET || 2),
    maxNotionalPerEvent: Number(process.env.ENGINE_CANARY_MAX_BUDGET || 2),
    maxEntriesPerControlWindow: resolveMaxEntriesPerControlWindow(),
    controlWindowMs: Number(process.env.ENGINE_CONTROL_WINDOW_MS || 24 * 60 * 60 * 1000),
    allowLiveReverse: false,
  };
  if (mode !== 'live' && config.polymarketPrivateKey) {
    try {
      runtime = {
        preflight: await fetchWalletSnapshot(),
        revalidatePreflight: async () => fetchWalletSnapshot(),
      };
    } catch {
      /* optional */
    }
  }
}

const canaryStatus = buildCanaryStatus(strategyId, preset, presetId);

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
  maxCheckpointFiles: Number(process.env.ENGINE_CHECKPOINT_KEEP || 3),
  maxJournalFiles: Number(process.env.ENGINE_JOURNAL_KEEP || 3),
  auditMaxDays: Number(process.env.ENGINE_AUDIT_KEEP_DAYS || 3),
  backupDir: path.join(instanceStateDir, 'journal-backups'),
  executionAuditDir: path.join(instanceStateDir, 'execution-audit'),
  snapshotSource,
  catalogEntry,
  catalog,
  deployment,
  preflight: runtime?.preflight ?? null,
  beforeArm: runtime?.revalidatePreflight,
  getWallet: config.polymarketPrivateKey
    ? async () => {
        const snap = await fetchWalletSnapshot();
        if (typeof app.setPreflight === 'function') app.setPreflight(snap);
        const bal = snap.checks?.balance ?? {};
        return {
          ok: snap.ok === true,
          checkedAt: snap.checkedAt,
          portfolioUsd: bal.portfolioUsd ?? bal.balanceUsd ?? null,
          cashUsd: bal.cashUsd ?? null,
          positionsValueUsd: bal.positionsValueUsd ?? null,
          balanceUsd: bal.balanceUsd ?? bal.portfolioUsd ?? null,
          allowanceUsd: bal.allowanceUsd ?? null,
          allowanceUnlimited: bal.allowanceUnlimited === true,
          source: bal.source ?? 'polymarket',
          funderAddress: bal.funderAddress ?? null,
        };
      }
    : null,
  startArmed:
    process.env.ENGINE_START_ARMED == null
      ? false
      : process.env.ENGINE_START_ARMED === '1',
  canary: canaryStatus,
  getStrategyLibrary: () => {
    const described =
      strategyId === MIDAS_V1_STRATEGY_ID
        ? describeMidasPreset(presetId, preset)
        : { displayTitle: presetId, backtestVersion: null, budgetLabel: null };
    return {
      ...strategyLibrary.list(),
      active: strategyLibrary.loadActive(),
      running: {
        strategyId,
        version: strategyVersion,
        presetId,
        name: activeStrategy?.name || described.displayTitle || presetId,
        displayTitle: described.displayTitle || null,
        backtestVersion: described.backtestVersion || null,
        budgetLabel: described.budgetLabel || null,
      },
    };
  },
  getActiveStrategy: () => strategyLibrary.loadActive(),
  onSaveStrategyPreset: (body) => strategyLibrary.saveCustomPreset(body || {}),
  onActivateStrategy: (body) => strategyLibrary.activate(body || {}),
  haltOnMarketRotationWithPosition: true,
});

await app.start();
console.log(
  `[engine:serve] mode=${mode} strategy=${strategyId} source=${sourceKind} approval=${catalogEntry.approval} port=${app.httpServer.port}`,
);

// Atualiza carteira periodicamente (live e shadow) — mesmas fontes da UI Polymarket.
let walletRefreshTimer = null;
if (config.polymarketPrivateKey && typeof app.setPreflight === 'function') {
  const refreshMs = Number(process.env.ENGINE_WALLET_REFRESH_MS || 20_000);
  const tick = async () => {
    try {
      const snap = await fetchWalletSnapshot();
      app.setPreflight(snap);
    } catch {
      /* silent — UI mantém último snapshot */
    }
  };
  walletRefreshTimer = setInterval(tick, Math.max(10_000, refreshMs));
  walletRefreshTimer.unref?.();
}

async function shutdown(signal) {
  console.log(`[engine:serve] ${signal} — shutdown`);
  if (walletRefreshTimer) clearInterval(walletRefreshTimer);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
