/**
 * Soak harness — mesmo artefato das fixtures (sem TFC).
 * CI: iterações curtas. Produção: ENGINE_SOAK_ITERATIONS / duração.
 */

/**
 * @param {object} app — createEngineApp
 * @param {object} opts
 * @param {number} [opts.iterations]
 * @param {() => object} opts.makeSnapshot
 * @param {(i: number) => void} [opts.onTick]
 */
export async function runSoak(app, opts) {
  const requestedIterations = opts.iterations ?? 100;
  const durationMs = Math.max(0, Number(opts.durationMs ?? 0));
  const intervalMs = Math.max(0, Number(opts.intervalMs ?? 0));
  const makeSnapshot = opts.makeSnapshot;
  if (typeof makeSnapshot !== 'function') throw new Error('makeSnapshot obrigatório');

  let divergences = 0;
  let riskBlocks = 0;

  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + durationMs;
  let iterations = 0;
  while (durationMs > 0 ? Date.now() < deadlineMs : iterations < requestedIterations) {
    const i = iterations;
    const snap = makeSnapshot(i);
    const beforeOrders = app.sink.oms?.listOrders?.().length ?? 0;
    await app.ingestSynthetic(snap);
    const afterOrders = app.sink.oms?.listOrders?.().length ?? 0;

    // divergência simples: UNKNOWN
    const unknowns = (app.sink.oms?.listOrders?.() ?? []).filter((o) => o.state === 'UNKNOWN');
    if (unknowns.length) divergences += 1;

    const denied = app.engine.journal.filter(
      (j) => j.type === 'risk' && j.decision?.allow === false,
    ).length;
    // conta só novos? aproximação: métrica cumulativa ao final
    riskBlocks = denied;

    if (typeof opts.onTick === 'function') opts.onTick(i, { beforeOrders, afterOrders });
    iterations += 1;
    if (intervalMs > 0 && (durationMs === 0 || Date.now() < deadlineMs)) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const slos = app.evaluateSlos();
  const health = app.health();
  const orphans = health.orphanOrders ?? 0;

  return {
    iterations,
    durationMs: Date.now() - startedAtMs,
    divergences,
    riskBlocks,
    orphans,
    slos,
    health,
    metrics: app.metricsSnap(),
    ok: divergences === 0 && orphans === 0 && riskBlocks === 0 && slos.ok,
  };
}
