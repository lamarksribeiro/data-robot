import { WebSocket } from 'ws';
import config from '../config.js';

const DEPTH = 10;

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 */
export function createClobFeed(state) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let subscribedTokens = [];

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

  function applyLevel(side, book, priceStr, size) {
    if (size <= 0) book.delete(priceStr);
    else book.set(priceStr, size);
    syncBest(side);
  }

  function rebuild(side, bids, asks) {
    rawBids[side].clear();
    rawAsks[side].clear();
    for (const b of bids) applyLevel(side, rawBids[side], String(b.price), parseFloat(b.size || 0));
    for (const a of asks) applyLevel(side, rawAsks[side], String(a.price), parseFloat(a.size || 0));
  }

  function connect() {
    if (ws) return;
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
        for (const item of items) {
          if (item?.event_type) processMessage(item);
        }
      } catch { /* ignore */ }
    };

    socket.onclose = () => {
      state.wsClobConnected = false;
      cleanup();
      reconnectTimer = setTimeout(connect, 2000);
    };

    socket.onerror = () => {};
  }

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
  }

  function sendSubscribe() {
    if (!subscribedTokens.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      assets_ids: subscribedTokens,
      operation: 'subscribe',
      custom_feature_enabled: true,
    }));
  }

  function processMessage(data) {
    const assetId = data.asset_id || '';
    const side = assetId === state.upTokenId ? 'up' : assetId === state.downTokenId ? 'down' : null;
    if (!side) return;

    if (data.event_type === 'book') {
      rebuild(side, data.bids || [], data.asks || []);
    } else if (data.event_type === 'price_change') {
      for (const c of data.changes || []) {
        const size = parseFloat(c.size || 0);
        if (c.side === 'SELL') applyLevel(side, rawAsks[side], String(c.price), size);
        if (c.side === 'BUY') applyLevel(side, rawBids[side], String(c.price), size);
      }
    } else if (data.event_type === 'best_bid_ask') {
      if (data.best_bid != null) state[side].bestBid = parseFloat(data.best_bid);
      if (data.best_ask != null) state[side].bestAsk = parseFloat(data.best_ask);
      state.clobLastAt = Date.now();
    }
  }

  connect();

  return {
    subscribe(upTokenId, downTokenId) {
      state.upTokenId = upTokenId;
      state.downTokenId = downTokenId;
      subscribedTokens = [upTokenId, downTokenId];
      rawBids.up.clear(); rawBids.down.clear();
      rawAsks.up.clear(); rawAsks.down.clear();
      sendSubscribe();
    },
    stop() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (ws) {
        const s = ws;
        ws = null;
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
      }
      state.wsClobConnected = false;
    },
  };
}
