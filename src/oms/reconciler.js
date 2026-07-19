/**
 * Reconciler — UNKNOWN, eventos duplicados, divergência REST vs journal.
 */

import { isTerminal } from '../oms/states.js';

/**
 * @param {object} oms
 */
export function createReconciler(oms) {
  /**
   * Resolve ordens UNKNOWN com snapshot REST/sim.
   * @param {Array<{ exchangeOrderId?: string, intentId?: string, status: string, qtyFilled?: number, price?: number }>} remoteOrders
   */
  function reconcileOpenOrders(remoteOrders = []) {
    const report = {
      resolved: [],
      stillUnknown: [],
      orphans: [],
    };

    const byExchange = new Map();
    const byIntent = new Map();
    for (const r of remoteOrders) {
      if (r.exchangeOrderId) byExchange.set(r.exchangeOrderId, r);
      if (r.intentId) byIntent.set(r.intentId, r);
    }

    for (const order of oms.listOrders()) {
      if (order.state !== 'UNKNOWN') continue;
      const raw = oms.getOrderRaw(order.intentId);
      const remote =
        (raw?.exchangeOrderId && byExchange.get(raw.exchangeOrderId)) ||
        byIntent.get(order.intentId);

      if (!remote) {
        report.stillUnknown.push(order.intentId);
        continue;
      }

      const status = String(remote.status).toUpperCase();
      if (status === 'MATCHED' || status === 'FILLED') {
        const applied = oms.applyExchangeEvent({
          eventId: `recon-fill-${order.intentId}-${remote.qtyFilled ?? order.qty}`,
          intentId: order.intentId,
          exchangeOrderId: remote.exchangeOrderId ?? raw?.exchangeOrderId,
          type: 'FILL',
          qty: remote.qtyFilled ?? order.qty,
          price: remote.price ?? order.price,
          reason: 'reconcile',
          tsMs: Date.now(),
        });
        report.resolved.push({ intentId: order.intentId, to: 'MATCHED', applied });
      } else if (status === 'CANCELED' || status === 'CANCELLED') {
        oms.applyExchangeEvent({
          eventId: `recon-cancel-${order.intentId}`,
          intentId: order.intentId,
          type: 'CANCEL',
          reason: 'reconcile',
          tsMs: Date.now(),
        });
        report.resolved.push({ intentId: order.intentId, to: 'CANCELED' });
      } else if (status === 'LIVE' || status === 'OPEN') {
        oms.applyExchangeEvent({
          eventId: `recon-live-${order.intentId}`,
          intentId: order.intentId,
          type: 'ACK',
          reason: 'reconcile',
          tsMs: Date.now(),
        });
        report.resolved.push({ intentId: order.intentId, to: 'LIVE' });
      } else {
        report.stillUnknown.push(order.intentId);
      }
    }

    for (const r of remoteOrders) {
      const known =
        (r.intentId && oms.getOrder(r.intentId)) ||
        (r.exchangeOrderId &&
          oms.listOrders().some((o) => oms.getOrderRaw(o.intentId)?.exchangeOrderId === r.exchangeOrderId));
      if (!known) report.orphans.push(r);
    }

    return report;
  }

  /**
   * Garante que toda ordem não-terminal tenha timeline até estado final
   * após um ciclo de sim (teste de gate).
   */
  function assertAllTerminalOrOpen(allowedOpen = true) {
    const bad = [];
    for (const order of oms.listOrders()) {
      if (order.state === 'UNKNOWN') bad.push(order);
      if (!allowedOpen && !isTerminal(order.state)) bad.push(order);
    }
    return { ok: bad.length === 0, bad };
  }

  return { reconcileOpenOrders, assertAllTerminalOrOpen };
}
