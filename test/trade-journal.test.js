import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTradeJournal, summarizeTradePnl } from '../src/oms/tradeJournal.js';

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
  });
});
