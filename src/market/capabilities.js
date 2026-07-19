/**
 * Filtra snapshot conforme capabilities declaradas no manifest da estratégia.
 * Estratégias price-only não recebem profundidade de book.
 */

const BOOK_CAP = 'book';
const PRICE_CAP = 'price';

/**
 * @param {object} snapshot
 * @param {string[]} capabilities
 */
export function filterSnapshotForCapabilities(snapshot, capabilities = []) {
  const caps = new Set(capabilities);
  const out = {
    ...snapshot,
    book: snapshot.book ? { ...snapshot.book } : {},
    feeds: snapshot.feeds ? { ...snapshot.feeds } : {},
    identity: snapshot.identity ? { ...snapshot.identity } : undefined,
    health: snapshot.health ? { ...snapshot.health } : undefined,
  };

  if (!caps.has(BOOK_CAP)) {
    out.book = {
      up: { bestBid: null, bestAsk: null, bids: [], asks: [] },
      down: { bestBid: null, bestAsk: null, bids: [], asks: [] },
    };
    out._capabilityFilter = { stripped: ['book'] };
  } else {
    // Cópia profunda rasa dos níveis para evitar mutação do original
    out.book = {
      up: cloneSide(snapshot.book?.up),
      down: cloneSide(snapshot.book?.down),
    };
    out._capabilityFilter = { stripped: [] };
  }

  if (!caps.has(PRICE_CAP) && !caps.has(BOOK_CAP)) {
    out.btc = null;
    out.priceToBeat = null;
    out._capabilityFilter.stripped.push('price');
  }

  return out;
}

function cloneSide(side) {
  if (!side) return { bestBid: null, bestAsk: null, bids: [], asks: [] };
  return {
    bestBid: side.bestBid ?? null,
    bestAsk: side.bestAsk ?? null,
    bids: Array.isArray(side.bids) ? side.bids.map((l) => ({ ...l })) : [],
    asks: Array.isArray(side.asks) ? side.asks.map((l) => ({ ...l })) : [],
  };
}

/**
 * Verifica se o snapshot filtrado respeita o contrato de capabilities.
 */
export function assertCapabilitiesHonored(filtered, capabilities) {
  const caps = new Set(capabilities);
  if (!caps.has(BOOK_CAP)) {
    const upBids = filtered.book?.up?.bids?.length ?? 0;
    const downBids = filtered.book?.down?.bids?.length ?? 0;
    if (upBids > 0 || downBids > 0) {
      throw new Error('book depth vazou para strategy sem capability book');
    }
    if (filtered.book?.up?.bestAsk != null || filtered.book?.down?.bestAsk != null) {
      throw new Error('best ask vazou para strategy sem capability book');
    }
  }
  return true;
}
