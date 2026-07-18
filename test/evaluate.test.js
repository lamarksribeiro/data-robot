import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateEntryGates,
  favoriteSide,
  orderBookImbalance,
} from '../src/tfc/evaluate.js';
import { TFC_V7 } from '../src/tfc/preset-v7.js';

describe('favoriteSide', () => {
  it('UP quando btc >= ptb', () => {
    assert.equal(favoriteSide(100, 99), 'UP');
    assert.equal(favoriteSide(100, 100), 'UP');
  });
  it('DOWN quando btc < ptb', () => {
    assert.equal(favoriteSide(98, 100), 'DOWN');
  });
  it('null sem números', () => {
    assert.equal(favoriteSide(null, 100), null);
  });
});

describe('orderBookImbalance', () => {
  it('calcula OBI nos níveis', () => {
    const book = {
      up: {
        bids: [{ size: 10 }, { size: 10 }],
        asks: [{ size: 5 }, { size: 5 }],
      },
    };
    assert.equal(orderBookImbalance('UP', book, 2), (20 - 10) / 30);
  });
});

describe('evaluateEntryGates V7', () => {
  const book = {
    up: {
      bestBid: 0.6,
      bestAsk: 0.62,
      bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
      asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
    },
    down: {
      bestBid: 0.38,
      bestAsk: 0.4,
      bids: [{ size: 5 }],
      asks: [{ size: 5 }],
    },
  };

  it('passa com snapshot terminal válido', () => {
    const nowMs = Date.now();
    const history = [
      { ts: nowMs - 5000, btc: 100.0 },
      { ts: nowMs, btc: 100.5 },
    ];
    const result = evaluateEntryGates(
      {
        nowMs,
        btc: 100.5,
        priceToBeat: 100,
        secsLeft: 20,
        book,
      },
      TFC_V7,
      history,
    );
    assert.equal(result.fav, 'UP');
    assert.equal(result.ok, true);
  });

  it('falha fora da janela terminal', () => {
    const result = evaluateEntryGates(
      {
        nowMs: Date.now(),
        btc: 100.5,
        priceToBeat: 100,
        secsLeft: 40,
        book,
      },
      TFC_V7,
      [],
    );
    assert.equal(result.gates.terminalWindow.pass, false);
    assert.equal(result.ok, false);
  });
});
