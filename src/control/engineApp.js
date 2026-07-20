/**
 * Aplicação da engine (processo separado da UI).
 * Roda fixtures em shadow por default — sem TFC, sem CLOB real.
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
    return buildHealthReport({
      engineStatus: st,
      mode,
      feedsOk: lastFeedsOk,
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
  }

  function metricsSnap() {
    const st = status();
    metrics.gauge('exposure_qty', st.position?.qty ?? 0);
    metrics.gauge('realized_pnl', st.position?.realizedPnl ?? 0);
    metrics.gauge('open_orders', sink.oms?.openOrders?.().length ?? 0);
    metrics.gauge(
      'risk_violations',
      Object.values(st.riskMetrics ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
    );
    return metrics.snapshot();
  }

  async function ingestSynthetic(snapshot) {
    const t0 = performance.now();
    ticks += 1;
    lastFeedsOk = snapshot.feeds?.healthy === true;
    const result = await engine.ingestSnapshot(snapshot);
    metrics.observe('ingest_ms', performance.now() - t0);
    metrics.observe('decision_ms', performance.now() - t0);
    metrics.inc('snapshots_total');
    if (!result.skipped) {
      eligibleTicks += 1;
      metrics.inc('snapshots_processed');
    } else {
      metrics.inc('snapshots_skipped');
    }
    if (result.intentCount) metrics.inc('intents_emitted', result.intentCount);

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
    checkpoint,
    rollback,
    evaluateSlos: () => evaluateSlos(metricsSnap(), health(), opts.slos ?? DEFAULT_SLOS),

    async start() {
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
      logger.info('engine_started', { strategyId, mode, state: engine.state });
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
      if (autoCheckpointTimer) {
        clearInterval(autoCheckpointTimer);
        autoCheckpointTimer = null;
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
      logger.info('engine_stopped');
    },
  };
}
