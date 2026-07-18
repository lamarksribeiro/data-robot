/**
 * Schemas runtime do kernel (P1).
 * Tipos documentados via JSDoc; validação leve em runtime.
 */

export const ENGINE_STATES = Object.freeze([
  'BOOT',
  'ACCOUNT_READY',
  'MARKET_SYNCING',
  'OBSERVING',
  'ARMED',
  'ENTRY_PENDING',
  'POSITION_OPEN',
  'EXIT_PENDING',
  'REVERSE_PENDING',
  'HALTED',
]);

export const INTENT_KINDS = Object.freeze(['ENTER', 'EXIT', 'REVERSE', 'CANCEL']);

export const EXECUTION_MODES = Object.freeze(['dry-run', 'shadow', 'live']);

/**
 * @typedef {'UP'|'DOWN'} Side
 *
 * @typedef {object} MarketSnapshot
 * @property {string} marketId
 * @property {number} nowMs
 * @property {number|null} secsLeft
 * @property {number|null} btc
 * @property {number|null} priceToBeat
 * @property {{ up?: BookSide, down?: BookSide }} book
 * @property {{ rtdsLagMs?: number|null, clobLagMs?: number|null, healthy?: boolean }} [feeds]
 * @property {boolean} [acceptingOrders]
 *
 * @typedef {object} BookSide
 * @property {number|null} [bestBid]
 * @property {number|null} [bestAsk]
 * @property {Array<{price?: number, size?: number}>} [bids]
 * @property {Array<{price?: number, size?: number}>} [asks]
 *
 * @typedef {object} PositionView
 * @property {string|null} marketId
 * @property {Side|null} side
 * @property {number} qty
 * @property {number|null} avgPrice
 * @property {number} realizedPnl
 *
 * @typedef {object} TradeIntent
 * @property {string} intentId
 * @property {'ENTER'|'EXIT'|'REVERSE'|'CANCEL'} kind
 * @property {Side|null} side
 * @property {string} marketId
 * @property {string} strategyInstanceId
 * @property {number|null} [budget]
 * @property {number|null} [quantity]
 * @property {number|null} [maxPrice]
 * @property {number|null} [minPrice]
 * @property {number|null} [deadlineMs]
 * @property {string} reason
 * @property {string} [presetId]
 *
 * @typedef {object} ExecutionEvent
 * @property {string} eventId
 * @property {string} [intentId]
 * @property {'ACK'|'PARTIAL'|'FILL'|'CANCEL'|'REJECT'|'UNKNOWN'} type
 * @property {Side|null} [side]
 * @property {number|null} [qty]
 * @property {number|null} [price]
 * @property {string} [reason]
 * @property {number} tsMs
 *
 * @typedef {object} StrategyResult
 * @property {object} state
 * @property {TradeIntent[]} intents
 * @property {object} diagnostics
 */

/**
 * @param {unknown} snap
 * @returns {asserts snap is MarketSnapshot}
 */
export function assertMarketSnapshot(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('MarketSnapshot inválido');
  if (typeof snap.marketId !== 'string' || !snap.marketId) {
    throw new Error('MarketSnapshot.marketId obrigatório');
  }
  if (typeof snap.nowMs !== 'number' || !Number.isFinite(snap.nowMs)) {
    throw new Error('MarketSnapshot.nowMs inválido');
  }
  if (!snap.book || typeof snap.book !== 'object') {
    throw new Error('MarketSnapshot.book obrigatório');
  }
}

/**
 * @param {unknown} intent
 * @returns {asserts intent is TradeIntent}
 */
export function assertTradeIntent(intent) {
  if (!intent || typeof intent !== 'object') throw new Error('TradeIntent inválido');
  if (typeof intent.intentId !== 'string' || !intent.intentId) {
    throw new Error('TradeIntent.intentId obrigatório');
  }
  if (!INTENT_KINDS.includes(intent.kind)) {
    throw new Error(`TradeIntent.kind inválido: ${intent.kind}`);
  }
  if (typeof intent.marketId !== 'string' || !intent.marketId) {
    throw new Error('TradeIntent.marketId obrigatório');
  }
  if (typeof intent.strategyInstanceId !== 'string' || !intent.strategyInstanceId) {
    throw new Error('TradeIntent.strategyInstanceId obrigatório');
  }
  if (typeof intent.reason !== 'string') {
    throw new Error('TradeIntent.reason obrigatório');
  }
}

/**
 * @param {unknown} result
 * @returns {asserts result is StrategyResult}
 */
export function assertStrategyResult(result) {
  if (!result || typeof result !== 'object') throw new Error('StrategyResult inválido');
  if (!result.state || typeof result.state !== 'object') {
    throw new Error('StrategyResult.state deve ser objeto serializável');
  }
  if (!Array.isArray(result.intents)) {
    throw new Error('StrategyResult.intents deve ser array');
  }
  for (const intent of result.intents) assertTradeIntent(intent);
  if (!result.diagnostics || typeof result.diagnostics !== 'object') {
    throw new Error('StrategyResult.diagnostics deve ser objeto');
  }
}

/**
 * @param {Partial<PositionView>} [partial]
 * @returns {PositionView}
 */
export function emptyPosition(partial = {}) {
  return {
    marketId: partial.marketId ?? null,
    side: partial.side ?? null,
    qty: partial.qty ?? 0,
    avgPrice: partial.avgPrice ?? null,
    realizedPnl: partial.realizedPnl ?? 0,
  };
}

/**
 * Gera intentId determinístico para idempotência.
 */
export function makeIntentId({ strategyInstanceId, marketId, kind, seq }) {
  return `${strategyInstanceId}:${marketId}:${kind}:${seq}`;
}
