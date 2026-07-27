import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildEquityCurveFromTrades,
  buildTradeJournal,
  mergeJournalWithPolymarketCashflows,
  reconcileTradesWithPolymarketCashflows,
  summarizeTradePnl,
} from '../src/oms/tradeJournal.js';
import {
  aggregateActivityCashflows,
  filterCashflowsForRobotScope,
} from '../src/clob/polymarketActivity.js';

describe('tradeJournal', () => {
  it('monta trade fechado por settlement', () => {
    const rows = [
      {
        type: 'position_settled',
        tsMs: 3000,
        fromMarketId: 'm1',
        side: 'UP',
        qty: 2,
        avgPrice: 0.5,
        settlementPrice: 1,
        pnlDelta: 1,
        winner: 'UP',
      },
      {
        type: 'decision',
        tsMs: 1000,
        marketId: 'm1',
        accepted: [{ kind: 'ENTER', side: 'UP', reason: 'signal' }],
        position: { qty: 2, avgPrice: 0.5, side: 'UP' },
      },
    ];
    const trades = buildTradeJournal({ auditRows: rows, limit: 10 });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].marketId, 'm1');
    assert.equal(trades[0].status, 'closed');
    assert.equal(trades[0].exitKind, 'SETTLEMENT');
    assert.equal(trades[0].pnl, 1);
    assert.equal(trades[0].legs.length, 2);
    assert.equal(trades[0].durationMs, 2000);
  });

  it('marca settlement_pending quando Gamma ainda não fechou', () => {
    const rows = [
      {
        type: 'settlement_queued',
        tsMs: 2000,
        fromMarketId: 'm1',
        side: 'DOWN',
        qty: 3,
        avgPrice: 0.4,
      },
      {
        type: 'decision',
        tsMs: 1000,
        marketId: 'm1',
        accepted: [{ kind: 'ENTER', side: 'DOWN' }],
        position: { qty: 3, avgPrice: 0.4, side: 'DOWN' },
      },
    ];
    const trades = buildTradeJournal({
      auditRows: rows,
      settlementPending: [{ marketId: 'm1', side: 'DOWN', qty: 3, avgPrice: 0.4, queuedAtMs: 2000 }],
      limit: 10,
    });
    assert.equal(trades[0].status, 'settlement_pending');
    assert.equal(trades[0].pnl, null);
  });

  it('registra EXIT com preço da ordem MATCHED', () => {
    const rows = [
      {
        type: 'decision',
        tsMs: 2000,
        marketId: 'm2',
        accepted: [{ kind: 'EXIT', reason: 'late_flip' }],
        position: { qty: 0 },
      },
      {
        type: 'decision',
        tsMs: 1000,
        marketId: 'm2',
        accepted: [{ kind: 'ENTER', side: 'UP' }],
        position: { qty: 2, avgPrice: 0.55, side: 'UP' },
      },
    ];
    const trades = buildTradeJournal({
      auditRows: rows,
      orders: [
        {
          marketId: 'm2',
          kind: 'ENTER',
          state: 'MATCHED',
          tokenSide: 'UP',
          price: 0.55,
          qty: 2,
          qtyFilled: 2,
        },
        {
          marketId: 'm2',
          kind: 'EXIT',
          state: 'MATCHED',
          price: 0.48,
          qty: 2,
          qtyFilled: 2,
        },
      ],
      limit: 10,
    });
    assert.equal(trades[0].exitKind, 'EXIT');
    assert.equal(trades[0].exitPrice, 0.48);
    assert.equal(trades[0].status, 'closed');
    assert.equal(trades[0].pnl, (0.48 - 0.55) * 2);
  });

  it('não cria trade open fantasma após ENTER sem fill (FAK miss)', () => {
    const trades = buildTradeJournal({
      auditRows: [
        {
          type: 'decision',
          tsMs: 1000,
          marketId: 'm-miss',
          accepted: [{ kind: 'ENTER', side: 'UP', reason: 'midas_core_entry' }],
          position: { qty: 0, avgPrice: null, side: null },
        },
      ],
      orders: [
        {
          marketId: 'm-miss',
          kind: 'ENTER',
          state: 'REJECTED',
          tokenSide: 'UP',
          price: 0.72,
          qty: 2,
          qtyFilled: 0,
        },
      ],
      limit: 10,
    });
    assert.equal(trades.length, 0);
  });

  it('summarizeTradePnl separa ganhos e perdas', () => {
    const summary = summarizeTradePnl([
      { status: 'closed', pnl: 1.5 },
      { status: 'closed', pnl: -0.4 },
      { status: 'closed', pnl: 0.2 },
      { status: 'settlement_pending', pnl: null },
      { status: 'open', pnl: null },
    ]);
    assert.equal(summary.won, 1.7);
    assert.equal(summary.lost, 0.4);
    assert.equal(summary.net, 1.3);
    assert.equal(summary.wins, 2);
    assert.equal(summary.losses, 1);
    assert.equal(summary.pending, 1);
    assert.equal(summary.closed, 3);
    assert.equal(summary.decided, 3);
    assert.equal(summary.winRate, 2 / 3);
  });

  it('buildEquityCurveFromTrades acumula PnL no tempo', () => {
    const equity = buildEquityCurveFromTrades([
      { status: 'closed', pnl: -0.5, closedAtMs: 3000 },
      { status: 'closed', pnl: 1.2, closedAtMs: 1000 },
      { status: 'closed', pnl: 0.4, closedAtMs: 2000 },
      { status: 'settlement_pending', pnl: null, closedAtMs: 4000 },
      { status: 'open', pnl: null, openedAtMs: 500 },
    ]);
    assert.deepEqual(equity, [
      { ts: 1000, pnl: 1.2 },
      { ts: 2000, pnl: 1.6 },
      { ts: 3000, pnl: 1.1 },
    ]);
  });

  it('partial EXIT + settlement soma PnL das duas pernas', () => {
    const trades = buildTradeJournal({
      auditRows: [
        {
          type: 'position_settled',
          tsMs: 3000,
          fromMarketId: 'm-partial',
          side: 'UP',
          qty: 2,
          avgPrice: 0.85,
          settlementPrice: 0.995,
          pnlDelta: 0.29,
          winner: 'Up',
        },
        {
          type: 'order_terminal',
          tsMs: 2000,
          marketId: 'm-partial',
          kind: 'EXIT',
          filled: true,
          qty: 2,
          price: 0.76,
          side: 'UP',
        },
        {
          type: 'order_terminal',
          tsMs: 1000,
          marketId: 'm-partial',
          kind: 'ENTER',
          filled: true,
          qty: 4,
          price: 0.85,
          side: 'UP',
        },
      ],
      limit: 10,
    });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].status, 'closed');
    // (0.76-0.85)*2 + 0.29 = -0.18 + 0.29 = 0.11
    assert.ok(Math.abs(trades[0].pnl - 0.11) < 1e-9);
  });

  it('reconcileTradesWithPolymarketCashflows usa REDEEM−BUY da Data API', () => {
    const cashflows = aggregateActivityCashflows([
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-1',
        usdcSize: 3.4357,
        size: 4,
        price: 0.85,
        timestamp: 100,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-1',
        usdcSize: 4,
        size: 4,
        timestamp: 200,
      },
    ]);
    const [trade] = reconcileTradesWithPolymarketCashflows(
      [
        {
          marketId: 'btc-updown-5m-1',
          status: 'closed',
          entryPrice: 0.85,
          qty: 4,
          pnl: 0.58,
          pnlSource: 'engine',
        },
      ],
      cashflows,
    );
    assert.equal(trade.pnlSource, 'polymarket');
    assert.ok(Math.abs(trade.pnl - (4 - 3.4357)) < 1e-9);
    assert.equal(trade.polymarket.redeemUsd, 4);
    assert.equal(trade.polymarket.buyUsd, 3.4357);
  });

  it('mergeJournalWithPolymarketCashflows sintetiza markets só na Polymarket', () => {
    const cashflows = aggregateActivityCashflows([
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'eth-updown-5m-9',
        usdcSize: 2.5,
        size: 5,
        price: 0.5,
        timestamp: 100,
        outcome: 'Up',
      },
      {
        type: 'REDEEM',
        eventSlug: 'eth-updown-5m-9',
        usdcSize: 5,
        size: 5,
        timestamp: 300,
      },
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-1',
        usdcSize: 1,
        size: 2,
        price: 0.5,
        timestamp: 50,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-1',
        usdcSize: 0.5,
        size: 2,
        timestamp: 80,
      },
    ]);
    const merged = mergeJournalWithPolymarketCashflows(
      [
        {
          marketId: 'btc-updown-5m-1',
          status: 'closed',
          entryPrice: 0.5,
          qty: 2,
          pnl: -0.1,
          pnlSource: 'engine',
          openedAtMs: 50_000,
          closedAtMs: 80_000,
          legs: [],
        },
      ],
      cashflows,
    );
    assert.equal(merged.length, 2);
    const eth = merged.find((t) => t.marketId === 'eth-updown-5m-9');
    const btc = merged.find((t) => t.marketId === 'btc-updown-5m-1');
    assert.ok(eth);
    assert.equal(eth.pnlSource, 'polymarket');
    assert.equal(eth.status, 'closed');
    assert.equal(eth.side, 'UP');
    assert.ok(Math.abs(eth.pnl - 2.5) < 1e-9);
    assert.ok(btc);
    assert.equal(btc.pnlSource, 'polymarket');
    assert.ok(Math.abs(btc.pnl - -0.5) < 1e-9);
    const summary = summarizeTradePnl(merged);
    assert.equal(summary.closed, 2);
    assert.ok(Math.abs(summary.net - 2) < 1e-9);
  });

  it('filterCashflowsForRobotScope prioriza audit local e não sintetiza extras', () => {
    const cashflows = aggregateActivityCashflows([
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-old',
        usdcSize: 2.5,
        size: 5,
        price: 0.5,
        timestamp: 100,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-old',
        usdcSize: 5,
        timestamp: 200,
      },
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-robot',
        usdcSize: 2.5,
        size: 5,
        price: 0.5,
        timestamp: 1000,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-robot',
        usdcSize: 4,
        timestamp: 1100,
      },
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-manual',
        usdcSize: 50,
        size: 100,
        price: 0.5,
        timestamp: 1200,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-manual',
        usdcSize: 40,
        timestamp: 1300,
      },
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: 'btc-updown-5m-local',
        usdcSize: 0.5,
        size: 1,
        price: 0.5,
        timestamp: 50,
      },
      {
        type: 'REDEEM',
        eventSlug: 'btc-updown-5m-local',
        usdcSize: 1,
        timestamp: 60,
      },
    ]);
    const withLocal = filterCashflowsForRobotScope(cashflows, {
      alwaysKeepMarketIds: ['btc-updown-5m-local'],
      sinceSec: 500,
      onlyKeepMarketIds: true,
    });
    assert.equal(withLocal.has('btc-updown-5m-local'), true);
    assert.equal(withLocal.has('btc-updown-5m-robot'), false);
    assert.equal(withLocal.has('btc-updown-5m-manual'), false);
    assert.equal(withLocal.has('btc-updown-5m-old'), false);

    const recovery = filterCashflowsForRobotScope(cashflows, {
      alwaysKeepMarketIds: [],
      sinceSec: 500,
      onlyKeepMarketIds: false,
    });
    assert.equal(recovery.has('btc-updown-5m-robot'), true);
    assert.equal(recovery.has('btc-updown-5m-manual'), true);
    assert.equal(recovery.has('btc-updown-5m-old'), false);
  });

  it('infere perda fechada quando BUY 5m expirou sem REDEEM na activity', () => {
    const slot = 1_700_000_000;
    const cashflows = aggregateActivityCashflows([
      {
        type: 'TRADE',
        side: 'BUY',
        eventSlug: `doge-updown-5m-${slot}`,
        usdcSize: 1.62,
        size: 2,
        price: 0.81,
        timestamp: slot + 60,
        outcome: 'Down',
      },
    ]);
    const cf = cashflows.get(`doge-updown-5m-${slot}`);
    assert.ok(cf);
    // slot 1700000000 já expirou → inferredLoss.
    assert.equal(cf.inferredLoss, true);
    assert.equal(cf.redeemed, true);
    assert.ok(Math.abs(cf.pnl - -1.62) < 1e-9);
    const [trade] = mergeJournalWithPolymarketCashflows([], cashflows);
    assert.equal(trade.status, 'closed');
    assert.equal(trade.exitKind, 'SETTLEMENT');
    assert.equal(trade.exitPrice, 0);
    assert.ok(Math.abs(trade.pnl - -1.62) < 1e-9);
    const summary = summarizeTradePnl([trade]);
    assert.equal(summary.losses, 1);
    assert.ok(Math.abs(summary.lost - 1.62) < 1e-9);
  });
});
