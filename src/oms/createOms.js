/**
 * OMS — idempotência, estados de ordem, fills parciais, sem expor exchange id à strategy.
 */

import { createJournal } from './journal.js';
import { createPositionLedger } from './positionLedger.js';
import { canTransition, isTerminal, ORDER_STATES } from './states.js';
import { materializeOrderRequest } from './marketRules.js';

/**
 * @param {object} [opts]
 * @param {() => number} [opts.clock]
 * @param {object} [opts.marketRules]
 * @param {object} [opts.journal]
 */
export function createOms(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const journal = opts.journal ?? createJournal({ clock });
  const positions = opts.positions ?? createPositionLedger();
  const marketRules = opts.marketRules ?? {};

  /** @type {Map<string, object>} intentId → order */
  const byIntent = new Map();
  /** @type {Map<string, string>} exchangeOrderId → intentId */
  const byExchangeId = new Map();
  /** @type {Set<string>} */
  const seenEventIds = new Set();

  let orderSeq = 0;

  function publicOrder(order) {
    const { exchangeOrderId, ...rest } = order;
    return {
      ...rest,
      // strategy/UI ops: nunca precisam do id bruto; ops interno usa getOrderRaw
      hasExchangeId: Boolean(exchangeOrderId),
    };
  }

  function getOrderRaw(intentId) {
    return byIntent.get(intentId) ?? null;
  }

  function findOrderByExchangeId(exchangeOrderId) {
    const intentId = byExchangeId.get(exchangeOrderId);
    return intentId ? publicOrder(byIntent.get(intentId)) : null;
  }

  /**
   * Registra intenção de forma idempotente.
   * @param {import('../engine/schemas.js').TradeIntent} intent
   */
  function registerIntent(intent) {
    const existing = byIntent.get(intent.intentId);
    if (existing) {
      journal.append('intent_dedup', { intentId: intent.intentId, orderId: existing.orderId });
      return { order: publicOrder(existing), deduped: true, request: null };
    }

    const request = materializeOrderRequest(intent, marketRules);
    if (!request.valid && intent.kind !== 'CANCEL') {
      orderSeq += 1;
      const rejected = {
        orderId: `ord-${orderSeq}`,
        intentId: intent.intentId,
        strategyInstanceId: intent.strategyInstanceId,
        marketId: intent.marketId,
        kind: intent.kind,
        tokenSide: intent.side,
        state: 'REJECTED',
        qty: 0,
        qtyFilled: 0,
        price: null,
        orderType: request.orderType,
        exchangeOrderId: null,
        reason: 'INVALID_SIZE_OR_PRICE',
        timeline: [{ state: 'REJECTED', tsMs: clock(), reason: 'INVALID_SIZE_OR_PRICE' }],
        createdAtMs: clock(),
        updatedAtMs: clock(),
      };
      byIntent.set(intent.intentId, rejected);
      journal.append('order', { action: 'reject_local', order: publicOrder(rejected) });
      return { order: publicOrder(rejected), deduped: false, request };
    }

    orderSeq += 1;
    const order = {
      orderId: `ord-${orderSeq}`,
      intentId: intent.intentId,
      strategyInstanceId: intent.strategyInstanceId,
      marketId: intent.marketId,
      kind: intent.kind,
      tokenSide: intent.side,
      state: 'CREATED',
      qty: request.size ?? 0,
      qtyFilled: 0,
      price: request.price,
      orderType: request.orderType,
      tradeSide: request.tradeSide,
      exchangeOrderId: null,
      reason: intent.reason,
      timeline: [{ state: 'CREATED', tsMs: clock() }],
      createdAtMs: clock(),
      updatedAtMs: clock(),
    };
    byIntent.set(intent.intentId, order);
    journal.append('order', { action: 'created', order: publicOrder(order) });
    return { order: publicOrder(order), deduped: false, request };
  }

  function transition(order, to, meta = {}) {
    if (!canTransition(order.state, to)) {
      journal.append('order_transition_blocked', {
        intentId: order.intentId,
        from: order.state,
        to,
        ...meta,
      });
      return false;
    }
    order.state = to;
    order.updatedAtMs = clock();
    order.timeline.push({ state: to, tsMs: order.updatedAtMs, ...meta });
    journal.append('order_transition', {
      intentId: order.intentId,
      to,
      ...meta,
    });
    return true;
  }

  /**
   * Evento vindo do transport (sim / WS / REST).
   * Idempotente por eventId.
   * @param {object} event
   */
  function applyExchangeEvent(event) {
    if (event.eventId && seenEventIds.has(event.eventId)) {
      journal.append('event_dedup', { eventId: event.eventId });
      return { applied: false, reason: 'DUPLICATE_EVENT', executionEvents: [] };
    }
    if (event.eventId) seenEventIds.add(event.eventId);

    let intentId = event.intentId ?? null;
    if (!intentId && event.exchangeOrderId) {
      intentId = byExchangeId.get(event.exchangeOrderId) ?? null;
    }
    if (!intentId) {
      journal.append('event_orphan', { event });
      return { applied: false, reason: 'ORPHAN_EVENT', executionEvents: [] };
    }

    const order = byIntent.get(intentId);
    if (!order) {
      return { applied: false, reason: 'UNKNOWN_INTENT', executionEvents: [] };
    }

    if (event.exchangeOrderId) {
      order.exchangeOrderId = event.exchangeOrderId;
      byExchangeId.set(event.exchangeOrderId, intentId);
    }

    const executionEvents = [];
    const type = event.type;

    if (type === 'ACK' || type === 'LIVE') {
      if (!isTerminal(order.state)) transition(order, 'LIVE', { source: type });
      executionEvents.push(toExecEvent(order, 'ACK', event));
    } else if (type === 'PARTIAL' || type === 'FILL') {
      const fillQty = Number(event.qty) || 0;
      const price = event.price != null ? Number(event.price) : order.price;
      if (fillQty > 0) {
        order.qtyFilled = Math.min(order.qty || fillQty, order.qtyFilled + fillQty);
        positions.applyFill({
          strategyInstanceId: order.strategyInstanceId,
          marketId: order.marketId,
          side: order.tokenSide,
          qty: fillQty,
          price,
          kind: order.kind,
        });
      }
      const done = order.qty > 0 && order.qtyFilled >= order.qty;
      const nextState = done || type === 'FILL' ? 'MATCHED' : 'PARTIAL';
      // FILL total sem qty na ordem (shadow qty inferido)
      if (type === 'FILL' && order.qty <= 0 && fillQty > 0) {
        order.qty = fillQty;
        order.qtyFilled = fillQty;
        transition(order, 'MATCHED', { source: type });
      } else {
        transition(order, nextState === 'MATCHED' ? 'MATCHED' : 'PARTIAL', { source: type });
      }
      executionEvents.push(
        toExecEvent(order, type === 'FILL' || nextState === 'MATCHED' ? 'FILL' : 'PARTIAL', {
          ...event,
          qty: fillQty,
          price,
        }),
      );
    } else if (type === 'CANCEL') {
      transition(order, order.state === 'LIVE' || order.state === 'PARTIAL' ? 'CANCEL_PENDING' : order.state);
      transition(order, 'CANCELED', { source: 'CANCEL' });
      executionEvents.push(toExecEvent(order, 'CANCEL', event));
    } else if (type === 'REJECT') {
      transition(order, 'REJECTED', { source: 'REJECT', reason: event.reason });
      executionEvents.push(toExecEvent(order, 'REJECT', event));
    } else if (type === 'UNKNOWN') {
      transition(order, 'UNKNOWN', { source: 'UNKNOWN' });
      executionEvents.push(toExecEvent(order, 'UNKNOWN', event));
    } else {
      journal.append('event_unhandled', { event });
      return { applied: false, reason: 'UNHANDLED', executionEvents: [] };
    }

    return { applied: true, order: publicOrder(order), executionEvents };
  }

  function toExecEvent(order, type, event) {
    return {
      eventId: event.eventId ?? `oms-${order.intentId}-${type}-${clock()}`,
      intentId: order.intentId,
      type,
      side: order.tokenSide,
      qty: event.qty ?? 0,
      price: event.price ?? order.price,
      reason: event.reason ?? order.reason,
      tsMs: event.tsMs ?? clock(),
    };
  }

  function markUnknown(intentId, reason = 'lost_ack') {
    const order = byIntent.get(intentId);
    if (!order || isTerminal(order.state)) return null;
    transition(order, 'UNKNOWN', { reason });
    return publicOrder(order);
  }

  function bindExchangeId(intentId, exchangeOrderId) {
    const order = byIntent.get(intentId);
    if (!order) return;
    order.exchangeOrderId = exchangeOrderId;
    byExchangeId.set(exchangeOrderId, intentId);
    journal.append('bind_exchange_id', { intentId, exchangeOrderId });
  }

  /**
   * Reconstrói OMS a partir do último checkpoint no journal.
   * @param {object[]} entries
   */
  function restoreFromJournal(entries) {
    byIntent.clear();
    byExchangeId.clear();
    seenEventIds.clear();
    positions.importAll({});
    orderSeq = 0;

    let latest = null;
    for (const entry of entries) {
      if (entry.type === 'checkpoint') latest = entry;
    }

    if (latest) {
      for (const [intentId, order] of Object.entries(latest.orders ?? {})) {
        const copy = { ...order, timeline: [...(order.timeline ?? [])] };
        byIntent.set(intentId, copy);
        if (copy.exchangeOrderId) byExchangeId.set(copy.exchangeOrderId, intentId);
        const n = Number(String(copy.orderId).replace(/\D/g, ''));
        if (Number.isFinite(n)) orderSeq = Math.max(orderSeq, n);
      }
      positions.importAll(latest.positions ?? {});
      for (const id of latest.seenEventIds ?? []) seenEventIds.add(id);
    }

    journal.replaceAll(entries.map((e) => ({ ...e })));
  }

  function checkpoint() {
    const orders = {};
    for (const [k, v] of byIntent) {
      orders[k] = { ...v, timeline: [...v.timeline] };
    }
    const entry = journal.append('checkpoint', {
      orders,
      positions: positions.exportAll(),
      seenEventIds: [...seenEventIds],
    });
    return entry;
  }

  function openOrders() {
    return [...byIntent.values()]
      .filter((o) => !isTerminal(o.state))
      .map((o) => publicOrder(o));
  }

  function listOrders() {
    return [...byIntent.values()].map((o) => publicOrder(o));
  }

  /**
   * Settlement binário ($0/$1) — zera posição no ledger sem ordem CLOB.
   * @param {{ strategyInstanceId: string, price: number, marketId?: string, reason?: string }} opts
   */
  function settlePosition(opts = {}) {
    const instanceId = opts.strategyInstanceId;
    const price = Number(opts.price);
    if (!instanceId) throw new Error('settlePosition: strategyInstanceId obrigatório');
    if (!Number.isFinite(price) || price < 0 || price > 1) {
      throw new Error('settlePosition: price inválido');
    }
    const before = positions.get(instanceId);
    if (!(before.qty > 0)) {
      return { settled: false, reason: 'FLAT', position: before };
    }
    const after = positions.applyFill({
      strategyInstanceId: instanceId,
      marketId: opts.marketId ?? before.marketId,
      side: before.side,
      qty: before.qty,
      price,
      kind: 'EXIT',
    });
    journal.append('settlement', {
      strategyInstanceId: instanceId,
      marketId: before.marketId,
      side: before.side,
      qty: before.qty,
      avgPrice: before.avgPrice,
      settlementPrice: price,
      reason: opts.reason ?? 'settlement',
      position: after,
    });
    return { settled: true, before, position: after };
  }

  return {
    registerIntent,
    applyExchangeEvent,
    markUnknown,
    bindExchangeId,
    getOrder: (intentId) => {
      const o = byIntent.get(intentId);
      return o ? publicOrder(o) : null;
    },
    getOrderRaw,
    findOrderByExchangeId,
    openOrders,
    listOrders,
    settlePosition,
    position: (instanceId) => positions.get(instanceId),
    accountExposure: () => positions.accountExposure(),
    journal,
    checkpoint,
    restoreFromJournal,
    ORDER_STATES,
  };
}
