import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  outcomePricesLookResolved,
  resolveBinarySettlementPrice,
  settlementPriceForWinningOutcome,
} from '../src/market/resolveBinarySettlement.js';
import { normalizeMarketResolvedMessage } from '../src/feeds/clobFeed.js';

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

describe('settlementPriceForWinningOutcome', () => {
  it('mapeia aliases UP/DOWN e YES/NO para preço final', () => {
    assert.equal(settlementPriceForWinningOutcome('UP', 'Up'), 1);
    assert.equal(settlementPriceForWinningOutcome('UP', 'Down'), 0);
    assert.equal(settlementPriceForWinningOutcome('DOWN', 'Down'), 1);
    assert.equal(settlementPriceForWinningOutcome('DOWN', 'Up'), 0);
    assert.equal(settlementPriceForWinningOutcome('UP', 'Yes'), 1);
    assert.equal(settlementPriceForWinningOutcome('DOWN', 'No'), 1);
    assert.equal(settlementPriceForWinningOutcome('', 'Up'), null);
  });
});

describe('normalizeMarketResolvedMessage', () => {
  it('aceita o formato market_resolved do CLOB sem asset_id singular', () => {
    const result = normalizeMarketResolvedMessage({
      event_type: 'market_resolved',
      market: '0xcondition',
      slug: 'btc-updown-5m-100',
      assets_ids: ['up-token', 'down-token'],
      winning_asset_id: 'up-token',
      winning_outcome: 'Up',
      timestamp: '123456',
    });
    assert.deepEqual(result, {
      marketId: 'btc-updown-5m-100',
      slug: 'btc-updown-5m-100',
      conditionId: '0xcondition',
      winningOutcome: 'Up',
      winningAssetId: 'up-token',
      assetIds: ['up-token', 'down-token'],
      resolvedAtMs: 123456,
      source: 'clob_ws',
    });
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

  it('desabilita cache ao consultar Gamma', async () => {
    let request = null;
    await resolveBinarySettlementPrice('btc-updown-5m-5', 'UP', {
      fetchFn: async (url, init) => {
        request = { url, init };
        return {
          ok: true,
          json: async () => [],
        };
      },
    });
    assert.match(request.url, /[?&]_ts=\d+/);
    assert.equal(request.init.cache, 'no-store');
    assert.equal(request.init.headers['cache-control'], 'no-cache');
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
