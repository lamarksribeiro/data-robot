import { WebSocket } from 'ws';
import config from '../config.js';
import { BTC5M_STALENESS } from '../market/health.js';

const RECONNECT_MS = 500;
const DEFAULT_WATCHDOG_MS = 2_000;
/** Acima do limite operacional BTC5m (8s) para evitar churn; ainda abaixo de restart manual. */
const DEFAULT_STALE_MS = Math.max(BTC5M_STALENESS.rtdsMaxLagMs * 2, 12_000);

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 * @param {object} [opts]
 * @param {() => void} [opts.onUpdate]
 * @param {(info: { reason: string, lagMs: number|null }) => void} [opts.onStaleReconnect]
 * @param {number} [opts.staleMs]
 * @param {number} [opts.watchdogMs]
 * @param {() => number} [opts.clock]
 * @param {typeof WebSocket} [opts.WebSocket]
 */
export function startRtdsFeed(state, opts = {}) {
  const WebSocketImpl = opts.WebSocket ?? WebSocket;
  const clock = opts.clock ?? Date.now;
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : DEFAULT_STALE_MS;
  const watchdogMs = Number(opts.watchdogMs) > 0 ? Number(opts.watchdogMs) : DEFAULT_WATCHDOG_MS;
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
  const onStaleReconnect =
    typeof opts.onStaleReconnect === 'function' ? opts.onStaleReconnect : () => {};

  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let connectedAtMs = null;

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
    reconnectTimer.unref?.();
  }

  function dropSocket() {
    clearPing();
    const socket = ws;
    ws = null;
    connectedAtMs = null;
    state.wsRtdsConnected = false;
    if (!socket) return;
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) {
        socket.close();
      }
    } catch {
      /* ignore */
    }
  }

  function forceReconnect(reason, lagMs) {
    if (stopped) return;
    dropSocket();
    onStaleReconnect({ reason, lagMs });
    scheduleReconnect();
  }

  function sampleLagMs() {
    if (connectedAtMs == null) return null;
    // Sample de conexão anterior não conta — dá grace até o 1º tick desta sessão.
    if (state.rtdsReceivedAt == null || state.rtdsReceivedAt < connectedAtMs) {
      return clock() - connectedAtMs;
    }
    return clock() - state.rtdsReceivedAt;
  }

  function checkStale() {
    if (stopped || !ws) return;
    if (ws.readyState !== WebSocketImpl.OPEN || state.wsRtdsConnected !== true) return;
    const lagMs = sampleLagMs();
    if (lagMs == null || lagMs <= staleMs) return;
    forceReconnect('RTDS_STALE', lagMs);
  }

  function connect() {
    if (stopped || ws) return;
    clearReconnect();
    const socket = new WebSocketImpl(config.rtdsWsUrl);
    ws = socket;

    socket.onopen = () => {
      if (stopped || ws !== socket) return;
      connectedAtMs = clock();
      state.wsRtdsConnected = true;
      socket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: 'update',
          filters: JSON.stringify({ symbol: 'btc/usd' }),
        }],
      }));
      clearPing();
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocketImpl.OPEN) socket.send('PING');
      }, 30000);
      pingTimer.unref?.();
    };

    socket.onmessage = (event) => {
      if (!event.data || event.data === 'PONG') return;
      try {
        if (handlePayload(state, JSON.parse(event.data), clock)) onUpdate();
      } catch { /* ignore */ }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      state.wsRtdsConnected = false;
      clearPing();
      ws = null;
      connectedAtMs = null;
      if (!stopped) scheduleReconnect();
    };

    socket.onerror = () => {};
  }

  connect();
  watchdogTimer = setInterval(checkStale, watchdogMs);
  watchdogTimer.unref?.();

  return () => {
    stopped = true;
    clearReconnect();
    clearPing();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    dropSocket();
  };
}

function handlePayload(state, data, clock = Date.now) {
  const topic = data.topic || '';
  if (typeof topic !== 'string' || !topic.startsWith('crypto_prices')) return false;

  const payload = data.payload;
  if (!payload || typeof payload !== 'object') return false;

  const apply = (value, ts) => {
    state.btc = parseFloat(value);
    state.rtdsTs = ts != null ? parseInt(ts, 10) : null;
    state.rtdsReceivedAt = clock();
    return true;
  };

  if (Array.isArray(payload.data) && payload.data.length) {
    const last = payload.data[payload.data.length - 1];
    return apply(last.value, last.timestamp);
  }
  if (payload.value != null) return apply(payload.value, payload.timestamp);
  return false;
}
