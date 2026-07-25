/**
 * Monta journal de trades a partir do execution-audit + OMS.
 */

function matchedOrder(orders, marketId, kind) {
  const hits = orders.filter(
    (o) => o.marketId === marketId && o.kind === kind && o.state === 'MATCHED',
  );
  return hits.at(-1) ?? null;
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

/**
 * @param {object} opts
 * @param {object[]} [opts.auditRows] — mais recentes primeiro (como listRecent)
 * @param {object[]} [opts.orders]
 * @param {object[]} [opts.settlementPending]
 * @param {number} [opts.limit]
 */
export function buildTradeJournal(opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
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
        legs: [],
        exitKind: null,
        exitPrice: null,
        pnl: null,
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
    if (row.type === 'decision') {
      const marketId = row.marketId;
      if (!marketId) continue;
      const trade = ensureTrade(marketId);
      for (const acc of row.accepted ?? []) {
        if (acc.kind === 'ENTER') {
          const order = matchedOrder(orders, marketId, 'ENTER');
          trade.side = acc.side ?? order?.tokenSide ?? trade.side;
          trade.entryPrice = order?.price ?? row.position?.avgPrice ?? trade.entryPrice;
          trade.qty = order?.qtyFilled || order?.qty || row.position?.qty || trade.qty;
          if (!trade.openedAtMs) trade.openedAtMs = ts;
          pushLeg(trade, {
            kind: 'ENTER',
            price: trade.entryPrice,
            qty: trade.qty,
            tsMs: ts,
            reason: acc.reason ?? acc.reasonCode ?? null,
          });
          if (trade.status !== 'settlement_pending') trade.status = 'open';
        } else if (acc.kind === 'EXIT') {
          const order = matchedOrder(orders, marketId, 'EXIT');
          trade.exitKind = 'EXIT';
          trade.exitPrice = order?.price ?? trade.exitPrice;
          pushLeg(trade, {
            kind: 'EXIT',
            price: trade.exitPrice,
            qty: order?.qtyFilled || trade.qty,
            tsMs: ts,
            reason: acc.reason ?? acc.reasonCode ?? null,
          });
          trade.closedAtMs = ts ?? trade.closedAtMs;
          trade.status = 'closed';
        } else if (acc.kind === 'REVERSE') {
          const order = matchedOrder(orders, marketId, 'REVERSE');
          trade.exitKind = 'REVERSE';
          trade.exitPrice = order?.price ?? trade.exitPrice;
          pushLeg(trade, {
            kind: 'REVERSE',
            price: trade.exitPrice,
            qty: order?.qtyFilled || trade.qty,
            tsMs: ts,
            reason: acc.reason ?? acc.reasonCode ?? null,
          });
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
      trade.qty = trade.qty ?? row.qty ?? null;
      trade.exitKind = 'SETTLEMENT';
      trade.exitPrice = row.settlementPrice ?? trade.exitPrice;
      trade.pnl = row.pnlDelta ?? trade.pnl;
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
      if (!trade.openedAtMs) trade.openedAtMs = row.releasedAtMs ?? ts;
      if (trade.status !== 'closed') trade.status = 'settlement_pending';
    }
  }

  for (const pending of opts.settlementPending ?? []) {
    const trade = ensureTrade(pending.marketId);
    trade.side = trade.side ?? pending.side ?? null;
    trade.entryPrice = trade.entryPrice ?? pending.avgPrice ?? null;
    trade.qty = trade.qty ?? pending.qty ?? null;
    if (!trade.openedAtMs) trade.openedAtMs = pending.releasedAtMs ?? pending.queuedAtMs ?? null;
    if (trade.status !== 'closed') trade.status = 'settlement_pending';
  }

  return [...tradesByMarket.values()]
    .filter((t) => t.legs.length > 0 || t.status === 'settlement_pending' || t.qty > 0)
    .map((t) => {
      if (t.openedAtMs && t.closedAtMs) {
        t.durationMs = Math.max(0, t.closedAtMs - t.openedAtMs);
      }
      return t;
    })
    .sort((a, b) => (b.closedAtMs ?? b.openedAtMs ?? 0) - (a.closedAtMs ?? a.openedAtMs ?? 0))
    .slice(0, limit);
}
