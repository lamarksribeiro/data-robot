/**
 * Transport CLOB real (P7) — client injetável (mockável em testes).
 * Sem client → use createLiveTransportStub.
 */

/**
 * @param {object} opts
 * @param {object} opts.client — ClobClient (ou mock) com createAndPostOrder / cancelOrder / getOpenOrders
 * @param {object} opts.Side — enum Side do SDK ({ BUY, SELL })
 * @param {object} opts.OrderType — enum OrderType ({ GTC, FAK, FOK })
 * @param {(tokenSide: string, request: object, order: object) => string|null} [opts.resolveTokenId]
 * @param {() => number} [opts.clock]
 * @param {boolean} [opts.postOnly]
 */
export function createLiveTransport(opts) {
  if (!opts?.client) throw new Error('createLiveTransport: client obrigatório');
  if (!opts.Side || !opts.OrderType) {
    throw new Error('createLiveTransport: Side e OrderType obrigatórios (SDK)');
  }

  const client = opts.client;
  const Side = opts.Side;
  const OrderType = opts.OrderType;
  const clock = opts.clock ?? (() => Date.now());
  const resolveTokenId =
    opts.resolveTokenId ??
    ((tokenSide, request) => request.tokenId ?? null);
  const postOnly = opts.postOnly === true;
  const log = [];

  function mapOrderType(name) {
    const key = String(name || 'GTC').toUpperCase();
    return OrderType[key] ?? OrderType.GTC;
  }

  function mapTradeSide(tradeSide) {
    if (tradeSide === 'SELL') return Side.SELL;
    return Side.BUY;
  }

  function isFilledStatus(status) {
    const s = String(status || '').toLowerCase();
    return s === 'matched' || s === 'filled' || s.includes('match');
  }

  return {
    kind: 'live',
    log,

    /**
     * @param {object} request — materializeOrderRequest
     * @param {object} order — ordem OMS
     */
    async submit(request, order) {
      const tsMs = clock();
      const tokenId = resolveTokenId(request.tokenSide ?? order.tokenSide, request, order);
      if (!tokenId) {
        return {
          accepted: false,
          exchangeOrderId: null,
          events: [
            {
              eventId: `live-rej-token-${order.intentId}`,
              intentId: order.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: 'NO_TOKEN_ID',
              tsMs,
            },
          ],
        };
      }
      if (request.price == null || request.size == null || request.size <= 0) {
        return {
          accepted: false,
          exchangeOrderId: null,
          events: [
            {
              eventId: `live-rej-size-${order.intentId}`,
              intentId: order.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: 'INVALID_SIZE_OR_PRICE',
              tsMs,
            },
          ],
        };
      }

      try {
        const resp = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: request.price,
            side: mapTradeSide(request.tradeSide),
            size: request.size,
          },
          undefined,
          mapOrderType(request.orderType),
          postOnly,
          false,
        );

        log.push({
          action: 'submit',
          intentId: order.intentId,
          tokenId,
          orderId: resp?.orderID,
          status: resp?.status,
          tsMs,
        });

        if (!resp?.success || !resp?.orderID) {
          return {
            accepted: false,
            exchangeOrderId: null,
            events: [
              {
                eventId: `live-rej-${order.intentId}`,
                intentId: order.intentId,
                type: 'REJECT',
                qty: 0,
                price: null,
                reason: resp?.errorMsg || 'CLOB_REJECT',
                tsMs,
              },
            ],
          };
        }

        const exchangeOrderId = resp.orderID;
        const events = [
          {
            eventId: `live-ack-${order.intentId}`,
            intentId: order.intentId,
            exchangeOrderId,
            type: 'ACK',
            qty: 0,
            price: request.price,
            reason: `clob:${resp.status ?? 'accepted'}`,
            tsMs,
          },
        ];

        if (isFilledStatus(resp.status)) {
          events.push({
            eventId: `live-fill-${order.intentId}`,
            intentId: order.intentId,
            exchangeOrderId,
            type: 'FILL',
            side: order.tokenSide,
            qty: request.size,
            price: request.price,
            reason: 'clob_matched',
            tsMs: tsMs + 1,
          });
        }

        return { accepted: true, exchangeOrderId, events };
      } catch (err) {
        log.push({ action: 'submit_error', intentId: order.intentId, error: err.message, tsMs });
        return {
          accepted: false,
          exchangeOrderId: null,
          events: [
            {
              eventId: `live-err-${order.intentId}`,
              intentId: order.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: err.message || 'CLOB_ERROR',
              tsMs,
            },
          ],
        };
      }
    },

    async cancel(order) {
      const tsMs = clock();
      const exchangeOrderId = order?.exchangeOrderId;
      if (!exchangeOrderId) {
        return {
          accepted: false,
          events: [
            {
              eventId: `live-cancel-miss-${order?.intentId ?? 'unknown'}`,
              intentId: order?.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: 'NO_EXCHANGE_ORDER_ID',
              tsMs,
            },
          ],
        };
      }

      try {
        const resp = await client.cancelOrder({ orderID: exchangeOrderId });
        const ok =
          resp?.success === true ||
          (Array.isArray(resp?.canceled) && resp.canceled.includes(exchangeOrderId));
        log.push({ action: 'cancel', intentId: order.intentId, exchangeOrderId, ok, tsMs });
        return {
          accepted: ok,
          events: [
            {
              eventId: `live-cancel-${order.intentId}`,
              intentId: order.intentId,
              exchangeOrderId,
              type: ok ? 'CANCEL' : 'REJECT',
              qty: 0,
              price: null,
              reason: ok ? 'clob_cancel' : resp?.errorMsg || 'CANCEL_FAILED',
              tsMs,
            },
          ],
        };
      } catch (err) {
        return {
          accepted: false,
          events: [
            {
              eventId: `live-cancel-err-${order.intentId}`,
              intentId: order.intentId,
              exchangeOrderId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: err.message || 'CANCEL_ERROR',
              tsMs,
            },
          ],
        };
      }
    },

    async getOpenOrders() {
      if (typeof client.getOpenOrders !== 'function') return [];
      return client.getOpenOrders();
    },
  };
}

/**
 * Mock CLOB para testes P7 (sem rede).
 * @param {object} [opts]
 * @param {'matched'|'live'|'reject'} [opts.behavior]
 */
export function createMockClobClient(opts = {}) {
  const behavior = opts.behavior ?? 'matched';
  let seq = 0;
  const orders = new Map();

  return {
    kind: 'mock-clob',
    orders,
    async createAndPostOrder(args) {
      if (behavior === 'reject') {
        return { success: false, errorMsg: 'mock-reject', orderID: null };
      }
      seq += 1;
      const orderID = `mock-ord-${seq}`;
      const status = behavior === 'matched' ? 'matched' : 'live';
      orders.set(orderID, { ...args, orderID, status });
      return { success: true, orderID, status };
    },
    async cancelOrder({ orderID }) {
      if (!orders.has(orderID)) return { success: false, canceled: [] };
      orders.delete(orderID);
      return { success: true, canceled: [orderID] };
    },
    async getOpenOrders() {
      return [...orders.values()].filter((o) => o.status === 'live').map((o) => ({ id: o.orderID }));
    },
    async getTrades() {
      return [];
    },
  };
}
