import { WebSocket } from 'ws';
import config from '../config.js';

const DEPTH = 10;
const RECONNECT_MS = 500;

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 * @param {object} [opts]
 * @param {() => void} [opts.onUpdate]
 */
export function createClobFeed(state, opts = {}) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let seedTimer = null;
  let subscribedTokens = [];
  let stopped = false;
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};

  const rawBids = { up: new Map(), down: new Map() };
  const rawAsks = { up: new Map(), down: new Map() };

  function syncBest(side) {
    const bids = [...rawBids[side].entries()]
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .filter((l) => l.size > 0)
      .sort((a, b) => b.price - a.price);
    const asks = [...rawAsks[side].entries()]
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .filter((l) => l.size > 0)
      .sort((a, b) => a.price - b.price);

    state[side].bids = bids.slice(0, DEPTH);
    state[side].asks = asks.slice(0, DEPTH);
    state[side].bestBid = bids[0]?.price ?? null;
    state[side].bestAsk = asks[0]?.price ?? null;
    state.clobLastAt = Date.now();
  }

  function setLevel(book, priceStr, size) {
    if (size <= 0) book.delete(priceStr);
    else book.set(priceStr, size);
  }

  function rebuild(side, bids, asks) {
    rawBids[side].clear();
    rawAsks[side].clear();
    for (const b of bids) setLevel(rawBids[side], String(b.price), parseFloat(b.size || 0));
    for (const a of asks) setLevel(rawAsks[side], String(a.price), parseFloat(a.size || 0));
    syncBest(side);
  }

  function connect() {
    if (stopped || ws) return;
    const socket = new WebSocket(config.clobWsUrl);
    ws = socket;

    socket.onopen = () => {
      state.wsClobConnected = true;
      if (subscribedTokens.length) sendSubscribe();
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('PING');
      }, 10000);
    };

    socket.onmessage = (event) => {
      if (!event.data || event.data === 'PONG') return;
      try {
        const data = JSON.parse(event.data);
        const items = Array.isArray(data) ? data : [data];
        let updated = false;
        for (const item of items) {
          if (item?.event_type) updated = processMessage(item) || updated;
        }
        if (updated) onUpdate();
      } catch { /* ignore */ }
    };

    socket.onclose = () => {
      state.wsClobConnected = false;
      cleanup();
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };

    socket.onerror = () => {};
  }

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
  }

  async function seedSideFromRest(side, tokenId) {
    if (!tokenId || stopped) return;
    try {
      const res = await fetch(`${config.clobHttpUrl}/book?token_id=${encodeURIComponent(tokenId)}`);
      if (!res.ok) return;
      const data = await res.json();
      rebuild(side, data.bids || [], data.asks || []);
      onUpdate();
    } catch {
      /* ignore — WS continua como fonte primária */
    }
  }

  async function seedBooksFromRest() {
    await Promise.all([
      seedSideFromRest('up', state.upTokenId),
      seedSideFromRest('down', state.downTokenId),
    ]);
  }

  function scheduleSeed() {
    if (seedTimer) clearTimeout(seedTimer);
    // Seed imediato + reforço curto (WS às vezes atrasa o book snapshot).
    void seedBooksFromRest();
    seedTimer = setTimeout(() => {
      if (stopped) return;
      const empty =
        (state.up.bestAsk == null && state.up.bestBid == null) ||
        (state.down.bestAsk == null && state.down.bestBid == null);
      if (empty) void seedBooksFromRest();
    }, 750);
  }

  function sendSubscribe() {
    if (!subscribedTokens.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      assets_ids: subscribedTokens,
      operation: 'subscribe',
      custom_feature_enabled: true,
    }));
    scheduleSeed();
  }

  function processMessage(data) {
    const assetId = data.asset_id || '';
    const side = assetId === state.upTokenId ? 'up' : assetId === state.downTokenId ? 'down' : null;
    if (!side) return false;

    if (data.event_type === 'book') {
      rebuild(side, data.bids || [], data.asks || []);
      return true;
    } else if (data.event_type === 'price_change') {
      let changed = false;
      for (const c of data.changes || []) {
        const size = parseFloat(c.size || 0);
        if (c.side === 'SELL') {
          setLevel(rawAsks[side], String(c.price), size);
          changed = true;
        }
        if (c.side === 'BUY') {
          setLevel(rawBids[side], String(c.price), size);
          changed = true;
        }
      }
      if (changed) syncBest(side);
      return changed;
    } else if (data.event_type === 'best_bid_ask') {
      if (data.best_bid != null) state[side].bestBid = parseFloat(data.best_bid);
      if (data.best_ask != null) state[side].bestAsk = parseFloat(data.best_ask);
      state.clobLastAt = Date.now();
      return true;
    }
    return false;
  }

  connect();

  return {
    subscribe(upTokenId, downTokenId) {
      state.upTokenId = upTokenId;
      state.downTokenId = downTokenId;
      subscribedTokens = [upTokenId, downTokenId];
      rawBids.up.clear(); rawBids.down.clear();
      rawAsks.up.clear(); rawAsks.down.clear();
      state.up = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      state.down = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      sendSubscribe();
      // Se WS ainda não abriu, seed REST já deixa book acionável.
      scheduleSeed();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (seedTimer) { clearTimeout(seedTimer); seedTimer = null; }
      if (ws) {
        const s = ws;
        ws = null;
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
      }
      state.wsClobConnected = false;
    },
  };
}
