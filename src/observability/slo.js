/**
 * SLOs locais (Engine Ready). Valores iniciais — calibrar no Giovanna.
 */

export const DEFAULT_SLOS = Object.freeze({
  decisionP99Ms: 50,
  ingestP99Ms: 100,
  availabilityMin: 0.995,
  maxOrphanOrders: 0,
  maxRiskViolationsInSoak: 0,
});

/**
 * @param {object} metricsSnapshot
 * @param {object} [health]
 * @param {object} [slos]
 */
export function evaluateSlos(metricsSnapshot, health = {}, slos = DEFAULT_SLOS) {
  const checks = [];

  const decisionP99 = metricsSnapshot?.histograms?.decision_ms?.p99;
  checks.push({
    id: 'decision_p99',
    ok: decisionP99 == null || decisionP99 <= slos.decisionP99Ms,
    actual: decisionP99,
    target: slos.decisionP99Ms,
  });

  const ingestP99 = metricsSnapshot?.histograms?.ingest_ms?.p99;
  checks.push({
    id: 'ingest_p99',
    ok: ingestP99 == null || ingestP99 <= slos.ingestP99Ms,
    actual: ingestP99,
    target: slos.ingestP99Ms,
  });

  const availability = health.availability;
  checks.push({
    id: 'availability',
    ok: availability == null || availability >= slos.availabilityMin,
    actual: availability,
    target: slos.availabilityMin,
  });

  const orphans = health.orphanOrders ?? 0;
  checks.push({
    id: 'orphan_orders',
    ok: orphans <= slos.maxOrphanOrders,
    actual: orphans,
    target: slos.maxOrphanOrders,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    slos: { ...slos },
  };
}
