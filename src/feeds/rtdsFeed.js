import { WebSocket } from 'ws';
import config from '../config.js';
import { BTC5M_STALENESS } from '../market/health.js';

const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 8_000;
const DEFAULT_WATCHDOG_MS = 2_000;
/**
 * Watchdog de force-reconnect acima do limite de trading BTC5m para evitar churn.
 * Ainda reconecta se o socket "zumbie" ficar sem ticks.
 */
const DEFAULT_STALE_MS = Math.max(BTC5M_STALENESS.rtdsMaxLagMs * 2.5, 25_000);

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 * @param {object} [opts]
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
  let reconnectAttempt = 0;
  let lastForceReconnectAtMs = 0;

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

  function backoffMs() {
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5));
    const jitter = Math.floor(Math.random() * 200);
    return exp + jitter;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs();
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function dropSocket({ keepSample = true } = {}) {
    clearPing();
    const socket = ws;
    ws = null;
    connectedAtMs = null;
    state.wsRtdsConnected = false;
    state.rtdsConnectedAt = null;
    // Mantém último tick (btc/rtdsReceivedAt) para histerese de saúde do processo.
    if (!keepSample) {
      /* optional hard reset unused */
    }
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
    // Anti-churn: no máximo 1 force-reconnect a cada 5s.
    if (now - lastForceReconnectAtMs < 5_000) return;
    lastForceReconnectAtMs = now;
    dropSocket({ keepSample: true });
    onStaleReconnect({ reason, lagMs });
    scheduleReconnect();
  }

  function sampleLagMs() {
    if (connectedAtMs == null) return null;
    // Grace até o 1º tick desta sessão de socket.
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
      reconnectAttempt = 0;
      state.wsRtdsConnected = true;
      state.rtdsConnectedAt = connectedAtMs;
      socket.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            {
              topic: 'crypto_prices_chainlink',
              type: 'update',
              filters: JSON.stringify({ symbol: 'btc/usd' }),
            },
          ],
        }),
      );
      clearPing();
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocketImpl.OPEN) {
          try {
            socket.send('PING');
          } catch {
            /* ignore */
          }
        }
      }, 15_000);
      pingTimer.unref?.();
    };

    socket.onmessage = (event) => {
      if (!event.data || event.data === 'PONG') return;
      try {
        if (handlePayload(state, JSON.parse(event.data), clock)) onUpdate();
      } catch {
        /* ignore */
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      state.wsRtdsConnected = false;
      state.rtdsConnectedAt = null;
      clearPing();
      ws = null;
      connectedAtMs = null;
      if (!stopped) scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose costuma seguir; se não, força schedule
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
    clearPing();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    dropSocket({ keepSample: true });
  };
}

function handlePayload(state, data, clock = Date.now) {
  const topic = data.topic || '';
  if (typeof topic !== 'string' || !topic.startsWith('crypto_prices')) return false;

  const payload = data.payload;
  if (!payload || typeof payload !== 'object') return false;

  const apply = (value, ts) => {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return false;
    state.btc = n;
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
