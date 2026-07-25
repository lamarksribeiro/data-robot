import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchPositionsValueUsd } from '../src/clob/portfolioValue.js';

describe('portfolioValue', () => {
  it('soma cash + posições no valor retornado pela Data API', async () => {
    const value = await fetchPositionsValueUsd({
      funderAddress: '0x1111111111111111111111111111111111111111',
      fetchFn: async () => ({
        ok: true,
        json: async () => [{ user: '0x1111111111111111111111111111111111111111', value: 12.5 }],
      }),
    });
    assert.equal(value, 12.5);
  });

  it('buildPolymarketPortfolio espelha Cash + Positions = Portfolio', async () => {
    const { buildPolymarketPortfolio } = await import('../src/clob/portfolioValue.js');
    const row = buildPolymarketPortfolio({
      cashUsd: 100,
      positionsValueUsd: 28.8,
      funderAddress: '0x1111111111111111111111111111111111111111',
    });
    assert.equal(row.portfolioUsd, 128.8);
    assert.equal(row.balanceUsd, 128.8);
    assert.equal(row.source, 'polymarket');
  });

  it('retorna null para endereço inválido ou falha de rede', async () => {
    assert.equal(await fetchPositionsValueUsd({ funderAddress: 'not-an-address' }), null);
    const failed = await fetchPositionsValueUsd({
      funderAddress: '0x1111111111111111111111111111111111111111',
      fetchFn: async () => {
        throw new Error('network');
      },
    });
    assert.equal(failed, null);
  });
});
