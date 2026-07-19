/**
 * Trilha de auditoria de bloqueios / kills (sem secrets).
 */

export function createRiskAudit(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  /** @type {object[]} */
  const entries = [];
  /** @type {Record<string, number>} */
  const metrics = {};

  function bump(reasonCode) {
    metrics[reasonCode] = (metrics[reasonCode] ?? 0) + 1;
  }

  return {
    /**
     * @param {object} row
     */
    record(row) {
      const entry = {
        tsMs: clock(),
        allow: row.allow !== false,
        reasonCode: row.reasonCode ?? 'UNKNOWN',
        intentId: row.intentId ?? null,
        strategyInstanceId: row.strategyInstanceId ?? null,
        detail: row.detail ?? null,
      };
      entries.push(entry);
      if (!entry.allow) bump(entry.reasonCode);
      return entry;
    },

    list() {
      return entries.map((e) => ({ ...e }));
    },

    metrics() {
      return { ...metrics };
    },

    clear() {
      entries.length = 0;
      for (const k of Object.keys(metrics)) delete metrics[k];
    },
  };
}
