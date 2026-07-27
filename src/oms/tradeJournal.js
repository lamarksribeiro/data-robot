/**
 * Monta journal de trades a partir do execution-audit + OMS.
 * PnL preferencial: cashflow real da Data API Polymarket (BUY/SELL/REDEEM).
 */

/**
 * @param {object[]} orders
 * @param {string} marketId
 * @param {'ENTER'|'EXIT'|'REVERSE'} kind
 */
function filledOrder(orders, marketId, kind) {
  const hits = orders.filter((o) => {
    if (o.marketId !== marketId || o.kind !== kind) return false;
    if (Number(o.qtyFilled) > 0) return true;
    return o.state === 'MATCHED';
  });
  return hits.at(-1) ?? null;
}

function filledEnterOrder(orders, marketId) {
  return filledOrder(orders, marketId, 'ENTER');
}

function pushLeg(trade, leg) {
  const last = trade.legs.at(-1);
  if (
    last &&
    last.kind === leg.kind &&
    last.price === leg.price &&
    last.qty === leg.qty &&
    Math.abs((last.tsMs ?? 0) - (leg.tsMs ?? 0)) < 5
  ) {
    return;
  }
  trade.legs.push(leg);
}

function addPnl(trade, delta) {
  if (!Number.isFinite(delta)) return;
  trade.pnl = (Number.isFinite(trade.pnl) ? trade.pnl : 0) + delta;
}

function computeExitPnl(trade) {
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  const qty = Number(trade.qty);
  if (![entry, exit, qty].every(Number.isFinite) || qty <= 0) return null;
  return (exit - entry) * qty;
}

/**
 * PnL a partir das pernas quando possível (ENTER/EXIT/SETTLEMENT).
 * @param {{ legs?: object[], entryPrice?: number|null }} trade
 */
export function computePnlFromLegs(trade) {
  const legs = trade?.legs ?? [];
  const entryLeg = [...legs].reverse().find((l) => l.kind === 'ENTER') ?? null;
  const entryPrice = Number(entryLeg?.price ?? trade?.entryPrice);
  if (!Number.isFinite(entryPrice)) return null;
  let pnl = 0;
  let sawClose = false;
  for (const leg of legs) {
    if (leg.kind !== 'EXIT' && leg.kind !== 'REVERSE' && leg.kind !== 'SETTLEMENT') continue;
    const price = Number(leg.price);
    const qty = Number(leg.qty);
    if (![price, qty].every(Number.isFinite) || qty <= 0) continue;
    pnl += (price - entryPrice) * qty;
    sawClose = true;
  }
  return sawClose ? pnl : null;
}

/**
 * Sobrescreve PnL/qty/entry com cashflow real da Polymarket quando houver BUY.
 * @param {object[]} trades
 * @param {Map<string, object>|Iterable<[string, object]>} cashflowsByMarket
 */
export function reconcileTradesWithPolymarketCashflows(trades = [], cashflowsByMarket) {
  const map =
    cashflowsByMarket instanceof Map
      ? cashflowsByMarket
      : new Map(cashflowsByMarket ?? []);
  return (trades || []).map((trade) => {
    const cf = map.get(trade.marketId);
    if (!cf || !(cf.buyUsd > 0)) return trade;
    const next = { ...trade };
    next.pnlSource = 'polymarket';
    next.pnl = Number(cf.pnl);
    if (cf.avgBuyPrice != null && Number.isFinite(cf.avgBuyPrice)) {
      next.entryPrice = cf.avgBuyPrice;
    }
    if (cf.buyQty > 0) next.qty = cf.buyQty;
    if (cf.sellUsd > 0 || cf.redeemUsd > 0) {
      next.status = 'closed';
      if (cf.lastTsSec != null) {
        const closedMs = Number(cf.lastTsSec) * 1000;
        if (Number.isFinite(closedMs)) next.closedAtMs = closedMs;
      }
      if (cf.redeemUsd > 0) {
        next.exitKind = 'SETTLEMENT';
        next.exitPrice = 1;
      } else if (cf.sellUsd > 0 && cf.sellQty > 0) {
        next.exitKind = next.exitKind === 'SETTLEMENT' ? 'SETTLEMENT' : 'EXIT';
        next.exitPrice = cf.sellUsd / cf.sellQty;
      }
    }
    if (next.openedAtMs && next.closedAtMs) {
      next.durationMs = Math.max(0, next.closedAtMs - next.openedAtMs);
    }
    next.polymarket = {
      buyUsd: cf.buyUsd,
      sellUsd: cf.sellUsd,
      redeemUsd: cf.redeemUsd,
      pnl: cf.pnl,
    };
    return next;
  });
}

