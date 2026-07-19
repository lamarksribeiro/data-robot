/**
 * Circuit breaker — abre após N falhas consecutivas.
 */

export function createCircuitBreaker(opts = {}) {
  const failureThreshold = opts.failureThreshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const clock = opts.clock ?? (() => Date.now());

  let consecutiveFailures = 0;
  let openedAtMs = null;

  return {
    get state() {
      if (openedAtMs == null) return 'CLOSED';
      if (clock() - openedAtMs >= cooldownMs) return 'HALF_OPEN';
      return 'OPEN';
    },

    get consecutiveFailures() {
      return consecutiveFailures;
    },

    recordSuccess() {
      consecutiveFailures = 0;
      openedAtMs = null;
    },

    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        openedAtMs = clock();
      }
    },

    /**
     * @returns {{ allow: boolean, reasonCode?: string, detail?: object }}
     */
    evaluate() {
      const s = this.state;
      if (s === 'OPEN') {
        return {
          allow: false,
          reasonCode: 'CIRCUIT_OPEN',
          detail: { consecutiveFailures, openedAtMs, cooldownMs },
        };
      }
      return { allow: true };
    },

    snapshot() {
      return { consecutiveFailures, openedAtMs, failureThreshold, cooldownMs };
    },

    restore(snap) {
      consecutiveFailures = snap?.consecutiveFailures ?? 0;
      openedAtMs = snap?.openedAtMs ?? null;
    },
  };
}
