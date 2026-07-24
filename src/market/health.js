/**
 * Limites de staleness e avaliação de saúde de feeds.
 * Trading (elegibilidade de snapshot) vs processo (engine degradada) usam thresholds diferentes:
 * o processo não deve "piscar" degraded em ruído de 1–2 ticks.
 */

export const STALENESS = Object.freeze({
  rtdsMaxLagMs: 2000,
  clobMaxLagMs: 3000,
  clockSkewMaxMs: 5000,
});

/**
 * BTC 5m: book pode ficar quieto sem desconexão.
 * Calibrado para shadow/live operacional.
 */
export const BTC5M_STALENESS = Object.freeze({
  rtdsMaxLagMs: 10_000,
  clobMaxLagMs: 20_000,
  clockSkewMaxMs: 5000,
});

/**
 * Limites duros do *processo* — só degrada engine se algo estiver realmente quebrado.
 * Mais tolerantes que elegibilidade de trade.
 */
export const BTC5M_PROCESS_STALENESS = Object.freeze({
  rtdsMaxLagMs: 30_000,
  clobMaxLagMs: 45_000,
  clockSkewMaxMs: 8000,
  /** Após connect, aguarda sample antes de acusar NO_SAMPLE. */
  connectGraceMs: 12_000,
  /** Quantos ticks ruins consecutivos para marcar processo unhealthy. */
  failStreakToDegrade: 5,
  /** Quantos ticks bons para recuperar de degraded. */
  okStreakToRecover: 2,
});

/**
 * @param {object} feeds
 * @param {object} [limits]
 * @param {{ mode?: 'trading'|'process', nowMs?: number, connectedSinceMs?: { rtds?: number|null, clob?: number|null } }} [opts]
 */
export function evaluateFeedHealth(feeds, limits = STALENESS, opts = {}) {
  const mode = opts.mode === 'process' ? 'process' : 'trading';
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const processLimits =
    mode === 'process'
      ? {
          ...BTC5M_PROCESS_STALENESS,
          ...limits,
          rtdsMaxLagMs: Math.max(
            Number(limits.rtdsMaxLagMs) || BTC5M_PROCESS_STALENESS.rtdsMaxLagMs,
            BTC5M_PROCESS_STALENESS.rtdsMaxLagMs,
          ),
          clobMaxLagMs: Math.max(
            Number(limits.clobMaxLagMs) || BTC5M_PROCESS_STALENESS.clobMaxLagMs,
            BTC5M_PROCESS_STALENESS.clobMaxLagMs,
          ),
        }
      : limits;

  const rtdsLagMs = feeds?.rtdsLagMs ?? null;
  const clobLagMs = feeds?.clobLagMs ?? null;
  const reasons = [];
  const softReasons = [];

  const rtdsConnected = feeds?.rtdsConnected !== false;
  const clobConnected = feeds?.clobConnected !== false;

  if (!rtdsConnected) reasons.push('RTDS_DISCONNECTED');
  if (!clobConnected) reasons.push('CLOB_DISCONNECTED');

  const rtdsSince = opts.connectedSinceMs?.rtds;
  const clobSince = opts.connectedSinceMs?.clob;
  const grace = Number(processLimits.connectGraceMs ?? BTC5M_PROCESS_STALENESS.connectGraceMs);

  if (rtdsLagMs == null) {
    const inGrace =
      mode === 'process' &&
      rtdsConnected &&
      Number.isFinite(rtdsSince) &&
      nowMs - rtdsSince < grace;
    if (inGrace) softReasons.push('RTDS_CONNECT_GRACE');
    else reasons.push('RTDS_NO_SAMPLE');
  } else if (rtdsLagMs > processLimits.rtdsMaxLagMs) {
    reasons.push('RTDS_STALE');
  } else if (mode === 'process' && rtdsLagMs > (limits.rtdsMaxLagMs ?? processLimits.rtdsMaxLagMs)) {
    softReasons.push('RTDS_SOFT_STALE');
  }

  // Book quieto: se WS CLOB conectado e já há top-of-book, não trate lag moderado como morte do processo.
  const clobHasBook = feeds?.clobHasBook === true;
  if (clobLagMs == null) {
    const inGrace =
      mode === 'process' &&
      clobConnected &&
      Number.isFinite(clobSince) &&
      nowMs - clobSince < grace;
    if (inGrace || (mode === 'process' && clobConnected && clobHasBook)) {
      softReasons.push(inGrace ? 'CLOB_CONNECT_GRACE' : 'CLOB_BOOK_HELD');
    } else {
      reasons.push('CLOB_NO_SAMPLE');
    }
  } else if (clobLagMs > processLimits.clobMaxLagMs) {
    reasons.push('CLOB_STALE');
  } else if (
    mode === 'process' &&
    clobLagMs > (limits.clobMaxLagMs ?? processLimits.clobMaxLagMs) &&
    !(clobConnected && clobHasBook)
  ) {
    softReasons.push('CLOB_SOFT_STALE');
  } else if (
    mode === 'trading' &&
    clobLagMs > processLimits.clobMaxLagMs * 0 // keep trading path using processLimits which equals limits when trading
  ) {
    /* trading uses limits as processLimits assignment above when mode trading */
  }

  // Trading: re-eval with strict limits only
  if (mode === 'trading') {
    const tradingReasons = [];
    if (feeds?.rtdsConnected === false) tradingReasons.push('RTDS_DISCONNECTED');
    if (feeds?.clobConnected === false) tradingReasons.push('CLOB_DISCONNECTED');
    if (rtdsLagMs == null) tradingReasons.push('RTDS_NO_SAMPLE');
    else if (rtdsLagMs > limits.rtdsMaxLagMs) tradingReasons.push('RTDS_STALE');
    if (clobLagMs == null) tradingReasons.push('CLOB_NO_SAMPLE');
    else if (clobLagMs > limits.clobMaxLagMs) tradingReasons.push('CLOB_STALE');
    return {
      ok: tradingReasons.length === 0,
      reasons: tradingReasons,
      softReasons: [],
      rtdsLagMs,
      clobLagMs,
      limits: { ...limits },
      mode,
    };
  }

  return {
    ok: reasons.length === 0,
    reasons,
    softReasons,
    rtdsLagMs,
    clobLagMs,
    limits: { ...processLimits },
    mode,
  };
}

