/**
 * Descoberta de eventos Up/Down 5m Polymarket por ativo (btc/eth/sol/xrp).
 */

import config from '../config.js';

export const CRYPTO_5M_ASSETS = Object.freeze({
  btc: {
    slugPrefix: 'btc-updown-5m',
    marketScope: 'btc-updown-5m',
    sourceKind: 'btc5m',
    rtdsSymbol: 'btc/usd',
    ptbSymbol: 'BTC',
    presetId: 'btc-gold-v1',
  },
  eth: {
    slugPrefix: 'eth-updown-5m',
    marketScope: 'eth-updown-5m',
    sourceKind: 'eth5m',
    rtdsSymbol: 'eth/usd',
    ptbSymbol: 'ETH',
    presetId: 'eth-gold-v1',
  },
  sol: {
    slugPrefix: 'sol-updown-5m',
    marketScope: 'sol-updown-5m',
    sourceKind: 'sol5m',
    rtdsSymbol: 'sol/usd',
    ptbSymbol: 'SOL',
    presetId: 'sol-gold-v1',
  },
  xrp: {
    slugPrefix: 'xrp-updown-5m',
    marketScope: 'xrp-updown-5m',
    sourceKind: 'xrp5m',
    rtdsSymbol: 'xrp/usd',
    ptbSymbol: 'XRP',
    presetId: 'xrp-gold-v1',
  },
});

export function resolveCrypto5mAsset(assetOrKind) {
  const raw = String(assetOrKind || 'btc').toLowerCase().trim();
  const kind = raw.endsWith('5m') ? raw.slice(0, -2) : raw;
  const asset = CRYPTO_5M_ASSETS[kind];
  if (!asset) {
    throw new Error(`ativo crypto 5m inválido: ${assetOrKind}`);
  }
  return { assetKey: kind, ...asset };
}

export function isCrypto5mSourceKind(kind) {
  const k = String(kind || '');
  return k === 'btc5m' || k === 'eth5m' || k === 'sol5m' || k === 'xrp5m';
}

/**
 * @param {string} assetKey btc|eth|sol|xrp
 * @param {Date} [now]
 */
export async function findActiveCrypto5mEvent(assetKey, now = new Date()) {
  const { slugPrefix } = resolveCrypto5mAsset(assetKey);
  const ts = Math.floor(now.getTime() / 1000);
  const currentSlot = ts - (ts % 300);

  for (const slotTs of [currentSlot, currentSlot + 300]) {
    const slug = `${slugPrefix}-${slotTs}`;
    try {
      const url = `${config.gammaBase}/events?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const events = await res.json();
      if (!Array.isArray(events) || !events.length) continue;

      const event = events[0];
      const market = event.markets?.[0];
      if (!market) continue;

      const eventStart = market.eventStartTime ? new Date(market.eventStartTime) : null;
      const eventEnd = market.endDate ? new Date(market.endDate) : null;
      if (!eventEnd || now >= eventEnd) continue;

      const clobIds = JSON.parse(market.clobTokenIds || '[]');
      if (clobIds.length < 2) continue;

      return {
        title: event.title || '',
        slug,
        conditionId: market.conditionId || '',
        upTokenId: clobIds[0],
        downTokenId: clobIds[1],
        eventStart,
        eventEnd,
        acceptingOrders: market.acceptingOrders === true,
        assetKey,
      };
    } catch {
      continue;
    }
  }
  return null;
}
