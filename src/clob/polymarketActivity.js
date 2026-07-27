/**
 * Activity da Data API Polymarket (TRADE / REDEEM) — fonte de caixa real para PnL.
 */

import { CRYPTO_5M_ASSETS } from '../markets/crypto5m.js';

/**
 * Parseia ISO/unix para segundos epoch. Retorna null se inválido.
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
export function parseSinceToUnixSec(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * @param {{
 *   funderAddress: string,
 *   fetchFn?: typeof fetch,
 *   dataApiBase?: string,
 *   timeoutMs?: number,
 *   limit?: number,
 *   maxItems?: number,
 *   pageSize?: number,
 *   sinceSec?: number|null,
 *   since?: string|number|null,
 * }} opts
 * @returns {Promise<object[]>}
 */
export async function fetchPolymarketActivity(opts) {
  const funder = String(opts?.funderAddress ?? '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(funder)) return [];
  const fetchFn = opts.fetchFn ?? fetch;
  const base = String(opts.dataApiBase ?? 'https://data-api.polymarket.com').replace(/\/$/, '');
  const pageSize = Math.max(
    1,
    Math.min(500, Number(opts.pageSize ?? opts.limit ?? 200) || 200),
  );
  const maxItems = Math.max(
    pageSize,
    Math.min(5000, Number(opts.maxItems ?? opts.limit ?? 1000) || 1000),
  );
  const sinceSec =
    opts.sinceSec != null && Number.isFinite(Number(opts.sinceSec))
      ? Math.floor(Number(opts.sinceSec))
      : parseSinceToUnixSec(opts.since);
  const timeoutMs = Number(opts.timeoutMs ?? 12_000);
  /** @type {object[]} */
  const out = [];
  let offset = 0;

  while (out.length < maxItems) {
    const limit = Math.min(pageSize, maxItems - out.length);
    try {
      const url = new URL(`${base}/activity`);
      url.searchParams.set('user', funder);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      if (sinceSec != null) url.searchParams.set('start', String(sinceSec));
      const response = await fetchFn(url.toString(), {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) break;
      const body = await response.json();
      const chunk = Array.isArray(body) ? body : [];
      if (chunk.length === 0) break;
      const filtered =
        sinceSec == null
          ? chunk
          : chunk.filter((row) => {
              const ts = Number(row?.timestamp);
              return !Number.isFinite(ts) || ts >= sinceSec;
            });
      out.push(...filtered);
      // Página inteira antiga: parar (activity vem do mais recente → antigo).
      if (sinceSec != null && chunk.length > 0) {
        const oldest = Math.min(
          ...chunk.map((row) => Number(row?.timestamp)).filter((n) => Number.isFinite(n)),
        );
        if (Number.isFinite(oldest) && oldest < sinceSec) break;
      }
      if (chunk.length < limit) break;
      offset += chunk.length;
    } catch {
      break;
    }
  }

  return out;
}

/**
 * Prefixo de slug crypto-updown a partir do marketId / eventSlug.
 * @param {string} marketId
 * @returns {string|null} btc|eth|sol|xrp|doge
 */
export function assetKeyFromMarketId(marketId) {
  const slug = String(marketId || '').trim().toLowerCase();
  if (!slug) return null;
  for (const [assetKey, meta] of Object.entries(CRYPTO_5M_ASSETS)) {
    const prefix = String(meta.slugPrefix || '').toLowerCase();
    if (prefix && (slug === prefix || slug.startsWith(`${prefix}-`))) return assetKey;
  }
  return null;
}

/**
 * @param {object[]} activity
 * @param {string|null|undefined} slugPrefix ex. btc-updown-5m
 */
export function filterActivityBySlugPrefix(activity = [], slugPrefix) {
  const prefix = String(slugPrefix || '')
    .trim()
    .toLowerCase();
  if (!prefix) return Array.isArray(activity) ? activity : [];
  return (activity || []).filter((row) => {
    const marketId = String(row?.eventSlug || row?.slug || '')
      .trim()
      .toLowerCase();
    return marketId === prefix || marketId.startsWith(`${prefix}-`);
  });
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
 *   firstTsSec: number|null,
 *   lastTsSec: number|null,
 *   outcome: string|null,
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
        firstTsSec: null,
        lastTsSec: null,
        outcome: null,
        redeemed: false,
        pendingSettlement: false,
        inferredLoss: false,
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
    const outcome = row?.outcome != null ? String(row.outcome) : null;
    const bucket = ensure(marketId);

    if (Number.isFinite(ts)) {
      bucket.firstTsSec = bucket.firstTsSec == null ? ts : Math.min(bucket.firstTsSec, ts);
      bucket.lastTsSec = bucket.lastTsSec == null ? ts : Math.max(bucket.lastTsSec, ts);
    }
    if (outcome && !bucket.outcome) bucket.outcome = outcome;

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
    // REDEEM $0 = settlement perdedor (comum em up/down); precisa fechar o trade.
    if (type === 'REDEEM' && Number.isFinite(usdc) && usdc >= 0) {
      bucket.redeemUsd += usdc;
      bucket.redeemed = true;
      if (Number.isFinite(size) && size > 0) bucket.redeemQty += size;
    }
  }

  for (const bucket of byMarket.values()) {
    finalizeActivityCashflow(bucket);
  }
  return byMarket;
}

/**
 * Extrai slot unix do slug crypto-updown-5m-<slot>.
 * @param {string} marketId
 * @returns {number|null}
 */
export function slotStartFromMarketId(marketId) {
  const m = String(marketId || '').match(/-(\d{9,12})$/);
  if (!m) return null;
  const slot = Number(m[1]);
  return Number.isFinite(slot) ? slot : null;
}

/**
 * Fecha cashflow sem SELL/REDEEM quando o mercado 5m já expirou.
 * Sem REDEEM na Data API (perda total) o BUY ficava "open" e sumia do painel.
 * @param {object} cf
 * @param {number} [nowSec]
 * @param {number} [graceSec] espera pós-slot antes de inferir perda
 */
export function finalizeActivityCashflow(cf, nowSec = Math.floor(Date.now() / 1000), graceSec = 120) {
  if (!cf || !(cf.buyUsd > 0)) return cf;
  cf.pnl = cf.sellUsd + cf.redeemUsd - cf.buyUsd;
  if (cf.sellUsd > 0 || cf.redeemed === true) return cf;

  const slotStart = slotStartFromMarketId(cf.marketId);
  if (slotStart == null) return cf;
  const slotEnd = slotStart + 300;
  if (nowSec < slotEnd + graceSec) {
    cf.pendingSettlement = true;
    return cf;
  }
  // Expirado sem exit na activity → perda total (redeem implícito $0).
  cf.redeemed = true;
  cf.inferredLoss = true;
  cf.pendingSettlement = false;
  cf.redeemUsd = Number(cf.redeemUsd) || 0;
  cf.pnl = cf.sellUsd + cf.redeemUsd - cf.buyUsd;
  if (cf.lastTsSec == null || cf.lastTsSec < slotEnd) cf.lastTsSec = slotEnd;
  return cf;
}

/**
 * Filtra mapa de cashflows pelo prefixo do ativo da engine.
 * @param {Map<string, object>|Iterable<[string, object]>} cashflowsByMarket
 * @param {string|null|undefined} slugPrefix
 */
export function filterCashflowsBySlugPrefix(cashflowsByMarket, slugPrefix) {
  const prefix = String(slugPrefix || '')
    .trim()
    .toLowerCase();
  const map =
    cashflowsByMarket instanceof Map
      ? cashflowsByMarket
      : new Map(cashflowsByMarket ?? []);
  if (!prefix) return map;
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [marketId, cf] of map) {
    const id = String(marketId || '')
      .trim()
      .toLowerCase();
    if (id === prefix || id.startsWith(`${prefix}-`)) out.set(marketId, cf);
  }
  return out;
}

