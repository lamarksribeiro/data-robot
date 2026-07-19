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
  const iterations = opts.iterations ?? 100;
  const makeSnapshot = opts.makeSnapshot;
  if (typeof makeSnapshot !== 'function') throw new Error('makeSnapshot obrigatório');

  let divergences = 0;
  let riskBlocks = 0;

  for (let i = 0; i < iterations; i++) {
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
  }

  const slos = app.evaluateSlos();
  const health = app.health();
  const orphans = health.orphanOrders ?? 0;

  return {
    iterations,
    divergences,
    riskBlocks,
    orphans,
    slos,
    health,
    metrics: app.metricsSnap(),
    ok: divergences === 0 && orphans === 0 && slos.ok,
  };
}
