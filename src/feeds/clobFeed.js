import { WebSocket } from 'ws';
import config from '../config.js';

const DEPTH = 10;
const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 8_000;
const PING_MS = 10_000;
const RESEED_MS = 5_000;
const STALE_RESEED_MS = 8_000;

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 * @param {object} [opts]
 * @param {() => void} [opts.onUpdate]
 * @param {() => number} [opts.clock]
 */
export function createClobFeed(state, opts = {}) {
  const clock = opts.clock ?? Date.now;
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let seedTimer = null;
  let reseedTimer = null;
  let subscribedTokens = [];
  let stopped = false;
  let reconnectAttempt = 0;
  let connectedAtMs = null;
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};

  const rawBids = { up: new Map(), down: new Map() };
  const rawAsks = { up: new Map(), down: new Map() };

  function backoffMs() {
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5));
    return exp + Math.floor(Math.random() * 250);
  }

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
    state.clobLastAt = clock();
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

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs());
    reconnectTimer.unref?.();
  }

  function connect() {
    if (stopped || ws) return;
    const socket = new WebSocket(config.clobWsUrl);
    ws = socket;

    socket.onopen = () => {
      if (stopped || ws !== socket) return;
      connectedAtMs = clock();
      reconnectAttempt = 0;
      state.wsClobConnected = true;
      state.clobConnectedAt = connectedAtMs;
      if (subscribedTokens.length) sendSubscribe();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send('PING');
          } catch {
            /* ignore */
          }
        }
      }, PING_MS);
      pingTimer.unref?.();
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
      } catch {
        /* ignore */
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      state.wsClobConnected = false;
      state.clobConnectedAt = null;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      connectedAtMs = null;
      // NÃO zera book: mantém último top-of-book até resync (process health + menos CLOB_NO_SAMPLE).
      if (!stopped) scheduleReconnect();
    };

    socket.onerror = () => {};
  }

  async function seedSideFromRest(side, tokenId) {
    if (!tokenId || stopped) return;
    try {
      const res = await fetch(`${config.clobHttpUrl}/book?token_id=${encodeURIComponent(tokenId)}`, {
        signal: AbortSignal.timeout(4_000),
      });
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
    void seedBooksFromRest();
    seedTimer = setTimeout(() => {
      if (stopped) return;
      const empty =
        (state.up.bestAsk == null && state.up.bestBid == null) ||
        (state.down.bestAsk == null && state.down.bestBid == null);
      if (empty) void seedBooksFromRest();
    }, 750);
  }

  function maybeReseedIfStale() {
    if (stopped || !subscribedTokens.length) return;
    const lag = state.clobLastAt == null ? Infinity : clock() - state.clobLastAt;
    const empty =
      (state.up.bestAsk == null && state.up.bestBid == null) ||
      (state.down.bestAsk == null && state.down.bestBid == null);
    if (empty || lag >= STALE_RESEED_MS) void seedBooksFromRest();
  }

  function sendSubscribe() {
    if (!subscribedTokens.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          assets_ids: subscribedTokens,
          operation: 'subscribe',
          custom_feature_enabled: true,
        }),
      );
    } catch {
      /* ignore */
    }
    scheduleSeed();
  }

  function processMessage(data) {
    const assetId = data.asset_id || '';
    const side = assetId === state.upTokenId ? 'up' : assetId === state.downTokenId ? 'down' : null;
    if (!side) return false;

    if (data.event_type === 'book') {
      rebuild(side, data.bids || [], data.asks || []);
      return true;
    }
    if (data.event_type === 'price_change') {
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
    }
    if (data.event_type === 'best_bid_ask') {
      if (data.best_bid != null) state[side].bestBid = parseFloat(data.best_bid);
      if (data.best_ask != null) state[side].bestAsk = parseFloat(data.best_ask);
      state.clobLastAt = clock();
      return true;
    }
    return false;
  }

  connect();
  reseedTimer = setInterval(maybeReseedIfStale, RESEED_MS);
  reseedTimer.unref?.();

  return {
    subscribe(upTokenId, downTokenId) {
      state.upTokenId = upTokenId;
      state.downTokenId = downTokenId;
      subscribedTokens = [upTokenId, downTokenId];
      rawBids.up.clear();
      rawBids.down.clear();
      rawAsks.up.clear();
      rawAsks.down.clear();
      state.up = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      state.down = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      state.clobLastAt = null;
      sendSubscribe();
      scheduleSeed();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (seedTimer) {
        clearTimeout(seedTimer);
        seedTimer = null;
      }
      if (reseedTimer) {
        clearInterval(reseedTimer);
        reseedTimer = null;
      }
      if (ws) {
        const s = ws;
        ws = null;
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
      }
      state.wsClobConnected = false;
      state.clobConnectedAt = null;
    },
  };
}
