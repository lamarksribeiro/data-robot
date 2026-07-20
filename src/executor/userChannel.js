import WebSocket from 'ws';

/**
 * User channel autenticado. `sim` permanece disponível apenas para CI/shadow.
 */
export function createUserChannel(opts = {}) {
  const kind = opts.kind ?? 'sim';
  const listeners = new Set();
  const disconnectListeners = new Set();
  const clock = opts.clock ?? (() => Date.now());
  let heartbeatTimer = null;
  let lastHeartbeatMs = null;
  let connected = false;
  let socket = null;

  function emit(event) {
    for (const fn of listeners) fn(event);
  }

  function notifyDisconnect(detail) {
    for (const fn of disconnectListeners) fn(detail);
  }

  function subscription() {
    const auth = opts.auth ?? {};
    if (!auth.apiKey || !auth.secret || !auth.passphrase) {
      throw new Error('user WS exige apiKey, secret e passphrase');
    }
    return {
      auth: {
        apiKey: auth.apiKey,
        secret: auth.secret,
        passphrase: auth.passphrase,
      },
      markets: Array.isArray(opts.markets) ? opts.markets.filter(Boolean) : [],
      type: 'user',
    };
  }

  return {
    kind,
    get connected() {
      return connected;
    },
    get lastHeartbeatMs() {
      return lastHeartbeatMs;
    },

    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    onDisconnect(fn) {
      disconnectListeners.add(fn);
      return () => disconnectListeners.delete(fn);
    },

    /** Injeta evento em sim/testes. */
    push(event) {
      emit(event);
    },

    connect() {
      if (kind !== 'ws') {
        connected = true;
        lastHeartbeatMs = clock();
        return { ok: true, kind };
      }
      if (connected) return Promise.resolve({ ok: true, kind });

      const payload = subscription();
      const url = opts.url ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket?.terminate();
          reject(new Error('user WS connect timeout'));
        }, Number(opts.connectTimeoutMs ?? 10_000));
        socket = new WebSocket(url);
        socket.once('open', () => {
          clearTimeout(timeout);
          connected = true;
          lastHeartbeatMs = clock();
          socket.send(JSON.stringify(payload));
          resolve({ ok: true, kind });
        });
        socket.on('message', (data) => {
          const text = data.toString();
          if (text === 'PONG') {
            lastHeartbeatMs = clock();
            return;
          }
          try {
            const parsed = JSON.parse(text);
            for (const message of Array.isArray(parsed) ? parsed : [parsed]) emit(message);
          } catch {
            emit({ event_type: 'protocol_error', reason: 'INVALID_JSON', tsMs: clock() });
          }
        });
        socket.once('error', (err) => {
          clearTimeout(timeout);
          if (!connected) reject(new Error(`user WS: ${err.message}`));
        });
        socket.once('close', (code, reason) => {
          clearTimeout(timeout);
          const wasConnected = connected;
          connected = false;
          if (wasConnected) notifyDisconnect({ code, reason: reason.toString(), tsMs: clock() });
        });
      });
    },

    disconnect({ cancelOnDisconnect = true } = {}) {
      connected = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close(1000, 'client shutdown');
      }
      socket = null;
      return { ok: true, cancelOnDisconnect };
    },

    startHeartbeat(intervalMs = 10_000, onBeat) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (kind === 'ws' && socket?.readyState === WebSocket.OPEN) socket.send('PING');
        else lastHeartbeatMs = clock();
        if (typeof onBeat === 'function') onBeat(lastHeartbeatMs);
      }, intervalMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
      return () => {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };
    },

    async pollRest(fetcher) {
      if (!fetcher) return { ok: false, reason: 'REST_FETCHER_REQUIRED' };
      const events = await fetcher();
      for (const e of events ?? []) emit(e);
      return { ok: true, events, source: 'rest-poll' };
    },
  };
}

/** Converte mensagens oficiais do user WS em eventos incrementais do OMS. */
export function normalizeUserMessage(message, oms, clock = () => Date.now()) {
  if (!message || typeof message !== 'object') return [];
  const eventType = String(message.event_type ?? '').toLowerCase();
  const type = String(message.type ?? '').toUpperCase();
  const out = [];

  if (eventType === 'order') {
    const order = oms.findOrderByExchangeId?.(message.id);
    if (!order) return [];
    if (type === 'PLACEMENT') {
      out.push({
        eventId: `ws-order-placement-${message.id}`,
        exchangeOrderId: message.id,
        type: 'ACK',
        qty: 0,
        price: Number(message.price ?? order.price),
        reason: 'user_ws_placement',
        tsMs: Number(message.timestamp) * 1000 || clock(),
      });
    } else if (type === 'CANCELLATION') {
      out.push({
        eventId: `ws-order-cancel-${message.id}`,
        exchangeOrderId: message.id,
        type: 'CANCEL',
        qty: 0,
        price: Number(message.price ?? order.price),
        reason: 'user_ws_cancellation',
        tsMs: Number(message.timestamp) * 1000 || clock(),
      });
    }
  }

  if (eventType === 'trade' && String(message.status ?? '').toUpperCase() === 'MATCHED') {
    const candidates = [];
    if (message.taker_order_id) {
      candidates.push({
        orderId: message.taker_order_id,
        qty: Number(message.size),
        price: Number(message.price),
      });
    }
    for (const maker of message.maker_orders ?? []) {
      candidates.push({
        orderId: maker.order_id,
        qty: Number(maker.matched_amount),
        price: Number(maker.price),
      });
    }
    for (const fill of candidates) {
      const order = oms.findOrderByExchangeId?.(fill.orderId);
      if (!order || !Number.isFinite(fill.qty) || fill.qty <= 0) continue;
      const remaining = Math.max(0, Number(order.qty) - Number(order.qtyFilled));
      if (Number(order.qty) > 0 && remaining <= 0) continue;
      const qty = Math.min(remaining > 0 ? remaining : fill.qty, fill.qty);
      if (qty <= 0) continue;
      out.push({
        eventId: `ws-trade-${message.id}-${fill.orderId}`,
        exchangeOrderId: fill.orderId,
        type: qty >= remaining ? 'FILL' : 'PARTIAL',
        qty,
        price: Number.isFinite(fill.price) ? fill.price : order.price,
        reason: 'user_ws_trade_matched',
        tsMs: Number(message.timestamp) * 1000 || clock(),
        tradeId: message.id,
        tradeStatus: 'MATCHED',
      });
    }
  }

  return out;
}