/**
 * Curva de equity: PnL acumulado no tempo a partir de trades fechados.
 * Espelha `buildEquityCurveFromEvents` do data-backtest.
 * @param {Array<{ status?: string, pnl?: number|null, closedAtMs?: number|null, openedAtMs?: number|null }>} trades
 * @returns {Array<{ ts: number, pnl: number }>}
 */
export function buildEquityCurveFromTrades(trades = []) {
  const closed = (trades || [])
    .filter((trade) => trade?.status === 'closed')
    .map((trade) => {
      const pnl = Number(trade.pnl);
      const ts = Number(trade.closedAtMs ?? trade.openedAtMs);
      if (!Number.isFinite(pnl) || !Number.isFinite(ts)) return null;
      return { ts, pnl };
    })
    .filter(Boolean)
    .sort((left, right) => left.ts - right.ts);

  let cumulative = 0;
  return closed.map((point) => {
    cumulative += point.pnl;
    return { ts: point.ts, pnl: cumulative };
  });
}

/**
 * Soma PnL fechado em ganhos vs perdas (para UI).
 * @param {Array<{ status?: string, pnl?: number|null }>} trades
 */
export function summarizeTradePnl(trades = []) {
  let net = 0;
  let won = 0;
  let lost = 0;
  let wins = 0;
  let losses = 0;
  let pending = 0;
  let closed = 0;
  let breakeven = 0;
  for (const trade of trades) {
    if (trade?.status === 'settlement_pending') {
      pending += 1;
      continue;
    }
    if (trade?.status !== 'closed') continue;
    const pnl = Number(trade.pnl);
    if (!Number.isFinite(pnl)) continue;
    closed += 1;
    net += pnl;
    if (pnl > 0) {
      won += pnl;
      wins += 1;
    } else if (pnl < 0) {
      lost += Math.abs(pnl);
      losses += 1;
    } else {
      breakeven += 1;
    }
  }
  const decided = wins + losses;
  return {
    net,
    won,
    lost,
    wins,
    losses,
    pending,
    closed,
    breakeven,
    decided,
    winRate: decided > 0 ? wins / decided : null,
  };
}

/**
 * @param {object} opts
 * @param {object[]} [opts.auditRows] — mais recentes primeiro (como listRecent)
 * @param {object[]} [opts.orders]
 * @param {object[]} [opts.settlementPending]
 * @param {number} [opts.limit]
 */
