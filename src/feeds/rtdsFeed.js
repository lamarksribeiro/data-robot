import { WebSocket } from 'ws';
import config from '../config.js';

/**
 * @param {ReturnType<import('./marketState.js').createMarketState>} state
 */
export function startRtdsFeed(state) {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let stopped = false;

  function connect() {
    if (stopped || ws) return;
    const socket = new WebSocket(config.rtdsWsUrl);
    ws = socket;

    socket.onopen = () => {
      state.wsRtdsConnected = true;
      socket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: 'update',
          filters: JSON.stringify({ symbol: 'btc/usd' }),
        }],
      }));
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('PING');
      }, 30000);
    };

    socket.onmessage = (event) => {
      if (!event.data || event.data === 'PONG') return;
      try {
        handlePayload(state, JSON.parse(event.data));
      } catch { /* ignore */ }
    };

    socket.onclose = () => {
      state.wsRtdsConnected = false;
      cleanup();
      if (!stopped) reconnectTimer = setTimeout(connect, 500);
    };

    socket.onerror = () => {};
  }

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) {
      const s = ws;
      ws = null;
      if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
    }
    state.wsRtdsConnected = false;
  };
}

function handlePayload(state, data) {
  const topic = data.topic || '';
  if (typeof topic !== 'string' || !topic.startsWith('crypto_prices')) return;

  const payload = data.payload;
  if (!payload || typeof payload !== 'object') return;

  const apply = (value, ts) => {
    state.btc = parseFloat(value);
    state.rtdsTs = ts != null ? parseInt(ts, 10) : null;
    state.rtdsReceivedAt = Date.now();
  };

  if (Array.isArray(payload.data) && payload.data.length) {
    const last = payload.data[payload.data.length - 1];
    apply(last.value, last.timestamp);
    return;
  }
  if (payload.value != null) apply(payload.value, payload.timestamp);
}