/**
 * Histerese para não alternar degraded a cada tick.
 */
export function createFeedHealthGate(opts = {}) {
  const failToDegrade = Number(opts.failStreakToDegrade ?? BTC5M_PROCESS_STALENESS.failStreakToDegrade);
  const okToRecover = Number(opts.okStreakToRecover ?? BTC5M_PROCESS_STALENESS.okStreakToRecover);
  let failStreak = 0;
  let okStreak = 0;
  let healthy = true;
  let lastRaw = true;
  let lastReason = null;

  return {
    /**
     * @param {boolean} rawOk
     * @param {string|null} [reason]
     * @param {{ hardFail?: boolean }} [flags]
     */
    observe(rawOk, reason = null, flags = {}) {
      lastRaw = rawOk;
      lastReason = reason;
      if (flags.hardFail) {
        failStreak = failToDegrade;
        okStreak = 0;
        healthy = false;
        return this.snapshot();
      }
      if (rawOk) {
        okStreak += 1;
        failStreak = 0;
        if (!healthy && okStreak >= okToRecover) healthy = true;
        if (healthy) okStreak = Math.min(okStreak, okToRecover);
      } else {
        failStreak += 1;
        okStreak = 0;
        if (healthy && failStreak >= failToDegrade) healthy = false;
      }
      return this.snapshot();
    },
    snapshot() {
      return {
        healthy,
        rawOk: lastRaw,
        failStreak,
        okStreak,
        reason: healthy ? null : lastReason,
      };
    },
    reset(ok = true) {
      healthy = ok;
      failStreak = 0;
      okStreak = ok ? okToRecover : 0;
      lastRaw = ok;
      lastReason = null;
    },
  };
}

/**
 * @param {number} localNowMs
 * @param {number|null} serverNowMs
 * @param {number} [maxSkewMs]
 */
export function evaluateClockSkew(localNowMs, serverNowMs, maxSkewMs = STALENESS.clockSkewMaxMs) {
  if (serverNowMs == null || !Number.isFinite(serverNowMs)) {
    return { ok: true, skewMs: null, reason: 'NO_SERVER_CLOCK' };
  }
  const skewMs = Math.abs(localNowMs - serverNowMs);
  return {
    ok: skewMs <= maxSkewMs,
    skewMs,
    reason: skewMs > maxSkewMs ? 'CLOCK_SKEW' : null,
  };
}
