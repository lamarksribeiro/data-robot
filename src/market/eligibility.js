/**
 * Elegibilidade de snapshot para decisão (fail-closed).
 */

import { evaluateClockSkew, evaluateFeedHealth, STALENESS } from './health.js';

/**
 * @param {object} snapshot — buildMarketSnapshot
 * @param {object} [opts]
 * @param {string|null} [opts.expectedMarketId]
 * @param {string|null} [opts.expectedUpTokenId]
 * @param {string|null} [opts.expectedDownTokenId]
 * @param {boolean} [opts.requireAcceptingOrders]
 * @param {number} [opts.minSecsLeft] — default 5 (plano: sem entrada &lt;5s)
 * @param {object} [opts.healthLimits]
 */
export function evaluateSnapshotEligibility(snapshot, opts = {}) {
  const reasons = [];
  const limits = opts.healthLimits ?? STALENESS;

  if (!snapshot?.marketId) reasons.push('NO_MARKET_ID');
  if (snapshot?.btc == null || !Number.isFinite(Number(snapshot.btc))) {
    reasons.push('NO_REFERENCE_PRICE');
  }
  if (snapshot?.priceToBeat == null || !Number.isFinite(Number(snapshot.priceToBeat))) {
    reasons.push('NO_PRICE_TO_BEAT');
  }

  if (opts.expectedMarketId && snapshot.marketId !== opts.expectedMarketId) {
    reasons.push('MARKET_ID_MISMATCH');
  }

  const up = snapshot.identity?.upTokenId;
  const down = snapshot.identity?.downTokenId;
  if (opts.expectedUpTokenId && up !== opts.expectedUpTokenId) {
    reasons.push('UP_TOKEN_MISMATCH');
  }
  if (opts.expectedDownTokenId && down !== opts.expectedDownTokenId) {
    reasons.push('DOWN_TOKEN_MISMATCH');
  }

  const health = snapshot.health ?? evaluateFeedHealth(snapshot.feeds ?? {}, limits);
  if (!health.ok) {
    for (const r of health.reasons) reasons.push(r);
  }

  const clock = evaluateClockSkew(snapshot.nowMs, snapshot.serverNowMs ?? null, limits.clockSkewMaxMs);
  if (!clock.ok) reasons.push(clock.reason);

  if (opts.requireAcceptingOrders !== false && snapshot.acceptingOrders !== true) {
    reasons.push('NOT_ACCEPTING_ORDERS');
  }

  const minSecsLeft = opts.minSecsLeft ?? 5;
  if (snapshot.secsLeft != null && snapshot.secsLeft < minSecsLeft) {
    reasons.push('BELOW_MIN_SECS_LEFT');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    health,
    clock,
  };
}
