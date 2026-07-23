/**
 * Resolve preço de settlement ($0/$1) de mercado binário Polymarket via Gamma.
 */

/**
 * @param {string} marketId slug (ex.: btc-updown-5m-1784793300)
 * @param {'UP'|'DOWN'|string} side
 * @param {{ fetchFn?: typeof fetch, gammaBase?: string }} [opts]
 * @returns {Promise<{ ok: boolean, closed?: boolean, settlementPrice?: number, winner?: string|null, reason?: string }>}
 */
export async function resolveBinarySettlementPrice(marketId, side, opts = {}) {
  const slug = String(marketId || '').trim();
  if (!slug) return { ok: false, reason: 'MISSING_MARKET_ID' };
  const fetchFn = opts.fetchFn ?? fetch;
  const gammaBase = opts.gammaBase ?? 'https://gamma-api.polymarket.com';
  const url = `${gammaBase}/events?slug=${encodeURIComponent(slug)}`;
  let payload;
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `GAMMA_HTTP_${res.status}` };
    payload = await res.json();
  } catch (error) {
    return { ok: false, reason: error?.message || 'GAMMA_FETCH_FAILED' };
  }
  const event = Array.isArray(payload) ? payload[0] : payload;
  if (!event) return { ok: false, reason: 'GAMMA_NOT_FOUND' };
  const market = Array.isArray(event.markets) ? event.markets[0] : null;
  if (!market) return { ok: false, reason: 'GAMMA_NO_MARKET' };
  const closed = event.closed === true || market.closed === true;
  if (!closed) return { ok: false, closed: false, reason: 'MARKET_STILL_OPEN' };

  let outcomes = market.outcomes;
  let prices = market.outcomePrices;
  try {
    if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
    if (typeof prices === 'string') prices = JSON.parse(prices);
  } catch {
    return { ok: false, closed: true, reason: 'GAMMA_PARSE_FAILED' };
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== prices.length) {
    return { ok: false, closed: true, reason: 'GAMMA_OUTCOMES_INVALID' };
  }

  const sideKey = String(side || '').toUpperCase();
  const aliases =
    sideKey === 'UP'
      ? ['UP', 'YES', 'HIGHER']
      : sideKey === 'DOWN'
        ? ['DOWN', 'NO', 'LOWER']
        : [sideKey];
  const idx = outcomes.findIndex((o) => aliases.includes(String(o).toUpperCase()));
  if (idx < 0) return { ok: false, closed: true, reason: 'SIDE_NOT_IN_OUTCOMES' };
  const settlementPrice = Number(prices[idx]);
  if (!Number.isFinite(settlementPrice)) {
    return { ok: false, closed: true, reason: 'PRICE_INVALID' };
  }
  const winnerIdx = prices.findIndex((p) => Number(p) >= 0.99);
  return {
    ok: true,
    closed: true,
    settlementPrice,
    winner: winnerIdx >= 0 ? String(outcomes[winnerIdx]) : null,
  };
}
