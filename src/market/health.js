/**
 * Limites iniciais de staleness (plano §5). Recalibrar com dados de produção.
 */

export const STALENESS = Object.freeze({
  rtdsMaxLagMs: 2000,
  clobMaxLagMs: 3000,
  clockSkewMaxMs: 5000,
});

/**
 * BTC 5m pode ter book quieto sem estar desconectado. Estes limites foram
 * calibrados na campanha shadow e são usados pelo hub operacional BTC 5m.
 */
export const BTC5M_STALENESS = Object.freeze({
  rtdsMaxLagMs: 8000,
  clobMaxLagMs: 15000,
  clockSkewMaxMs: 5000,
});

/**
 * @param {object} feeds
 * @param {object} [limits]
 */
export function evaluateFeedHealth(feeds, limits = STALENESS) {
  const rtdsLagMs = feeds?.rtdsLagMs ?? null;
  const clobLagMs = feeds?.clobLagMs ?? null;
  const reasons = [];

  if (feeds?.rtdsConnected === false) reasons.push('RTDS_DISCONNECTED');
  if (feeds?.clobConnected === false) reasons.push('CLOB_DISCONNECTED');

  if (rtdsLagMs == null) reasons.push('RTDS_NO_SAMPLE');
  else if (rtdsLagMs > limits.rtdsMaxLagMs) reasons.push('RTDS_STALE');

  if (clobLagMs == null) reasons.push('CLOB_NO_SAMPLE');
  else if (clobLagMs > limits.clobMaxLagMs) reasons.push('CLOB_STALE');

  return {
    ok: reasons.length === 0,
    reasons,
    rtdsLagMs,
    clobLagMs,
    limits: { ...limits },
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
