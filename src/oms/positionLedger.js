/**
 * Posição consolidada por strategyInstanceId + exposição agregada da conta.
 * Estratégia só vê PositionView — nunca exchange order id.
 */

import { emptyPosition } from '../engine/schemas.js';

export function createPositionLedger() {
  /** @type {Map<string, import('../engine/schemas.js').PositionView>} */
  const byInstance = new Map();

  function get(instanceId) {
    return { ...(byInstance.get(instanceId) ?? emptyPosition()) };
  }

  function set(instanceId, position) {
    byInstance.set(instanceId, { ...position });
  }

  /**
   * Aplica fill de compra/venda na posição da instância.
   * @param {object} opts
   */
  function applyFill(opts) {
    const {
      strategyInstanceId,
      marketId,
      side,
      qty,
      price,
      kind = 'ENTER',
    } = opts;
    const q = Number(qty) || 0;
    if (q <= 0 || !side) return get(strategyInstanceId);

    let pos = get(strategyInstanceId);

    if (kind === 'ENTER' || kind === 'REVERSE') {
      if (kind === 'REVERSE' && pos.qty > 0 && pos.side && pos.side !== side) {
        pos = emptyPosition({ marketId: pos.marketId ?? marketId, realizedPnl: pos.realizedPnl });
      }
      const prevQty = pos.qty;
      const prevAvg = pos.avgPrice ?? price;
      const newQty = prevQty + q;
      const avgPrice =
        price != null && prevAvg != null && newQty > 0
          ? (prevAvg * prevQty + price * q) / newQty
          : price;
      pos = {
        marketId: marketId ?? pos.marketId,
        side,
        qty: newQty,
        avgPrice,
        realizedPnl: pos.realizedPnl,
      };
    } else if (kind === 'EXIT') {
      const closeQty = Math.min(pos.qty, q);
      if (pos.avgPrice != null && price != null) {
        const dir = pos.side === 'UP' ? 1 : -1;
        pos.realizedPnl += dir * (price - pos.avgPrice) * closeQty;
      }
      const remain = Math.max(0, pos.qty - closeQty);
      pos = {
        marketId: pos.marketId ?? marketId,
        side: remain <= 0 ? null : pos.side,
        qty: remain,
        avgPrice: remain <= 0 ? null : pos.avgPrice,
        realizedPnl: pos.realizedPnl,
      };
    }

    set(strategyInstanceId, pos);
    return get(strategyInstanceId);
  }

  function accountExposure() {
    let qty = 0;
    let notional = 0;
    for (const pos of byInstance.values()) {
      qty += pos.qty;
      if (pos.avgPrice != null) notional += pos.qty * pos.avgPrice;
    }
    return { openQty: qty, openNotional: notional, instances: byInstance.size };
  }

  function exportAll() {
    return Object.fromEntries([...byInstance.entries()].map(([k, v]) => [k, { ...v }]));
  }

  function importAll(map) {
    byInstance.clear();
    for (const [k, v] of Object.entries(map ?? {})) {
      byInstance.set(k, { ...emptyPosition(), ...v });
    }
  }

  return { get, set, applyFill, accountExposure, exportAll, importAll };
}
