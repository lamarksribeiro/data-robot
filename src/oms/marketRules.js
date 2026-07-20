/**
 * Regras de mercado genéricas (tick / min size) — sem CLOB.
 */

export function quantizePrice(price, tickSize = 0.01) {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  const ticks = Math.round(price / tickSize);
  const q = ticks * tickSize;
  return Math.round(q * 1e8) / 1e8;
}

export function quantizeSize(size, minSize = 1, step = 1) {
  if (!Number.isFinite(size) || size <= 0) return null;
  const stepped = Math.floor(size / step) * step;
  if (stepped < minSize) return null;
  return stepped;
}

/**
 * @param {object} intent
 * @param {object} [rules]
 */
export function materializeOrderRequest(intent, rules = {}) {
  const tickSize = rules.tickSize ?? 0.01;
  const minSize = rules.minSize ?? 1;
  const sizeStep = rules.sizeStep ?? 1;

  let qty = intent.quantity;
  let price = intent.kind === 'EXIT' ? intent.minPrice ?? intent.maxPrice : intent.maxPrice ?? intent.minPrice;

  if ((qty == null || qty <= 0) && intent.budget != null && price != null && price > 0) {
    qty = intent.budget / price;
  }

  const qPrice = price != null ? quantizePrice(price, tickSize) : null;
  const qSize = qty != null ? quantizeSize(qty, minSize, sizeStep) : null;

  const side =
    intent.kind === 'EXIT'
      ? 'SELL'
      : intent.kind === 'CANCEL'
        ? null
        : 'BUY';

  const orderType = intent.orderType ?? rules.defaultOrderType ?? 'GTC';
  if (!['GTC', 'FAK', 'FOK'].includes(orderType)) {
    throw new Error(`orderType inválido: ${orderType}`);
  }

  return {
    intentId: intent.intentId,
    kind: intent.kind,
    marketId: intent.marketId,
    strategyInstanceId: intent.strategyInstanceId,
    tokenSide: intent.side,
    tokenId: intent.tokenId ?? null,
    tradeSide: side,
    orderType,
    price: qPrice,
    size: qSize,
    reason: intent.reason,
    valid:
      intent.kind === 'CANCEL' ||
      (qSize != null && qSize > 0 && (intent.kind === 'EXIT' ? true : qPrice != null)),
  };
}
