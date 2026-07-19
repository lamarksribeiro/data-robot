/**
 * Kill switch — bloqueia entradas, cancela resting, não liquida cego.
 */

export function createKillSwitch(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  let active = false;
  let reason = null;
  let activatedAtMs = null;
  const listeners = new Set();

  return {
    get active() {
      return active;
    },
    get reason() {
      return reason;
    },
    get activatedAtMs() {
      return activatedAtMs;
    },

    onActivate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * @param {string} [why]
     */
    trip(why = 'kill') {
      if (active) return { already: true, reason };
      active = true;
      reason = why;
      activatedAtMs = clock();
      for (const fn of listeners) fn({ reason, activatedAtMs });
      return { already: false, reason, activatedAtMs };
    },

    reset() {
      active = false;
      reason = null;
      activatedAtMs = null;
    },

    snapshot() {
      return { active, reason, activatedAtMs };
    },

    restore(snap) {
      active = Boolean(snap?.active);
      reason = snap?.reason ?? null;
      activatedAtMs = snap?.activatedAtMs ?? null;
    },
  };
}
