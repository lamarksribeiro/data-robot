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
  const sink = opts.sink ?? createOmsSink({ mode, clock: opts.clock });
  const snapshotSource = opts.snapshotSource ?? null;

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
  let recoveryOk = opts.restoreOnStart !== true;
  let autoCheckpointTimer = null;
  let started = false;
  let sourceStatus = snapshotSource
    ? { kind: snapshotSource.kind ?? 'custom', running: false, ok: false, reason: 'NOT_STARTED' }
    : { kind: 'manual', running: false, ok: null, reason: null };

  function status() {
    return engine.getStatus();
  }

  function health() {
    const st = status();
    const open = sink.oms?.openOrders?.() ?? [];
    const userHeartbeatAgeMs =
      sink.userChannel?.lastHeartbeatMs == null
        ? Infinity
        : Date.now() - sink.userChannel.lastHeartbeatMs;
    // órfã: open sem intentId (não deve ocorrer) ou UNKNOWN não reconciliado
    const unknowns = (sink.oms?.listOrders?.() ?? []).filter((o) => o.state === 'UNKNOWN');
    const report = buildHealthReport({
      engineStatus: st,
      mode,
      feedsOk: snapshotSource ? lastFeedsOk && sourceStatus.ok === true : lastFeedsOk,
      recoveryOk,
      userChannelOk:
        mode !== 'live' ||
        (sink.userChannel?.connected === true &&
          userHeartbeatAgeMs <= Number(opts.userWsStaleMs ?? 30_000) &&
          !sink.lastChannelError),
      orphanOrders: unknowns.length + (sink.orphanCount ?? 0),
      openOrders: open.length,
      availability: ticks > 0 ? eligibleTicks / ticks : null,
    });
    return { ...report, snapshotSource: { ...sourceStatus } };
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
    const t0 = performance.now();
    ticks += 1;
    lastFeedsOk = (snapshot.health?.ok ?? snapshot.feeds?.healthy) === true;
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
    logger.info('checkpoint_saved', { state: engine.state });
    return lastCheckpoint;
  }

  function rollback() {
    if (!lastCheckpoint) throw new Error('nenhum checkpoint para rollback');
    engine.restore(lastCheckpoint);
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
    onKill: async (reason) => {
      logger.error('kill_requested', { reason });
      return engine.kill(reason);
    },
  });

  return {
    engine,
    sink,
    metrics,
    logger,
    alerts,
    backup,
    httpServer,
    health,
    status,
    metricsSnap,
    ingestSynthetic,
    ingestMarketSnapshot,
    get snapshotSourceStatus() {
      return { ...sourceStatus };
    },
    checkpoint,
    rollback,
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
      started = true;
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
      logger.info('engine_stopped');
    },
  };
}
