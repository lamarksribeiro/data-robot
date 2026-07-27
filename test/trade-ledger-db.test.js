import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import {
  createTradeLedgerDb,
  normalizePnlMode,
  DEFAULT_PNL_MODE,
} from '../src/oms/tradeLedgerDb.js';

describe('tradeLedgerDb', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-ledger-'));
  const dbPath = path.join(tmpDir, 'trades.db');
  const ledger = createTradeLedgerDb({ dbPath });

  after(() => {
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default settings = engine / autoCorrect off', () => {
    assert.equal(normalizePnlMode('nope'), DEFAULT_PNL_MODE);
    const settings = ledger.getSettings();
    assert.equal(settings.pnlMode, 'engine');
    assert.equal(settings.autoCorrectPolymarket, false);
  });

  it('setSettings persiste pnlMode e autoCorrect', () => {
    const next = ledger.setSettings({
      pnlMode: 'hybrid',
      autoCorrectPolymarket: true,
    });
    assert.equal(next.pnlMode, 'hybrid');
    assert.equal(next.autoCorrectPolymarket, true);
    assert.equal(ledger.getSettings().pnlMode, 'hybrid');
    ledger.setSettings({ pnlMode: 'engine', autoCorrectPolymarket: false });
  });

  it('upsertTrade + listTrades roundtrip', () => {
    ledger.upsertTrade({
      marketId: 'btc-updown-5m-1700000000',
      side: 'UP',
      entryPrice: 0.55,
      exitPrice: 1,
      qty: 4,
      entryQty: 4,
      status: 'closed',
      pnl: 1.8,
      exitKind: 'SETTLEMENT',
      openedAtMs: 1000,
      closedAtMs: 2000,
      legs: [{ kind: 'ENTER', price: 0.55, qty: 4 }],
    });
    const trades = ledger.listTrades({ limit: 10 });
    assert.equal(trades.length, 1);
    assert.equal(trades[0].marketId, 'btc-updown-5m-1700000000');
    assert.equal(trades[0].pnl, 1.8);
    assert.equal(trades[0].enginePnl, 1.8);
    assert.equal(trades[0].pnlSource, 'engine');
    assert.equal(ledger.countTrades(), 1);
  });

  it('applyPolymarketCorrection preserva engine_pnl', () => {
    const corrected = ledger.applyPolymarketCorrection(
      'btc-updown-5m-1700000000',
      {
        buyUsd: 2.2,
        sellUsd: 0,
        redeemUsd: 4,
        pnl: 1.8,
        inferredLoss: false,
      },
      {
        status: 'closed',
        pnl: 1.8,
      },
    );
    assert.ok(corrected);
    assert.equal(corrected.pnlSource, 'hybrid_corrected');
    assert.equal(corrected.enginePnl, 1.8);
    assert.equal(corrected.pnl, 1.8);
    assert.equal(corrected.polymarket.redeemUsd, 4);
  });

  it('hybrid correction com PnL diferente da engine', () => {
    ledger.upsertTrade({
      marketId: 'eth-updown-5m-1700000300',
      side: 'DOWN',
      entryPrice: 0.6,
      qty: 3,
      status: 'closed',
      pnl: -0.5,
      openedAtMs: 3000,
      closedAtMs: 4000,
      legs: [],
    });
    const corrected = ledger.applyPolymarketCorrection('eth-updown-5m-1700000300', {
      buyUsd: 1.8,
      sellUsd: 0,
      redeemUsd: 0,
      pnl: -1.8,
      inferredLoss: true,
    });
    assert.equal(corrected.enginePnl, -0.5);
    assert.equal(corrected.pnl, -1.8);
    assert.equal(corrected.pnlSource, 'hybrid_corrected');
  });
});
