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

  let stopHeartbeat = null;

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
      if (request.deadlineMs != null && tsMs >= Number(request.deadlineMs)) {
        return {
          accepted: false,
          exchangeOrderId: null,
          events: [
            {
              eventId: `live-rej-deadline-${order.intentId}`,
              intentId: order.intentId,
              type: 'REJECT',
              qty: 0,
              price: null,
              reason: 'DEADLINE_EXPIRED',
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

        return {
          accepted: true,
          exchangeOrderId,
          events,
          placement: {
            status: resp.status ?? null,
            tradeIds: resp.tradeIDs ?? [],
            takingAmount: resp.takingAmount ?? null,
            makingAmount: resp.makingAmount ?? null,
          },
        };
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

    async reconcile(order) {
      const tsMs = clock();
      if (!order?.exchangeOrderId || typeof client.getOrder !== 'function') {
        return { ok: false, events: [], reason: 'GET_ORDER_UNAVAILABLE' };
      }
      try {
        const remote = await client.getOrder(order.exchangeOrderId);
        const original = Number(remote?.original_size ?? order.qty) || Number(order.qty) || 0;
        const matched = Number(remote?.size_matched ?? 0) || 0;
        const already = Number(order.qtyFilled ?? 0) || 0;
        const delta = Math.max(0, matched - already);
        const status = String(remote?.status ?? '').toUpperCase();
        const events = [];

        if (delta > 0) {
          let fillPrice = Number(remote?.price ?? order.price);
          const tradeIds = remote?.associate_trades ?? [];
          if (tradeIds.length && typeof client.getTrades === 'function') {
            const fills = [];
            for (const tradeId of tradeIds) {
              const trades = await client.getTrades({ id: tradeId }, true);
              for (const trade of trades ?? []) {
                if (trade.taker_order_id === order.exchangeOrderId) {
                  fills.push({ qty: Number(trade.size), price: Number(trade.price) });
                }
                for (const maker of trade.maker_orders ?? []) {
                  if (maker.order_id === order.exchangeOrderId) {
                    fills.push({ qty: Number(maker.matched_amount), price: Number(maker.price) });
                  }
                }
              }
            }
            const qty = fills.reduce((sum, fill) => sum + (Number(fill.qty) || 0), 0);
            if (qty > 0) {
              fillPrice =
                fills.reduce(
                  (sum, fill) => sum + (Number(fill.qty) || 0) * (Number(fill.price) || 0),
                  0,
                ) / qty;
            }
          }
          events.push({
            eventId: `rest-fill-${order.intentId}-${matched}`,
            intentId: order.intentId,
            exchangeOrderId: order.exchangeOrderId,
            type: matched >= original ? 'FILL' : 'PARTIAL',
            side: order.tokenSide,
            qty: delta,
            price: fillPrice,
            reason: 'rest_reconcile',
            tsMs,
          });
        }

        if (status === 'LIVE' || status === 'OPEN' || status === 'DELAYED') {
          if (events.length === 0) {
            events.push({
              eventId: `rest-ack-${order.intentId}-${status}`,
              intentId: order.intentId,
              exchangeOrderId: order.exchangeOrderId,
              type: 'ACK',
              qty: 0,
              price: Number(remote?.price ?? order.price),
              reason: `rest_${status.toLowerCase()}`,
              tsMs,
            });
          }
        } else if (
          ['CANCELED', 'CANCELLED', 'UNMATCHED'].includes(status) &&
          matched < original
        ) {
          events.push({
            eventId: `rest-cancel-${order.intentId}-${matched}`,
            intentId: order.intentId,
            exchangeOrderId: order.exchangeOrderId,
            type: 'CANCEL',
            qty: 0,
            price: Number(remote?.price ?? order.price),
            reason: `rest_${status.toLowerCase()}`,
            tsMs: tsMs + events.length,
          });
        }

        return { ok: true, events, remote };
      } catch (err) {
        return { ok: false, events: [], reason: err.message || 'RECONCILE_ERROR' };
      }
    },

    async cancelAll() {
      if (typeof client.cancelAll !== 'function') return { canceled: [], notCanceled: {} };
      const response = await client.cancelAll();
      return {
        canceled: response?.canceled ?? [],
        notCanceled: response?.not_canceled ?? {},
      };
    },

    async startHeartbeat(onFailure, intervalMs = 5000) {
      if (typeof client.postHeartbeat !== 'function') {
        throw new Error('CLOB heartbeat indisponível no client');
      }
      let heartbeatId = '';
      let busy = false;
      const invalidHeartbeatInfo = (value) => {
        let parsedMessage = null;
        if (typeof value?.message === 'string') {
          try {
            parsedMessage = JSON.parse(value.message);
          } catch {
            /* mensagem textual comum */
          }
        }
        const candidates = [
          value,
          value?.error,
          value?.data,
          value?.data?.error,
          parsedMessage,
          parsedMessage?.error,
        ].filter(Boolean);
        const message = candidates
          .map((candidate) => candidate?.error_msg ?? candidate?.message ?? '')
          .find((candidate) => /Invalid Heartbeat ID/i.test(String(candidate)));
        if (!message) {
          const fallback = String(value?.message ?? value ?? '');
          if (!/Invalid Heartbeat ID/i.test(fallback)) return null;
        }
        const heartbeatIdFromError = candidates
          .map((candidate) => candidate?.heartbeat_id)
          .find((candidate) => typeof candidate === 'string' && candidate.length > 0);
        return {
          heartbeatId: heartbeatIdFromError ?? null,
          message: String(message ?? value?.message ?? 'Invalid Heartbeat ID'),
        };
      };
      const postWithRecovery = async (initialId) => {
        let candidateId = initialId;
        let emptyResetTried = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const response = await client.postHeartbeat(candidateId);
            const invalid = invalidHeartbeatInfo(response);
            if (invalid) {
              const error = new Error(invalid.message);
              error.heartbeat_id = invalid.heartbeatId;
              throw error;
            }
            return response;
          } catch (err) {
            const invalid = invalidHeartbeatInfo(err);
            if (!invalid || attempt === 2) throw err;
            if (invalid.heartbeatId && invalid.heartbeatId !== candidateId) {
              candidateId = invalid.heartbeatId;
              continue;
            }
            if (!emptyResetTried) {
              candidateId = '';
              emptyResetTried = true;
              continue;
            }
            throw err;
          }
        }
        throw new Error('CLOB heartbeat recovery exhausted');
      };
      const beat = async (failClosed = false) => {
        if (busy) return;
        busy = true;
        try {
          const response = await postWithRecovery(heartbeatId);
          heartbeatId = response?.heartbeat_id ?? heartbeatId;
        } catch (err) {
          if (typeof onFailure === 'function') onFailure(err);
          if (failClosed) throw err;
        } finally {
          busy = false;
        }
      };
      await beat(true);
      const timer = setInterval(beat, intervalMs);
      if (timer.unref) timer.unref();
      stopHeartbeat = () => clearInterval(timer);
      return stopHeartbeat;
    },

    stopHeartbeat() {
      stopHeartbeat?.();
      stopHeartbeat = null;
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
      orders.set(orderID, {
        ...args,
        id: orderID,
        orderID,
        status,
        original_size: String(args.size),
        size_matched: behavior === 'matched' ? String(args.size) : '0',
        price: String(args.price),
        associate_trades: [],
      });
      return {
        success: true,
        orderID,
        status,
        takingAmount: behavior === 'matched' ? String(args.size) : '0',
        makingAmount: behavior === 'matched' ? String(args.size * args.price) : '0',
        tradeIDs: [],
      };
    },
    async cancelOrder({ orderID }) {
      if (!orders.has(orderID)) return { success: false, canceled: [] };
      orders.delete(orderID);
      return { success: true, canceled: [orderID] };
    },
    async getOpenOrders() {
      return [...orders.values()].filter((o) => o.status === 'live').map((o) => ({ id: o.orderID }));
    },
    async getOrder(orderID) {
      const order = orders.get(orderID);
      if (!order) throw new Error('mock order not found');
      return { ...order };
    },
    async getTrades() {
      return [];
    },
    async postHeartbeat(id = '') {
      return { heartbeat_id: id || 'mock-heartbeat' };
    },
    async cancelAll() {
      const canceled = [...orders.keys()];
      orders.clear();
      return { canceled, not_canceled: {} };
    },
  };
}