export function buildTradeJournal(opts = {}) {
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const orders = opts.orders ?? [];
  const rows = [...(opts.auditRows ?? [])].reverse();
  const tradesByMarket = new Map();

  function ensureTrade(marketId) {
    if (!tradesByMarket.has(marketId)) {
      tradesByMarket.set(marketId, {
        tradeId: marketId,
        marketId,
        side: null,
        entryPrice: null,
        qty: null,
        entryQty: null,
        legs: [],
        exitKind: null,
        exitPrice: null,
        pnl: null,
        pnlSource: 'engine',
        winner: null,
        openedAtMs: null,
        closedAtMs: null,
        durationMs: null,
        status: 'open',
      });
    }
    return tradesByMarket.get(marketId);
  }

  for (const row of rows) {
    const ts = row.tsMs ?? null;
    if (row.type === 'order_terminal' && row.filled === true) {
      const marketId = row.marketId;
      if (!marketId) continue;
      const kind = String(row.kind || '').toUpperCase();
      const price = Number(row.price);
      const qty = Number(row.qty);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) continue;
      const trade = ensureTrade(marketId);
      if (kind === 'ENTER') {
        trade.side = row.side ?? trade.side;
        trade.entryPrice = price;
        trade.qty = qty;
        trade.entryQty = qty;
        if (!trade.openedAtMs) trade.openedAtMs = ts;
        pushLeg(trade, {
          kind: 'ENTER',
          price,
          qty,
          tsMs: ts,
          reason: row.reason ?? null,
        });
        if (trade.status !== 'settlement_pending' && trade.status !== 'closed') {
          trade.status = 'open';
        }
      } else if (kind === 'EXIT' || kind === 'REVERSE') {
        const entryQty = Number(trade.entryQty ?? trade.qty);
        const entryPrice = Number(trade.entryPrice);
        trade.exitKind = kind;
        trade.exitPrice = price;
        pushLeg(trade, {
          kind,
          price,
          qty,
          tsMs: ts,
          reason: row.reason ?? null,
        });
        if (Number.isFinite(entryPrice)) addPnl(trade, (price - entryPrice) * qty);
        const remaining =
          Number.isFinite(entryQty) && entryQty > 0 ? Math.max(0, entryQty - qty) : 0;
        if (remaining <= 1e-9) {
          trade.closedAtMs = ts ?? trade.closedAtMs;
          trade.status = 'closed';
          trade.qty = entryQty;
        } else {
          trade.qty = entryQty;
          trade.status = 'open';
        }
      }
      continue;
    }

    if (row.type === 'decision') {
      const marketId = row.marketId;
      if (!marketId) continue;
      for (const acc of row.accepted ?? []) {
        if (acc.kind === 'ENTER') {
          const order = filledEnterOrder(orders, marketId);
          const posQty = Number(row.position?.qty) || 0;
          // ENTER aceito pelo risk mas FAK miss: não abrir trade fantasma "open".
          if (!order && posQty <= 0) continue;
          const trade = ensureTrade(marketId);
          trade.side = acc.side ?? order?.tokenSide ?? trade.side;
          const fillPrice =
            order?.price ?? row.position?.avgPrice ?? trade.entryPrice;
          const fillQty =
            (order?.qtyFilled > 0 ? order.qtyFilled : null) ||
            order?.qty ||
            row.position?.qty ||
            trade.qty;
          // Não sobrescrever fill real de order_terminal com maxPrice de intent.
          if (trade.entryPrice == null && fillPrice != null) trade.entryPrice = fillPrice;
          if (trade.qty == null && fillQty != null) {
            trade.qty = fillQty;
            trade.entryQty = fillQty;
          } else if (trade.entryQty == null && fillQty != null) {
            trade.entryQty = fillQty;
          }
          if (!trade.openedAtMs) trade.openedAtMs = ts;
          if (!trade.legs.some((l) => l.kind === 'ENTER')) {
            pushLeg(trade, {
              kind: 'ENTER',
              price: trade.entryPrice,
              qty: trade.entryQty ?? trade.qty,
              tsMs: ts,
              reason: acc.reason ?? acc.reasonCode ?? null,
            });
          }
          if (trade.status !== 'settlement_pending' && trade.status !== 'closed') {
            trade.status = 'open';
          }
        } else if (acc.kind === 'EXIT') {
          const trade = ensureTrade(marketId);
          // Fill real já veio em order_terminal — não duplicar PnL.
          if (trade.legs.some((l) => l.kind === 'EXIT')) continue;
          const exitOrder = filledOrder(orders, marketId, 'EXIT');
          const exitPrice = exitOrder?.price ?? trade.exitPrice;
          const exitQty =
            (exitOrder?.qtyFilled > 0 ? exitOrder.qtyFilled : null) ||
            Number(acc.quantity) ||
            null;
          if (trade.legs.some((l) => l.kind === 'EXIT' && l.tsMs === ts)) continue;
          trade.exitKind = 'EXIT';
          if (exitPrice != null) trade.exitPrice = exitPrice;
          const qty = Number(exitQty);
          const entryPrice = Number(trade.entryPrice);
          const entryQty = Number(trade.entryQty ?? trade.qty);
          pushLeg(trade, {
            kind: 'EXIT',
            price: trade.exitPrice,
            qty: Number.isFinite(qty) ? qty : trade.qty,
            tsMs: ts,
            reason: acc.reason ?? acc.reasonCode ?? null,
          });
          if (Number.isFinite(entryPrice) && Number.isFinite(qty) && qty > 0) {
            addPnl(trade, (Number(trade.exitPrice) - entryPrice) * qty);
          } else if (trade.pnl == null) {
            trade.pnl = computeExitPnl(trade);
          }
          if (Number.isFinite(entryQty) && Number.isFinite(qty) && qty + 1e-9 < entryQty) {
            trade.qty = entryQty;
            trade.status = 'open';
          } else {
            trade.qty = entryQty || trade.qty;
            trade.closedAtMs = ts ?? trade.closedAtMs;
            trade.status = 'closed';
          }
        } else if (acc.kind === 'REVERSE') {
          const trade = ensureTrade(marketId);
          if (trade.legs.some((l) => l.kind === 'REVERSE' && l.price != null)) continue;
          const reverseOrder = filledOrder(orders, marketId, 'REVERSE');
          // REVERSE rejeitado / sem fill: não fecha nem inventa preço.
          if (!reverseOrder || !(Number(reverseOrder.qtyFilled) > 0)) {
            pushLeg(trade, {
              kind: 'REVERSE',
              price: null,
              qty: trade.qty,
              tsMs: ts,
              reason: acc.reason ?? acc.reasonCode ?? 'REVERSE_FAILED',
            });
            continue;
          }
          trade.exitKind = 'REVERSE';
          trade.exitPrice = reverseOrder?.price ?? trade.exitPrice;
          const qty =
            (reverseOrder?.qtyFilled > 0 ? reverseOrder.qtyFilled : null) || trade.qty;
          pushLeg(trade, {
            kind: 'REVERSE',
            price: trade.exitPrice,
            qty,
            tsMs: ts,
            reason: acc.reason ?? acc.reasonCode ?? null,
          });
          if (trade.pnl == null) trade.pnl = computeExitPnl(trade);
          trade.closedAtMs = ts ?? trade.closedAtMs;
          trade.status = 'closed';
        }
      }
    } else if (row.type === 'position_settled') {
      const marketId = row.fromMarketId ?? row.marketId;
      if (!marketId) continue;
      const trade = ensureTrade(marketId);
      trade.side = trade.side ?? row.side ?? null;
      trade.entryPrice = trade.entryPrice ?? row.avgPrice ?? null;
      const settleQty = Number(row.qty);
      if (trade.entryQty == null && Number.isFinite(settleQty)) {
        trade.entryQty = settleQty;
      }
      if (trade.qty == null && Number.isFinite(settleQty)) trade.qty = settleQty;
      trade.exitKind = 'SETTLEMENT';
      trade.exitPrice = row.settlementPrice ?? trade.exitPrice;
      const delta = Number(row.pnlDelta);
      if (Number.isFinite(delta)) {
        // Soma à saída parcial; não sobrescreve.
        addPnl(trade, delta);
      } else if (trade.pnl == null) {
        trade.pnl = computeExitPnl(trade);
      }
      trade.winner = row.winner ?? trade.winner;
      trade.closedAtMs = ts ?? trade.closedAtMs;
      trade.status = 'closed';
      pushLeg(trade, {
        kind: 'SETTLEMENT',
        price: row.settlementPrice,
        qty: row.qty,
        tsMs: ts,
        reason: row.reason ?? 'binary_expiry_settlement',
      });
    } else if (row.type === 'settlement_queued') {
      const marketId = row.fromMarketId;
      if (!marketId) continue;
      const trade = ensureTrade(marketId);
      trade.side = trade.side ?? row.side ?? null;
      trade.entryPrice = trade.entryPrice ?? row.avgPrice ?? null;
      trade.qty = trade.qty ?? row.qty ?? null;
      if (trade.entryQty == null) trade.entryQty = trade.qty;
      if (!trade.openedAtMs) trade.openedAtMs = row.releasedAtMs ?? ts;
      if (trade.status !== 'closed') trade.status = 'settlement_pending';
    }
  }

  for (const pending of opts.settlementPending ?? []) {
    const trade = ensureTrade(pending.marketId);
    trade.side = trade.side ?? pending.side ?? null;
    trade.entryPrice = trade.entryPrice ?? pending.avgPrice ?? null;
    trade.qty = trade.qty ?? pending.qty ?? null;
    if (trade.entryQty == null) trade.entryQty = trade.qty;
    if (!trade.openedAtMs) trade.openedAtMs = pending.releasedAtMs ?? pending.queuedAtMs ?? null;
    if (trade.status !== 'closed') trade.status = 'settlement_pending';
  }

  return [...tradesByMarket.values()]
    .filter((t) => {
      if (t.status === 'settlement_pending') return true;
      if (t.status === 'closed') return t.legs.length > 0 || t.qty > 0 || t.pnl != null;
      // open só com fill real
      return Number(t.qty) > 0 && t.entryPrice != null;
    })
    .map((t) => {
      if (t.openedAtMs && t.closedAtMs) {
        t.durationMs = Math.max(0, t.closedAtMs - t.openedAtMs);
      }
      if (t.status === 'closed' && t.pnl == null) {
        t.pnl = computePnlFromLegs(t) ?? computeExitPnl(t);
      }
      return t;
    })
    .sort((a, b) => (b.closedAtMs ?? b.openedAtMs ?? 0) - (a.closedAtMs ?? a.openedAtMs ?? 0))
    .slice(0, limit);
}
