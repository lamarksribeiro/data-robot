import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateTakerFee, summarizeTradeFees } from '../src/fees/polymarketFee.js';

describe('calculateTakerFee', () => {
  it('usa shares * 0.07 * p * (1-p)', () => {
    // 100 * 0.07 * 0.5 * 0.5 = 1.75
    assert.equal(calculateTakerFee({ shares: 100, price: 0.5 }), 1.75);
  });

  it('retorna 0 para preço inválido', () => {
    assert.equal(calculateTakerFee({ shares: 10, price: 0 }), 0);
    assert.equal(calculateTakerFee({ shares: 10, price: 1 }), 0);
  });
});

describe('summarizeTradeFees', () => {
  it('maker = 0 e taker soma expected', () => {
    const summary = summarizeTradeFees([
      { size: 100, price: 0.5, trader_side: 'MAKER' },
      { size: 100, price: 0.5, trader_side: 'TAKER' },
    ]);
    assert.equal(summary.makerCount, 1);
    assert.equal(summary.takerCount, 1);
    assert.equal(summary.expectedMakerFeeUsd, 0);
    assert.equal(summary.expectedTakerFeeUsd, 1.75);
  });
});
