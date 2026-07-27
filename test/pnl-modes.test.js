import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createTradeLedgerDb } from '../src/oms/tradeLedgerDb.js';
import {
  filterCashflowsForRobotScope,
  reconcileTradesWithPolymarketCashflows,
} from '../src/index.js';

describe('pnl modes (ledger + hybrid scope)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-pnl-modes-'));
  const ledger = createTradeLedgerDb({ dbPath: path.join(tmpDir, 'trades.db') });

  after(() => {
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('engine mode lista só o que está no SQLite', () => {
    ledger.setSettings({ pnlMode: 'engine' });
    ledger.upsertTrade({
      marketId: 'btc-updown-5m-1',
      status: 'closed',
      pnl: 1.2,
      openedAtMs: 1,
      closedAtMs: 2,
      legs: [],
    });
    const trades = ledger.listTrades();
    assert.equal(trades.length, 1);
    assert.equal(ledger.getSettings().pnlMode, 'engine');
  });

  it('hybrid scope não inclui mercado externo', () => {
    const local = ['btc-updown-5m-1'];
    const cashflows = new Map([
      [
        'btc-updown-5m-1',
        { marketId: 'btc-updown-5m-1', buyUsd: 2, sellUsd: 0, redeemUsd: 4, pnl: 2 },
      ],
      [
        'btc-updown-5m-manual',
        { marketId: 'btc-updown-5m-manual', buyUsd: 10, sellUsd: 0, redeemUsd: 0, pnl: -10 },
      ],
    ]);
    const scoped = filterCashflowsForRobotScope(cashflows, {
      alwaysKeepMarketIds: local,
      onlyKeepMarketIds: true,
    });
    assert.equal(scoped.size, 1);
    assert.ok(scoped.has('btc-updown-5m-1'));
    assert.equal(scoped.has('btc-updown-5m-manual'), false);
  });

  it('reconcile anota polymarket sem inventar trade externo no journal local', () => {
    const localTrades = ledger.listTrades();
    const cashflows = new Map([
      [
        'btc-updown-5m-1',
        {
          marketId: 'btc-updown-5m-1',
          buyUsd: 2,
          sellUsd: 0,
          redeemUsd: 4,
          buyQty: 4,
          pnl: 2,
          firstTsSec: 1,
          lastTsSec: 2,
        },
      ],
      [
        'btc-updown-5m-extra',
        {
          marketId: 'btc-updown-5m-extra',
          buyUsd: 5,
          sellUsd: 0,
          redeemUsd: 0,
          buyQty: 5,
          pnl: -5,
          firstTsSec: 3,
          lastTsSec: 4,
        },
      ],
    ]);
    const scoped = filterCashflowsForRobotScope(cashflows, {
      alwaysKeepMarketIds: localTrades.map((t) => t.marketId),
      onlyKeepMarketIds: true,
    });
    const reconciled = reconcileTradesWithPolymarketCashflows(localTrades, scoped);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].pnlSource, 'polymarket');
    assert.equal(reconciled[0].pnl, 2);
  });
});
