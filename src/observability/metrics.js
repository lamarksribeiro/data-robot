/**
 * Métricas em memória — counters + histogramas com p50/p95/p99.
 */

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function createMetrics(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  /** @type {Record<string, number>} */
  const counters = {};
  /** @type {Record<string, number[]>} */
  const histograms = {};
  /** @type {Record<string, number>} */
  const gauges = {};

  return {
    inc(name, by = 1) {
      counters[name] = (counters[name] ?? 0) + by;
    },

    observe(name, valueMs) {
      const v = Number(valueMs);
      if (!Number.isFinite(v)) return;
      if (!histograms[name]) histograms[name] = [];
      histograms[name].push(v);
      // cap memória
      if (histograms[name].length > 5000) {
        histograms[name] = histograms[name].slice(-2500);
      }
    },

    gauge(name, value) {
      gauges[name] = Number(value);
    },

    timing(name, startMs) {
      this.observe(name, clock() - startMs);
    },

    snapshot() {
      const hist = {};
      for (const [name, samples] of Object.entries(histograms)) {
        const sorted = [...samples].sort((a, b) => a - b);
        hist[name] = {
          count: sorted.length,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.length ? sorted[sorted.length - 1] : null,
        };
      }
      return {
        tsMs: clock(),
        counters: { ...counters },
        gauges: { ...gauges },
        histograms: hist,
      };
    },

    reset() {
      for (const k of Object.keys(counters)) delete counters[k];
      for (const k of Object.keys(histograms)) delete histograms[k];
      for (const k of Object.keys(gauges)) delete gauges[k];
    },
  };
}
