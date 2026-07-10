/**
 * Modelo de taxa Polymarket (taker) alinhado ao data-backtest.
 * Fórmula: shares * feeRate * price * (1 - price)
 * Maker: taxa 0 (protocolo não cobra maker).
 */

export const CRYPTO_TAKER_FEE_RATE = 0.07;

export function calculateTakerFee({ shares, price, feeRate = CRYPTO_TAKER_FEE_RATE } = {}) {
  const qty = Number(shares);
  const p = Number(price);
  const rate = Number(feeRate);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return roundFee(qty * rate * p * (1 - p));
}

export function roundFee(value) {
  return Math.round(Number(value) * 1e5) / 1e5;
}

export function summarizeTradeFees(trades, { feeRate = CRYPTO_TAKER_FEE_RATE } = {}) {
  const rows = [];
  let expectedTakerFee = 0;
  let makerCount = 0;
  let takerCount = 0;

  for (const trade of trades ?? []) {
    const shares = Number(trade.size ?? trade.shares ?? 0);
    const price = Number(trade.price ?? 0);
    const side = String(trade.trader_side ?? trade.liquidity ?? '').toUpperCase();
    const isMaker = side === 'MAKER';
    const isTaker = side === 'TAKER';
    const expected = isMaker ? 0 : calculateTakerFee({ shares, price, feeRate });

    if (isMaker) makerCount += 1;
    if (isTaker) takerCount += 1;
    expectedTakerFee = roundFee(expectedTakerFee + expected);

    rows.push({
      id: trade.id ?? null,
      traderSide: side || null,
      price,
      shares,
      feeRateBps: trade.fee_rate_bps ?? null,
      expectedFeeUsd: expected,
      matchTime: trade.match_time ?? null,
      status: trade.status ?? null,
    });
  }

  return {
    trades: rows,
    makerCount,
    takerCount,
    expectedTakerFeeUsd: expectedTakerFee,
    expectedMakerFeeUsd: 0,
  };
}
