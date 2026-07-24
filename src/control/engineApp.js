/**
 * Aplicação da engine (processo separado da UI).
 * SnapshotSource opcional alimenta o runtime continuamente.
 */

import { bootstrapEngine } from '../composition/bootstrap.js';
import { defaultPresetFor } from '../composition/presets.js';
import { createOmsSink } from '../oms/omsSink.js';
import { createMetrics } from '../observability/metrics.js';
import { createLogger } from '../observability/logger.js';
import { createAlertHub } from '../observability/alerts.js';
import { evaluateSlos, DEFAULT_SLOS } from '../observability/slo.js';
import { createJournalBackup } from '../observability/journalBackup.js';
import { createExecutionAudit } from '../observability/executionAudit.js';
import { resolveBinarySettlementPrice } from '../market/resolveBinarySettlement.js';
import { createFeedHealthGate } from '../market/health.js';
import { buildHealthReport } from './health.js';
import { createControlServer } from './httpServer.js';

/**
 * @param {object} [opts]
 */
export function createEngineApp(opts = {}) {
  const mode = opts.mode ?? 'shadow';
  const strategyId = opts.strategyId ?? 'fixture-price-cross';
  const preset = opts.preset ?? defaultPresetFor(strategyId, {
    threshold: opts.threshold != null ? Number(opts.threshold) : undefined,
  });

  const metrics = opts.metrics ?? createMetrics({ clock: opts.clock });
  const logger = opts.logger ?? createLogger({ service: 'data-robot-engine' });
  const alerts = opts.alerts ?? createAlertHub();
  const backup = opts.journalBackup ?? createJournalBackup({ dir: opts.backupDir });
  const executionAudit =
    opts.executionAudit ?? createExecutionAudit({ dir: opts.executionAuditDir, clock: opts.clock });
  const sink = opts.sink ?? createOmsSink({ mode, clock: opts.clock });
  const snapshotSource = opts.snapshotSource ?? null;
  const startArmed = opts.startArmed ?? mode !== 'live';

  const engine = bootstrapEngine({
    strategyId,
    mode,
    preset,
    sink,
    clock: opts.clock,
    liveEnabled: opts.liveEnabled === true,
    riskOpts: opts.riskOpts,
    strategyInstanceId: opts.strategyInstanceId,
  });

  let lastCheckpoint = null;
  let ticks = 0;
  let eligibleTicks = 0;
  let lastFeedsOk = false;
  let lastProcessFeedsOk = true;
  let recoveryOk = opts.restoreOnStart !== true;
  let autoCheckpointTimer = null;
  let started = false;
  let startedAtMs = null;
  let operatorState = startArmed ? 'ARMED' : 'DISARMED';
  let operatorChangedAtMs = null;
  let operatorQueue = Promise.resolve();
  let latestPreflight = opts.preflight ?? null;
  let sourceStatus = snapshotSource
    ? { kind: snapshotSource.kind ?? 'custom', running: false, ok: false, reason: 'NOT_STARTED' }
    : { kind: 'manual', running: false, ok: null, reason: null };
  // Histerese: engine só degrada após falhas sustentadas de feed (não em blip de 1 tick).
  const feedHealthGate = createFeedHealthGate({
    failStreakToDegrade: Number(opts.feedFailStreakToDegrade ?? 5),
    okStreakToRecover: Number(opts.feedOkStreakToRecover ?? 2),
  });
  // User WS: grace após reconnect antes de marcar userChannelOk=false.
  let userChannelFailStreak = 0;
  const userChannelFailToDegrade = Number(opts.userChannelFailStreakToDegrade ?? 3);

  function marketSummary(base) {
    const marketId = base.lastMarketId ?? base.position?.marketId ?? null;
    const diag = base.diagnostics ?? {};
    const entry = diag.entry ?? {};
    const source = sourceStatus ?? {};
    let asset = '—';
    let window = '—';
    if (typeof marketId === 'string') {
      if (marketId.startsWith('btc-updown-5m')) {
        asset = 'BTC';
        window = 'Up/Down 5m';
      } else if (marketId.startsWith('eth-updown-5m')) {
        asset = 'ETH';
        window = 'Up/Down 5m';
      } else if (marketId.includes('fixture')) {
        asset = 'FIXTURE';
        window = 'simulado';
      }
    } else if (source.kind === 'btc5m') {
      asset = 'BTC';
      window = 'Up/Down 5m';
    } else if (source.kind === 'fixture') {
      asset = 'FIXTURE';
      window = 'simulado';
    }
    const spot = base.lastSpot ?? {};
    const btc = Number.isFinite(Number(spot.btc))
      ? Number(spot.btc)
      : Number.isFinite(Number(diag.btc))
        ? Number(diag.btc)
        : null;
    const priceToBeat = Number.isFinite(Number(spot.priceToBeat))
      ? Number(spot.priceToBeat)
      : Number.isFinite(Number(diag.priceToBeat))
        ? Number(diag.priceToBeat)
        : null;
    const favFromSpot =
      btc != null && priceToBeat != null ? (btc >= priceToBeat ? 'UP' : 'DOWN') : null;
    const favoriteSide = entry.fav ?? favFromSpot ?? base.position?.side ?? null;
    let signedDistance = null;
    if (Number.isFinite(Number(diag.danger?.signedDistance))) {
      signedDistance = Number(diag.danger.signedDistance);
    } else if (Number.isFinite(Number(diag.lateFlip?.signedDistance))) {
      signedDistance = Number(diag.lateFlip.signedDistance);
    } else if (btc != null && priceToBeat != null && favoriteSide) {
      signedDistance =
        favoriteSide === 'DOWN' ? priceToBeat - btc : btc - priceToBeat;
    } else if (btc != null && priceToBeat != null) {
      // sem lado: distância bruta BTC−PTB (sinal do cruzamento absoluto)
      signedDistance = btc - priceToBeat;
    }
    const secsLeft = Number.isFinite(Number(diag.secsLeft))
      ? Number(diag.secsLeft)
      : Number.isFinite(Number(spot.secsLeft))
        ? Number(spot.secsLeft)
        : null;
    const book = spot.book ?? {};
    const askFromBook =
      favoriteSide === 'UP'
        ? book.upAsk
        : favoriteSide === 'DOWN'
          ? book.downAsk
          : null;
    const bidFromBook =
      favoriteSide === 'UP'
        ? book.upBid
        : favoriteSide === 'DOWN'
          ? book.downBid
          : null;
    const ask = Number.isFinite(Number(entry.ask))
      ? Number(entry.ask)
      : Number.isFinite(Number(askFromBook))
        ? Number(askFromBook)
        : null;
    const bid = Number.isFinite(Number(entry.bid))
      ? Number(entry.bid)
      : Number.isFinite(Number(bidFromBook))
        ? Number(bidFromBook)
        : null;
    return {
      asset,
      window,
      marketId,
      sourceKind: source.kind ?? null,
      sourceOk: source.ok ?? null,
      sourceReason: source.reason ?? null,
      secsLeft,
      favoriteSide,
      ask,
      bid,
      upAsk: Number.isFinite(Number(book.upAsk)) ? Number(book.upAsk) : null,
      upBid: Number.isFinite(Number(book.upBid)) ? Number(book.upBid) : null,
      downAsk: Number.isFinite(Number(book.downAsk)) ? Number(book.downAsk) : null,
      downBid: Number.isFinite(Number(book.downBid)) ? Number(book.downBid) : null,
      btc,
      priceToBeat,
      signedDistance,
      entryOk: entry.ok === true,
      entryWatchOnly: entry.blockedByPosition === true || entry.watchOnly === true,
      feedsHealthy: diag.feedsHealthy !== false,
      inPosition: diag.inPosition === true || Number(base.position?.qty) > 0,
    };
  }

  function status() {
    const base = engine.getStatus();
    const allOrders = sink.oms?.listOrders?.() ?? [];
    const openOrders = sink.oms?.openOrders?.() ?? [];
    return {
      ...base,
      startedAtMs,
      uptimeMs: startedAtMs == null ? 0 : Math.max(0, Date.now() - startedAtMs),
      orders: allOrders.slice(-40),
      openOrders,
      market: marketSummary(base),
      accountExposure: sink.oms?.accountExposure?.() ?? null,
      catalog: opts.catalogEntry ?? null,
      catalogEntries: opts.catalog?.strategies ?? [],
      deployment: opts.deployment ?? null,
      preflight: latestPreflight,
      canary: opts.canary ?? null,
      auditDir: executionAudit.dir,
      operatorState,
      operatorChangedAtMs,
      entryEnabled: engine.risk.entryEnabled !== false,
    };
  }

  function auditOperator(action, detail = {}) {
    executionAudit.append('operator_action', {
      action,
      operatorState,
      strategyId,
      strategyInstanceId: engine.strategyInstanceId,
      ...detail,
    });
  }

  function serializeOperatorAction(action, fn) {
    const run = operatorQueue.then(fn, fn);
    operatorQueue = run.catch(() => {});
    return run.catch((error) => {
      auditOperator(action, { ok: false, reason: error.message });
      throw error;
    });
  }

  function setOperatorState(next, action, detail = {}) {
    operatorState = next;
    operatorChangedAtMs = Date.now();
    auditOperator(action, { ok: true, ...detail });
    return status();
  }

  async function reconcile(reason = 'operator-reconcile') {
    return serializeOperatorAction('reconcile', async () => {
      const result = await sink.reconcileAll?.();
      recoveryOk = result?.ok !== false;
      const orphans = result?.orphans ?? [];
      if (!recoveryOk || orphans.length > 0) {
        engine.risk.setEntryEnabled(false);
        operatorState = 'DISARMED';
        throw new Error('RECONCILIATION_UNRESOLVED');
      }
      auditOperator('reconcile', { ok: true, reason, result });
      return result ?? { ok: true, unresolved: [], orphans: [] };
    });
  }

  async function arm(reason = 'operator-arm') {
    return serializeOperatorAction('arm', async () => {
      if (!started) throw new Error('ENGINE_NOT_STARTED');
      if (engine.state === 'HALTED' || engine.getStatus().killActive) {
        throw new Error('HALTED_RESTART_REQUIRED');
      }
      if (mode === 'live') {
        sink.assertReady?.();
        if (typeof opts.beforeArm === 'function') {
          latestPreflight = await opts.beforeArm();
          if (latestPreflight?.ok !== true) throw new Error('PREFLIGHT_FAILED');
        }
      }
      const recovery = await sink.reconcileAll?.();
      recoveryOk = recovery?.ok !== false;
      if (
        !recoveryOk ||
        (recovery?.unresolved?.length ?? 0) > 0 ||
        (recovery?.orphans?.length ?? 0) > 0
      ) {
        throw new Error('RECONCILIATION_UNRESOLVED');
      }
      const h = health();
      if (!h.feedsOk || !h.recoveryOk || !h.userChannelOk || h.orphanOrders > 0) {
        throw new Error('DEPENDENCIES_NOT_READY');
      }
      engine.risk.setEntryEnabled(true);
      return setOperatorState('ARMED', 'arm', { reason, recovery });
    });
  }

  async function disarm(nextState = 'DISARMED', reason = 'operator-stop') {
    return serializeOperatorAction(nextState === 'PAUSED' ? 'pause' : 'disarm', async () => {
      if (!started) throw new Error('ENGINE_NOT_STARTED');
      engine.risk.setEntryEnabled(false);
      const cancellation = await sink.cancelOpenEntries?.(reason);
      if ((cancellation?.failed?.length ?? 0) > 0) {
        operatorState = nextState;
        operatorChangedAtMs = Date.now();
        auditOperator(nextState === 'PAUSED' ? 'pause' : 'disarm', {
          ok: false,
          reason: 'ENTRY_CANCEL_FAILED',
          cancellation,
        });
        throw new Error('ENTRY_CANCEL_FAILED');
      }
      return setOperatorState(
        nextState,
        nextState === 'PAUSED' ? 'pause' : 'disarm',
        { reason, cancellation },
      );
    });
  }

  async function cancelAll(reason = 'operator-cancel-all') {
    return serializeOperatorAction('cancel_all', async () => {
      engine.risk.setEntryEnabled(false);
      operatorState = 'DISARMED';
      operatorChangedAtMs = Date.now();
      const result = await sink.cancelOpenOrders?.(reason);
      auditOperator('cancel_all', { ok: (result?.failed?.length ?? 0) === 0, reason, result });
      if ((result?.failed?.length ?? 0) > 0) throw new Error('ORDER_CANCEL_FAILED');
      return result ?? { canceled: [], failed: [] };
    });
  }

  async function rollbackSafe(reason = 'operator-rollback') {
    return serializeOperatorAction('rollback', async () => {
      if (operatorState !== 'DISARMED') throw new Error('DISARM_REQUIRED');
      if ((sink.oms?.openOrders?.().length ?? 0) > 0) throw new Error('OPEN_ORDERS_BLOCK_ROLLBACK');
      const result = rollback();
      engine.start();
      engine.risk.setEntryEnabled(false);
      operatorState = 'DISARMED';
      operatorChangedAtMs = Date.now();
      const recovery = await sink.reconcileAll?.();
      recoveryOk = recovery?.ok !== false;
      if (!recoveryOk || (recovery?.orphans?.length ?? 0) > 0) {
        throw new Error('ROLLBACK_RECONCILIATION_FAILED');
      }
      auditOperator('rollback', { ok: true, reason, recovery });
      return { ...result, ...engine.getStatus() };
    });
  }

  async function flatten(reason = 'operator-flatten') {
    return serializeOperatorAction('flatten', async () => {
      if (!started) throw new Error('ENGINE_NOT_STARTED');
      if (engine.state === 'HALTED') throw new Error('HALTED_RESTART_REQUIRED');
      engine.risk.setEntryEnabled(false);
      operatorState = 'DISARMED';
      operatorChangedAtMs = Date.now();
      const entryCancellation = await sink.cancelOpenEntries?.('operator-flatten');
      if ((entryCancellation?.failed?.length ?? 0) > 0) throw new Error('ENTRY_CANCEL_FAILED');

      const position = engine.position;
      if (!(Number(position.qty) > 0) || !position.side) {
        auditOperator('flatten', { ok: true, reason, alreadyFlat: true });
        return { alreadyFlat: true, position };
      }
      const snapshot = engine.getLastSnapshot();
      if (!snapshot || snapshot.marketId !== position.marketId) {
        throw new Error('CURRENT_MARKET_SNAPSHOT_REQUIRED');
      }
      const sideKey = String(position.side).toLowerCase();
      const tokenId =
        position.side === 'UP' ? snapshot.identity?.upTokenId : snapshot.identity?.downTokenId;
      const bid = Number(snapshot.book?.[sideKey]?.bestBid);
      if (!tokenId || !Number.isFinite(bid) || bid <= 0) {
        throw new Error('EXIT_MARKET_DATA_UNAVAILABLE');
      }
      const floor = Number(preset.stopMinBid ?? preset.minExitPrice ?? 0.01);
      const slippage = Number(preset.entrySlippageMax ?? 0.02);
      const minPrice = Math.max(
        Number.isFinite(floor) ? floor : 0.01,
        bid - (Number.isFinite(slippage) ? slippage : 0.02),
      );
      const result = await engine.submitOperatorIntent({
        kind: 'EXIT',
        side: position.side,
        marketId: position.marketId,
        quantity: Number(position.qty),
        minPrice,
        maxPrice: null,
        tokenId,
        orderType: 'FAK',
        deadlineMs: Date.now() + 3_000,
        reason,
        presetId: opts.catalogEntry?.presetId ?? null,
      });
      auditOperator('flatten', {
        ok: result?.allowed === true && result?.result?.accepted !== false,
        reason,
        position,
        minPrice,
        intentId: result?.result?.intentId ?? null,
      });
      if (result?.allowed !== true || result?.result?.accepted === false) {
        throw new Error(result?.decision?.reasonCode ?? 'FLATTEN_REJECTED');
      }
      return result;
    });
  }

  function health() {
    const st = status();
    const open = sink.oms?.openOrders?.() ?? [];
    const userHeartbeatAgeMs =
      sink.userChannel?.lastHeartbeatMs == null
        ? Infinity
        : Date.now() - sink.userChannel.lastHeartbeatMs;
    const userWsStaleMs = Number(opts.userWsStaleMs ?? 45_000);
    // órfã: open sem intentId (não deve ocorrer) ou UNKNOWN não reconciliado
    const unknowns = (sink.oms?.listOrders?.() ?? []).filter((o) => o.state === 'UNKNOWN');

    // User channel: streak + grace — blip de reconnect não degrada o processo.
    let userChannelRawOk = true;
    if (mode === 'live') {
      userChannelRawOk =
        sink.userChannel?.connected === true &&
        userHeartbeatAgeMs <= userWsStaleMs &&
        !sink.lastChannelError;
      if (userChannelRawOk) userChannelFailStreak = 0;
      else userChannelFailStreak += 1;
    } else {
      userChannelFailStreak = 0;
    }
    const userChannelOk =
      mode !== 'live' || userChannelRawOk || userChannelFailStreak < userChannelFailToDegrade;

    const feedGate = feedHealthGate.snapshot();
    // Processo: histerese de feeds + source.ok (identidade/PTB). Não usa trading-stale tick-a-tick.
    const sourceReady = !snapshotSource || sourceStatus.ok === true;
    const feedsOk = feedGate.healthy && sourceReady;

    const report = buildHealthReport({
      engineStatus: st,
      mode,
      feedsOk,
      recoveryOk,
      userChannelOk,
      orphanOrders: unknowns.length + (sink.orphanCount ?? 0),
      openOrders: open.length,
      availability: ticks > 0 ? eligibleTicks / ticks : null,
    });
    return {
      ...report,
      snapshotSource: { ...sourceStatus },
      feedGate,
      tradingFeedsOk: lastFeedsOk,
      processFeedsOk: lastProcessFeedsOk,
      userChannelRawOk,
      userChannelFailStreak,
    };
  }

  function metricsSnap() {
    const st = status();
    metrics.gauge('exposure_qty', st.position?.qty ?? 0);
    metrics.gauge('realized_pnl', st.position?.realizedPnl ?? 0);
    metrics.gauge('open_orders', sink.oms?.openOrders?.().length ?? 0);
    metrics.gauge('snapshot_source_ok', sourceStatus.ok === true ? 1 : 0);
    metrics.gauge(
      'risk_violations',
      Object.values(st.riskMetrics ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
    );
    return metrics.snapshot();
  }

  async function ingest(snapshot, useMarketGate) {
    if (
      mode === 'live' &&
      opts.haltOnMarketRotationWithPosition !== false &&
      engine.position.qty > 0 &&
      engine.position.marketId &&
      snapshot.marketId !== engine.position.marketId
    ) {
      const fromMarketId = engine.position.marketId;
      const side = engine.position.side;
      const resolution = await resolveBinarySettlementPrice(fromMarketId, side, {
        fetchFn: opts.fetchFn,
      });

      if (resolution.ok) {
        const settled = engine.settlePosition({
          price: resolution.settlementPrice,
          reason: 'binary_expiry_settlement',
          marketId: fromMarketId,
        });
        executionAudit.append('position_settled', {
          fromMarketId,
          toMarketId: snapshot.marketId,
          winner: resolution.winner,
          ...settled,
        });
        // Após settlement: flat, mas sem novas entradas até o operador armar de novo.
        engine.risk.setEntryEnabled(false);
        operatorState = 'DISARMED';
        operatorChangedAtMs = Date.now();
        logger.info('position_settled_on_rotation', {
          fromMarketId,
          toMarketId: snapshot.marketId,
          pnlDelta: settled.pnlDelta,
          settlementPrice: resolution.settlementPrice,
        });
        // segue o ingest no mercado novo (flat)
      } else {
        if (engine.state === 'HALTED') {
          return { skipped: true, reason: 'ALREADY_HALTED_PENDING_SETTLEMENT' };
        }
        const reason = 'market-rotated-with-position';
        executionAudit.append('protective_halt', {
          reason,
          fromMarketId,
          toMarketId: snapshot.marketId,
          position: engine.position,
          resolution,
        });
        await engine.safeShutdown(reason);
        return { skipped: true, reason: 'POSITION_REQUIRES_SETTLEMENT' };
      }
    }
    const t0 = performance.now();
    ticks += 1;
    lastFeedsOk = (snapshot.health?.ok ?? snapshot.feeds?.healthy) === true;
    lastProcessFeedsOk =
      snapshot.processHealth?.ok === true ||
      snapshot.feeds?.processHealthy === true ||
      // se processHealth ausente (fixture), use trading
      (snapshot.processHealth == null && lastFeedsOk);
    // Hard fail: ambos os sockets caídos.
    const hardFail =
      snapshot.feeds?.rtdsConnected === false && snapshot.feeds?.clobConnected === false;
    feedHealthGate.observe(lastProcessFeedsOk, snapshot.health?.reasons?.[0] ?? null, {
      hardFail,
    });
    const result = useMarketGate
      ? await engine.ingestMarketSnapshot(snapshot)
      : await engine.ingestSnapshot(snapshot);
    metrics.observe('ingest_ms', performance.now() - t0);
    metrics.observe('decision_ms', performance.now() - t0);
    metrics.inc('snapshots_total');
    if (result?.skipped !== true) {
      eligibleTicks += 1;
      metrics.inc('snapshots_processed');
    } else {
      metrics.inc('snapshots_skipped');
    }
    const decisionResult = useMarketGate ? result?.result : result;
    if (decisionResult?.intentCount) metrics.inc('intents_emitted', decisionResult.intentCount);
    if (decisionResult?.intentCount) {
      executionAudit.append('decision', {
        marketId: snapshot.marketId,
        intentCount: decisionResult.intentCount,
        diagnostics: decisionResult.diagnostics ?? null,
        position: decisionResult.position ?? engine.position,
      });
    }

    const h = health();
    const m = metricsSnap();
    alerts.evaluate({
      metrics: m,
      health: h,
      engineStatus: status(),
      slos: opts.slos ?? DEFAULT_SLOS,
    });
    return result;
  }

  async function ingestSynthetic(snapshot) {
    return ingest(snapshot, false);
  }

  async function ingestMarketSnapshot(snapshot) {
    return ingest(snapshot, true);
  }

  function updateSourceStatus(next = {}) {
    const previousKey = `${sourceStatus.ok}:${sourceStatus.reason}`;
    sourceStatus = { ...sourceStatus, ...next };
    const nextKey = `${sourceStatus.ok}:${sourceStatus.reason}`;
    if (previousKey !== nextKey) {
      logger.info('snapshot_source_status', {
        kind: sourceStatus.kind,
        ok: sourceStatus.ok,
        reason: sourceStatus.reason,
        marketId: sourceStatus.marketId ?? null,
      });
    }
  }

  function noteSourceError(error) {
    metrics.inc('snapshot_source_errors');
    logger.error('snapshot_source_error', {
      kind: sourceStatus.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  function checkpoint() {
    lastCheckpoint = engine.checkpoint();
    if (sink.oms?.journal) {
      backup.save(sink.oms.journal.snapshot(), 'checkpoint');
    }
    backup.saveCheckpoint?.(lastCheckpoint, 'engine');
    executionAudit.append('checkpoint', {
      state: engine.state,
      marketId: lastCheckpoint.lastSnapshot?.marketId ?? null,
      pendingIntentCount: lastCheckpoint.pendingIntents?.length ?? 0,
    });
    logger.info('checkpoint_saved', { state: engine.state });
    return lastCheckpoint;
  }

  function rollback() {
    if (!lastCheckpoint) throw new Error('nenhum checkpoint para rollback');
    engine.restore(lastCheckpoint);
    executionAudit.append('rollback', {
      state: engine.state,
      savedAtMs: lastCheckpoint.savedAtMs ?? null,
    });
    logger.warn('rollback_applied', { state: engine.state });
    return engine.getStatus();
  }

  const httpServer = createControlServer({
    port: opts.port,
    host: opts.host,
    opsToken: opts.opsToken ?? process.env.ENGINE_OPS_TOKEN,
    getHealth: health,
    getStatus: () => ({ ...status(), health: health(), slos: evaluateSlos(metricsSnap(), health(), opts.slos) }),
    getMetrics: metricsSnap,
    getCatalog: () => opts.catalog ?? { strategies: opts.catalogEntry ? [opts.catalogEntry] : [] },
    getInstances: () => [
      {
        strategyInstanceId: engine.strategyInstanceId,
        strategyId,
        mode,
        marketId: engine.getStatus().lastMarketId,
        operatorState,
        engineState: engine.state,
        active: started,
      },
    ],
    getAudit: (limit) => executionAudit.listRecent(limit),
    getStrategyLibrary: opts.getStrategyLibrary,
    getActiveStrategy: opts.getActiveStrategy,
    onSaveStrategyPreset: opts.onSaveStrategyPreset,
    onActivateStrategy: opts.onActivateStrategy,
    onArm: arm,
    onPause: (reason) => disarm('PAUSED', reason),
    onDisarm: (reason) => disarm('DISARMED', reason),
    onCancelAll: cancelAll,
    onReconcile: reconcile,
    onCheckpoint: (reason) =>
      serializeOperatorAction('checkpoint', async () => {
        const saved = checkpoint();
        auditOperator('checkpoint', { ok: true, reason, savedAtMs: saved.savedAtMs ?? null });
        return {
          savedAtMs: saved.savedAtMs ?? null,
          state: saved.engineState,
          marketId: saved.lastSnapshot?.marketId ?? null,
        };
      }),
    onRollback: rollbackSafe,
    onFlatten: flatten,
    onKill: async (reason) => {
      logger.error('kill_requested', { reason });
      engine.risk.setEntryEnabled(false);
      operatorState = 'HALTED';
      operatorChangedAtMs = Date.now();
      const result = await engine.kill(reason);
      auditOperator('kill', { ok: true, reason, result });
      return result;
    },
  });

  return {
    engine,
    sink,
    metrics,
    logger,
    alerts,
    backup,
    executionAudit,
    httpServer,
    health,
    status,
    metricsSnap,
    ingestSynthetic,
    ingestMarketSnapshot,
    /** Atualiza snapshot de preflight/carteira (ex.: leitura CLOB em shadow). */
    setPreflight(next) {
      latestPreflight = next ?? null;
      return latestPreflight;
    },
    getPreflight() {
      return latestPreflight;
    },
    get snapshotSourceStatus() {
      return { ...sourceStatus };
    },
    checkpoint,
    rollback,
    arm,
    pause: (reason) => disarm('PAUSED', reason),
    disarm: (reason) => disarm('DISARMED', reason),
    cancelAll,
    reconcile,
    flatten,
    rollbackSafe,
    evaluateSlos: () => evaluateSlos(metricsSnap(), health(), opts.slos ?? DEFAULT_SLOS),

    async start() {
      if (started) return status();
      if (opts.restoreOnStart === true) {
        const latest = backup.latestCheckpoint?.();
        if (latest) {
          lastCheckpoint = backup.loadCheckpoint(latest);
          engine.restore(lastCheckpoint);
          const previousFeed = lastCheckpoint.lastSnapshot?.feeds?.healthy;
          lastFeedsOk = previousFeed === true;
        }
      }
      await sink.start?.();
      if (lastCheckpoint || mode === 'live') {
        const recovery = await sink.reconcileAll?.();
        recoveryOk = recovery?.ok !== false;
        if (!recoveryOk) {
          await engine.safeShutdown('recovery-unresolved');
          throw new Error('recovery falhou: ordens não reconciliadas');
        }
      } else {
        recoveryOk = true;
      }
      engine.start();
      engine.risk.setEntryEnabled(startArmed);
      operatorState = startArmed ? 'ARMED' : 'DISARMED';
      operatorChangedAtMs = Date.now();
      started = true;
      startedAtMs = Date.now();
      executionAudit.append('engine_started', {
        strategyId,
        mode,
        operatorState,
        deployment: opts.deployment ?? null,
        catalog: opts.catalogEntry ?? null,
      });
      logger.info('engine_started', { strategyId, mode, state: engine.state });
      if (snapshotSource) {
        try {
          await snapshotSource.start({
            onSnapshot: ingestMarketSnapshot,
            onStatus: updateSourceStatus,
            onError: noteSourceError,
          });
        } catch (error) {
          updateSourceStatus({ running: false, ok: false, reason: 'START_FAILED' });
          noteSourceError(error);
          try {
            await snapshotSource.stop?.();
          } catch {
            /* best effort depois de start parcial */
          }
          await engine.safeShutdown('snapshot-source-start-failed');
          sink.dispose?.();
          started = false;
          throw error;
        }
      }
      if (opts.serveHttp !== false) {
        await httpServer.start();
        logger.info('control_listen', { host: httpServer.host, port: httpServer.port });
      }
      const autoCheckpointMs = Number(opts.autoCheckpointMs ?? 0);
      if (autoCheckpointMs > 0) {
        autoCheckpointTimer = setInterval(checkpoint, autoCheckpointMs);
        if (autoCheckpointTimer.unref) autoCheckpointTimer.unref();
      }
      return status();
    },

    async stop() {
      if (!started) return;
      if (autoCheckpointTimer) {
        clearInterval(autoCheckpointTimer);
        autoCheckpointTimer = null;
      }
      if (snapshotSource) {
        try {
          await snapshotSource.stop();
        } catch (error) {
          noteSourceError(error);
        }
      }
      await engine.safeShutdown('app-stop');
      if (opts.persistOnStop === true || opts.restoreOnStart === true) checkpoint();
      if (opts.serveHttp !== false) {
        try {
          await httpServer.stop();
        } catch {
          /* ignore */
        }
      }
      sink.dispose?.();
      started = false;
      executionAudit.append('engine_stopped', { strategyId, mode });
      logger.info('engine_stopped');
    },
  };
}