/**
 * Restringe cashflows ao escopo "robô":
 * - alwaysKeepMarketIds: mercados do audit/OMS local (ordens da engine)
 * - sinceSec: ignora markets cujo 1º fill é anterior (histórico antigo da carteira)
 * - onlyKeepMarketIds: se true e alwaysKeep não-vazio, não sintetiza markets
 *   que a engine não registrou (evita misturar trades manuais da mesma carteira)
 *
 * @param {Map<string, object>|Iterable<[string, object]>} cashflowsByMarket
 * @param {{
 *   alwaysKeepMarketIds?: Iterable<string>,
 *   sinceSec?: number|null,
 *   onlyKeepMarketIds?: boolean,
 * }} [opts]
 */
export function filterCashflowsForRobotScope(cashflowsByMarket, opts = {}) {
  const map =
    cashflowsByMarket instanceof Map
      ? cashflowsByMarket
      : new Map(cashflowsByMarket ?? []);
  const keep = new Set(
    [...(opts.alwaysKeepMarketIds ?? [])].map((id) => String(id || '').trim()).filter(Boolean),
  );
  const sinceSec =
    opts.sinceSec != null && Number.isFinite(Number(opts.sinceSec))
      ? Math.floor(Number(opts.sinceSec))
      : null;
  const onlyKeep = opts.onlyKeepMarketIds === true && keep.size > 0;

  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [marketId, cf] of map) {
    if (keep.has(marketId)) {
      out.set(marketId, cf);
      continue;
    }
    if (onlyKeep) continue;
    if (!(cf?.buyUsd > 0)) continue;
    if (sinceSec != null) {
      const first = Number(cf.firstTsSec ?? cf.lastTsSec);
      if (Number.isFinite(first) && first < sinceSec) continue;
    }
    out.set(marketId, cf);
  }
  return out;
}
