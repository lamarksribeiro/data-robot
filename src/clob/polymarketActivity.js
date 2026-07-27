/**
 * Activity da Data API Polymarket (TRADE / REDEEM) — fonte de caixa real para PnL.
 */

/**
 * @param {{
 *   funderAddress: string,
 *   fetchFn?: typeof fetch,
 *   dataApiBase?: string,
 *   timeoutMs?: number,
 *   limit?: number,
 * }} opts
 * @returns {Promise<object[]>}
 */
export async function fetchPolymarketActivity(opts) {
  const funder = String(opts?.funderAddress ?? '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(funder)) return [];
  const fetchFn = opts.fetchFn ?? fetch;
  const base = String(opts.dataApiBase ?? 'https://data-api.polymarket.com').replace(/\/$/, '');
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 200) || 200));
  try {
    const response = await fetchFn(
      `${base}/activity?user=${encodeURIComponent(funder)}&limit=${limit}`,
      {
        signal: AbortSignal.timeout(Number(opts.timeoutMs ?? 8000)),
        headers: { accept: 'application/json' },
      },
    );
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

/**
 * Agrega cashflow por slug/eventSlug (= marketId BTC 5m).
 * BUY = custo (−usdc); SELL/REDEEM = receita (+usdc).
 *
 * @param {object[]} activity
 * @returns {Map<string, {
 *   marketId: string,
 *   buyUsd: number,
 *   sellUsd: number,
 *   redeemUsd: number,
 *   buyQty: number,
 *   sellQty: number,
 *   redeemQty: number,
 *   avgBuyPrice: number|null,
 *   pnl: number,
 *   lastTsSec: number|null,
 * }>}
 */
export function aggregateActivityCashflows(activity = []) {
  /** @type {Map<string, any>} */
  const byMarket = new Map();

  function ensure(marketId) {
    if (!byMarket.has(marketId)) {
      byMarket.set(marketId, {
        marketId,
        buyUsd: 0,
        sellUsd: 0,
        redeemUsd: 0,
        buyQty: 0,
        sellQty: 0,
        redeemQty: 0,
        avgBuyPrice: null,
        pnl: 0,
        lastTsSec: null,
      });
    }
    return byMarket.get(marketId);
  }

  for (const row of activity) {
    const marketId = String(row?.eventSlug || row?.slug || '').trim();
    if (!marketId) continue;
    const type = String(row?.type || '').toUpperCase();
    const side = String(row?.side || '').toUpperCase();
    const usdc = Number(row?.usdcSize);
    const size = Number(row?.size);
    const price = Number(row?.price);
    const ts = Number(row?.timestamp);
    const bucket = ensure(marketId);

    if (Number.isFinite(ts)) {
      bucket.lastTsSec = bucket.lastTsSec == null ? ts : Math.max(bucket.lastTsSec, ts);
    }

    if (type === 'TRADE' && side === 'BUY' && Number.isFinite(usdc) && usdc > 0) {
      bucket.buyUsd += usdc;
      if (Number.isFinite(size) && size > 0) bucket.buyQty += size;
      if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) {
        const prevNotional = (bucket.avgBuyPrice ?? 0) * (bucket.buyQty - size);
        bucket.avgBuyPrice = (prevNotional + price * size) / bucket.buyQty;
      }
      continue;
    }
    if (type === 'TRADE' && side === 'SELL' && Number.isFinite(usdc) && usdc > 0) {
      bucket.sellUsd += usdc;
      if (Number.isFinite(size) && size > 0) bucket.sellQty += size;
      continue;
    }
    if (type === 'REDEEM' && Number.isFinite(usdc) && usdc > 0) {
      bucket.redeemUsd += usdc;
      if (Number.isFinite(size) && size > 0) bucket.redeemQty += size;
    }
  }

  for (const bucket of byMarket.values()) {
    bucket.pnl = bucket.sellUsd + bucket.redeemUsd - bucket.buyUsd;
  }
  return byMarket;
}
