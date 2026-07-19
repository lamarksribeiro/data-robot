/**
 * User channel — fonte primária de eventos de ordem (plano P3).
 * sim: emite o que o transport já devolveu (passthrough)
 * rest-poll: stub de fallback
 * ws: stub autenticado (estrutura)
 */

/**
 * @param {object} [opts]
 * @param {'sim'|'rest-poll'|'ws'} [opts.kind]
 */
export function createUserChannel(opts = {}) {
  const kind = opts.kind ?? 'sim';
  const listeners = new Set();
  let heartbeatTimer = null;
  let lastHeartbeatMs = null;
  let connected = false;

  function emit(event) {
    for (const fn of listeners) fn(event);
  }

  return {
    kind,
    get connected() {
      return connected;
    },
    get lastHeartbeatMs() {
      return lastHeartbeatMs;
    },

    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Injeta evento (sim / testes / bridge do transport). */
    push(event) {
      emit(event);
    },

    connect() {
      connected = true;
      lastHeartbeatMs = Date.now();
      return { ok: true, kind };
    },

    disconnect({ cancelOnDisconnect = true } = {}) {
      connected = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      return { ok: true, cancelOnDisconnect };
    },

    startHeartbeat(intervalMs = 10_000, onBeat) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        lastHeartbeatMs = Date.now();
        if (typeof onBeat === 'function') onBeat(lastHeartbeatMs);
      }, intervalMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
      return () => {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };
    },

    /**
     * Fallback REST — stub que não chama rede.
     * @param {() => Promise<object[]>} [fetcher]
     */
    async pollRest(fetcher) {
      if (kind === 'ws' && !fetcher) {
        return { ok: false, reason: 'WS_PRIMARY_NO_FETCHER' };
      }
      if (!fetcher) {
        return { ok: true, events: [], source: 'rest-poll-empty' };
      }
      const events = await fetcher();
      for (const e of events ?? []) emit(e);
      return { ok: true, events, source: 'rest-poll' };
    },
  };
}
