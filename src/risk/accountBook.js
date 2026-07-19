/**
 * Livro de exposição agregada da conta (multi-instância / multi-estratégia).
 */

export function createAccountRiskBook(opts = {}) {
  const maxExposure = opts.maxAccountExposure ?? 100;
  /** @type {Map<string, number>} instanceId → notional aberto reservado/real */
  const byInstance = new Map();

  function total() {
    let sum = 0;
    for (const v of byInstance.values()) sum += v;
    return sum;
  }

  return {
    get maxAccountExposure() {
      return maxExposure;
    },

    getExposure(instanceId) {
      return byInstance.get(instanceId) ?? 0;
    },

    totalExposure() {
      return total();
    },

    /**
     * Testa se caberia sem reservar.
     */
    wouldExceed(notional) {
      const n = Number(notional) || 0;
      return total() + n > maxExposure;
    },

    /**
     * Reserva notional para uma nova entrada (falha se estourar global).
     * @returns {{ ok: boolean, total: number, max: number }}
     */
    tryReserve(instanceId, notional) {
      const n = Number(notional) || 0;
      if (n <= 0) return { ok: true, total: total(), max: maxExposure };
      if (this.wouldExceed(n)) {
        return { ok: false, total: total(), max: maxExposure, wouldBe: total() + n };
      }
      byInstance.set(instanceId, (byInstance.get(instanceId) ?? 0) + n);
      return { ok: true, total: total(), max: maxExposure };
    },

    release(instanceId, notional) {
      const n = Number(notional) || 0;
      const cur = byInstance.get(instanceId) ?? 0;
      const next = Math.max(0, cur - n);
      if (next === 0) byInstance.delete(instanceId);
      else byInstance.set(instanceId, next);
    },

    set(instanceId, notional) {
      const n = Math.max(0, Number(notional) || 0);
      if (n === 0) byInstance.delete(instanceId);
      else byInstance.set(instanceId, n);
    },

    snapshot() {
      return {
        maxAccountExposure: maxExposure,
        total: total(),
        byInstance: Object.fromEntries(byInstance),
      };
    },

    restore(snap) {
      byInstance.clear();
      for (const [k, v] of Object.entries(snap?.byInstance ?? {})) {
        byInstance.set(k, Number(v) || 0);
      }
    },
  };
}
