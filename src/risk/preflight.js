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
  const checks = { ...(opts.checks ?? {}) };
  const requiredLiveChecks = ['auth', 'geoblock', 'clock', 'balance'];

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

    const names = new Set([
      ...Object.keys(checks),
      ...(ctx.mode === 'live' ? requiredLiveChecks : []),
    ]);

    for (const name of names) {
      const fn = checks[name];
      if (typeof fn !== 'function') {
        const missing = { ok: false, missing: true, reason: 'CHECK_NOT_CONFIGURED' };
        results[name] = missing;
        failures.push({
          check: name,
          reasonCode:
            name === 'auth'
              ? RISK_REASON.PREFLIGHT_AUTH
              : name === 'geoblock'
                ? RISK_REASON.PREFLIGHT_GEOBLOCK
                : name === 'clock'
                  ? RISK_REASON.PREFLIGHT_CLOCK
                  : RISK_REASON.PREFLIGHT_BALANCE,
          detail: missing,
        });
        continue;
      }
      const r = fn(ctx) ?? { ok: false };
      if (r && typeof r.then === 'function') {
        throw new Error(`preflight check ${name} retornou Promise; injete resultado previamente validado`);
      }
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
