/**
 * Preflight fail-closed — checks injetáveis (sem rede obrigatória nos testes).
 */

import { RISK_REASON } from './reasons.js';

/**
 * @param {object} [opts]
 * @param {object} [opts.checks] — funções () => ({ ok, reason?, detail? })
 * @param {boolean} [opts.liveEnabled] — default false
 */
export function createPreflight(opts = {}) {
  const liveEnabled = opts.liveEnabled === true;
  const checks = {
    auth: opts.checks?.auth ?? (() => ({ ok: true })),
    geoblock: opts.checks?.geoblock ?? (() => ({ ok: true, blocked: false })),
    clock: opts.checks?.clock ?? (() => ({ ok: true, skewMs: 0 })),
    balance: opts.checks?.balance ?? (() => ({ ok: true, balance: Infinity })),
    ...opts.checks,
  };

  /**
   * @param {{ mode?: string }} [ctx]
   */
  function run(ctx = {}) {
    const results = {};
    const failures = [];

    if (ctx.mode === 'live' && !liveEnabled) {
      failures.push({
        check: 'live',
        reasonCode: RISK_REASON.LIVE_DISABLED,
        detail: { liveEnabled: false },
      });
    }

    for (const [name, fn] of Object.entries(checks)) {
      const r = fn(ctx) ?? { ok: false };
      results[name] = r;
      if (!r.ok) {
        const reasonCode =
          name === 'auth'
            ? RISK_REASON.PREFLIGHT_AUTH
            : name === 'geoblock'
              ? RISK_REASON.PREFLIGHT_GEOBLOCK
              : name === 'clock'
                ? RISK_REASON.PREFLIGHT_CLOCK
                : name === 'balance'
                  ? RISK_REASON.PREFLIGHT_BALANCE
                  : RISK_REASON.PREFLIGHT_ELIGIBILITY;
        failures.push({ check: name, reasonCode, detail: r });
      }
      if (name === 'geoblock' && r.blocked === true) {
        failures.push({
          check: 'geoblock',
          reasonCode: RISK_REASON.PREFLIGHT_GEOBLOCK,
          detail: r,
        });
      }
    }

    // dedupe by reasonCode+check
    const seen = new Set();
    const uniq = [];
    for (const f of failures) {
      const key = `${f.check}:${f.reasonCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(f);
    }

    return {
      ok: uniq.length === 0,
      failures: uniq,
      results,
      liveEnabled,
    };
  }

  return { run, liveEnabled, checks };
}
