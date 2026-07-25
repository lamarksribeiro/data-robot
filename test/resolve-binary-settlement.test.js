import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  outcomePricesLookResolved,
  resolveBinarySettlementPrice,
} from '../src/market/resolveBinarySettlement.js';

describe('outcomePricesLookResolved', () => {
  it('aceita extremos 0/1', () => {
    assert.equal(outcomePricesLookResolved(['1', '0']), true);
    assert.equal(outcomePricesLookResolved([0, 1]), true);
    assert.equal(outcomePricesLookResolved([0.99, 0.01]), true);
  });

  it('rejeita book intermediário', () => {
    assert.equal(outcomePricesLookResolved(['0.5', '0.5']), false);
    assert.equal(outcomePricesLookResolved([0.8, 0.2]), false);
  });
});

describe('resolveBinarySettlementPrice', () => {
  it('resolve cedo com outcomePrices finais mesmo sem closed', async () => {
    const result = await resolveBinarySettlementPrice('btc-updown-5m-1', 'UP', {
      fetchFn: async () => ({
        ok: true,
        json: async () => [
          {
            closed: false,
            markets: [
              {
                closed: false,
                outcomes: '["Up","Down"]',
                outcomePrices: '["1","0"]',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.settlementPrice, 1);
    assert.equal(result.early, true);
    assert.equal(String(result.winner).toUpperCase(), 'UP');
  });

  it('resolve cedo via umaResolutionStatus=resolved', async () => {
    const result = await resolveBinarySettlementPrice('btc-updown-5m-2', 'DOWN', {
      fetchFn: async () => ({
        ok: true,
        json: async () => [
          {
            closed: false,
            markets: [
              {
                closed: false,
                umaResolutionStatus: 'resolved',
                outcomes: '["Up","Down"]',
                outcomePrices: '["0","1"]',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.settlementPrice, 1);
    assert.equal(result.early, true);
  });

  it('mantém MARKET_STILL_OPEN com preços intermediários', async () => {
    const result = await resolveBinarySettlementPrice('btc-updown-5m-3', 'UP', {
      fetchFn: async () => ({
        ok: true,
        json: async () => [
          {
            closed: false,
            markets: [
              {
                closed: false,
                outcomes: '["Up","Down"]',
                outcomePrices: '["0.55","0.45"]',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MARKET_STILL_OPEN');
  });

  it('recusa closed sem preços finais', async () => {
    const result = await resolveBinarySettlementPrice('btc-updown-5m-4', 'UP', {
      fetchFn: async () => ({
        ok: true,
        json: async () => [
          {
            closed: true,
            markets: [
              {
                closed: true,
                outcomes: '["Up","Down"]',
                outcomePrices: '["0.6","0.4"]',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OUTCOME_PRICES_NOT_FINAL');
  });
});
