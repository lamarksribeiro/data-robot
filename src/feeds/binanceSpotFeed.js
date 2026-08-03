import { WebSocket } from 'ws';

const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 8_000;
const DEFAULT_WATCHDOG_MS = 2_000;
const DEFAULT_STALE_MS = 8_000;
const DEFAULT_WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';

/**
 * Spot BTC via Binance public WS (bookTicker → mid).
 * Sem API key. Atualiza state.binance* para decisão Hyperion.
 *
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 * @param {object} [opts]
 * @returns {() => void} stop
 */
export function startBinanceSpotFeed(state, opts = {}) {
  const WebSocketImpl = opts.WebSocket ?? WebSocket;
  const clock = opts.clock ?? Date.now;
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : DEFAULT_STALE_MS;
  const watchdogMs = Number(opts.watchdogMs) > 0 ? Number(opts.watchdogMs) : DEFAULT_WATCHDOG_MS;
  const wsUrl = String(opts.wsUrl || process.env.BINANCE_SPOT_WS_URL || DEFAULT_WS_URL);
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
  const onStaleReconnect =
    typeof opts.onStaleReconnect === 'function' ? opts.onStaleReconnect : () => {};

  let ws = null;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let connectedAtMs = null;
  let reconnectAttempt = 0;
  let lastForceReconnectAtMs = 0;

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function backoffMs() {
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5));
    return exp + Math.floor(Math.random() * 200);
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

  function dropSocket() {
    const socket = ws;
    ws = null;
    connectedAtMs = null;
    state.wsBinanceConnected = false;
    state.binanceConnectedAt = null;
    if (!socket) return;
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else if (
        socket.readyState === WebSocketImpl.OPEN ||
        socket.readyState === WebSocketImpl.CONNECTING
      ) {
        socket.close();
      }
    } catch {
      /* ignore */
    }
  }

  function forceReconnect(reason, lagMs) {
    if (stopped) return;
    const now = clock();
    if (now - lastForceReconnectAtMs < 5_000) return;
    lastForceReconnectAtMs = now;
    dropSocket();
    onStaleReconnect({ reason, lagMs });
    scheduleReconnect();
  }

  function sampleLagMs() {
    if (connectedAtMs == null) return null;
    if (state.binanceReceivedAt == null || state.binanceReceivedAt < connectedAtMs) {
      return clock() - connectedAtMs;
    }
    return clock() - state.binanceReceivedAt;
  }

  function checkStale() {
    if (stopped || !ws) return;
    if (ws.readyState !== WebSocketImpl.OPEN || state.wsBinanceConnected !== true) return;
    const lagMs = sampleLagMs();
    if (lagMs == null || lagMs <= staleMs) return;
    forceReconnect('BINANCE_STALE', lagMs);
  }

  function applyTicker(msg) {
    const bid = parseFloat(msg.b);
    const ask = parseFloat(msg.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return false;
    const mid = (bid + ask) / 2;
    const ts = msg.E != null ? parseInt(msg.E, 10) : clock();
    state.binance = mid;
    state.binanceBid = bid;
    state.binanceAsk = ask;
    state.binanceTs = Number.isFinite(ts) ? ts : clock();
    state.binanceReceivedAt = clock();
    return true;
  }

  function connect() {
    if (stopped || ws) return;
    clearReconnect();
    const socket = new WebSocketImpl(wsUrl);
    ws = socket;

    socket.onopen = () => {
      if (stopped || ws !== socket) return;
      connectedAtMs = clock();
      reconnectAttempt = 0;
      state.wsBinanceConnected = true;
      state.binanceConnectedAt = connectedAtMs;
    };

    socket.onmessage = (event) => {
      if (!event.data) return;
      try {
        const msg = JSON.parse(event.data);
        if (applyTicker(msg)) onUpdate();
      } catch {
        /* ignore */
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      state.wsBinanceConnected = false;
      state.binanceConnectedAt = null;
      ws = null;
      connectedAtMs = null;
      if (!stopped) scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws === socket && socket.readyState !== WebSocketImpl.OPEN) {
        try {
          socket.terminate?.();
        } catch {
          /* ignore */
        }
      }
    };
  }

  connect();
  watchdogTimer = setInterval(checkStale, watchdogMs);
  watchdogTimer.unref?.();

  return () => {
    stopped = true;
    clearReconnect();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    dropSocket();
  };
}
