/**
 * Alertas operacionais baseados em métricas / health.
 */

/**
 * @param {object} [opts]
 * @param {Array<{ id: string, when: (ctx: object) => boolean, severity?: string, message: string }>} [opts.rules]
 */
export function createAlertHub(opts = {}) {
  const rules = opts.rules ?? defaultRules();
  /** @type {object[]} */
  const fired = [];
  const listeners = new Set();

  function emit(alert) {
    fired.push(alert);
    for (const fn of listeners) fn(alert);
  }

  return {
    onAlert(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * @param {object} ctx — { metrics, health, engineStatus }
     */
    evaluate(ctx) {
      const out = [];
      for (const rule of rules) {
        try {
          if (rule.when(ctx)) {
            const alert = {
              id: rule.id,
              severity: rule.severity ?? 'warning',
              message: rule.message,
              tsMs: Date.now(),
            };
            emit(alert);
            out.push(alert);
          }
        } catch {
          // regra não derruba o hub
        }
      }
      return out;
    },

    list() {
      return fired.map((a) => ({ ...a }));
    },

    clear() {
      fired.length = 0;
    },
  };
}

function defaultRules() {
  return [
    {
      id: 'engine_halted',
      severity: 'critical',
      message: 'Engine em HALTED',
      when: (ctx) => ctx.engineStatus?.state === 'HALTED',
    },
    {
      id: 'kill_active',
      severity: 'critical',
      message: 'Kill switch ativo',
      when: (ctx) => ctx.engineStatus?.killActive === true,
    },
    {
      id: 'feed_unhealthy',
      severity: 'warning',
      message: 'Feeds unhealthy',
      when: (ctx) => ctx.health?.feedsOk === false,
    },
    {
      id: 'decision_p99_high',
      severity: 'warning',
      message: 'Decisão p99 acima do SLO',
      when: (ctx) => {
        const p99 = ctx.metrics?.histograms?.decision_ms?.p99;
        const slo = ctx.slos?.decisionP99Ms ?? 50;
        return p99 != null && p99 > slo;
      },
    },
    {
      id: 'orphan_orders',
      severity: 'critical',
      message: 'Ordens órfãs detectadas',
      when: (ctx) => (ctx.health?.orphanOrders ?? 0) > 0,
    },
  ];
}
