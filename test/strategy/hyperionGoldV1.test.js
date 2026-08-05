import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHyperionGoldV1Strategy,
  HYPERION_GOLD_V1_STRATEGY_ID,
  HYPERION_GOLD_V1_PRESET_ID,
} from '../../src/strategy/hyperionGoldV1.js';
import { HYPERION_GOLD_V1 } from '../../src/tfc/preset-hyperion-gold.js';

test('Hyperion Gold V1 — identificação do plugin', () => {
  const ctx = { strategyInstanceId: 'test-hyperion-1', clockMs: 1000000 };
  const strategy = createHyperionGoldV1Strategy(ctx);
  assert.equal(strategy.strategyId, HYPERION_GOLD_V1_STRATEGY_ID);
  assert.equal(strategy.describe().presetId, HYPERION_GOLD_V1_PRESET_ID);
});

test('Hyperion Gold V1 — gera intenção ENTER em cotação High-Ask com Binance Lead confirmado', () => {
  const ctx = { strategyInstanceId: 'test-hyperion-1', clockMs: 1000000 };
  const strategy = createHyperionGoldV1Strategy(ctx);

  const snapshot = {
    marketId: 'btc-updown-5m-2026-08-04',
    nowMs: 1000000,
    secondsLeft: 20,
    strikeUsd: 65000,
    btc: 65020, // Distância +20 (favorável UP)
    feeds: { healthy: true },
    book: {
      up: { asks: [{ price: 0.88, size: 500 }], bids: [{ price: 0.86, size: 500 }] },
      down: { asks: [{ price: 0.12, size: 500 }], bids: [{ price: 0.10, size: 500 }] },
    },
    identity: { upTokenId: 'token-up-123', downTokenId: 'token-down-123' },
  };

  const { intents } = strategy.evaluate(snapshot, null);
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.kind, 'ENTER');
  assert.equal(intent.side, 'UP');
  assert.equal(intent.orderType, 'FAK');
  assert.equal(intent.tokenId, 'token-up-123');
  assert.ok(intent.budget >= 15); // Budget de $15 (High-Ask tier 1.5x)
});

test('Hyperion Gold V1 — bloqueia ENTER se Ask estiver fora do envelope High-Ask (< 0.82)', () => {
  const ctx = { strategyInstanceId: 'test-hyperion-1', clockMs: 1000000 };
  const strategy = createHyperionGoldV1Strategy(ctx);

  const snapshot = {
    marketId: 'btc-updown-5m-2026-08-04',
    nowMs: 1000000,
    secondsLeft: 20,
    strikeUsd: 65000,
    btc: 65005,
    feeds: { healthy: true },
    book: {
      up: { asks: [{ price: 0.70, size: 500 }], bids: [{ price: 0.68, size: 500 }] },
      down: { asks: [{ price: 0.30, size: 500 }], bids: [{ price: 0.28, size: 500 }] },
    },
  };

  const { intents } = strategy.evaluate(snapshot, null);
  assert.equal(intents.length, 0); // Fora do envelope (Ask < 0.82)
});

test('Hyperion Gold V1 — gera intenção EXIT por Odds Shock em posição ativa', () => {
  const ctx = { strategyInstanceId: 'test-hyperion-1', clockMs: 1000000 };
  const strategy = createHyperionGoldV1Strategy(ctx);

  const position = { side: 'UP', quantity: 20, entryPrice: 0.88 };

  // Histórico com oppAsk baixo no início
  strategy.evaluate({
    nowMs: 998000,
    btc: 65020,
    book: {
      up: { asks: [{ price: 0.88 }], bids: [{ price: 0.86 }] },
      down: { asks: [{ price: 0.12 }], bids: [{ price: 0.10 }] },
    },
  }, position);

  // Variação abrupta de oppAsk (0.12 -> 0.55 = delta 0.43)
  const snapshotShock = {
    marketId: 'btc-updown-5m-2026-08-04',
    nowMs: 1000000,
    secondsLeft: 10,
    btc: 65000,
    feeds: { healthy: true },
    book: {
      up: { asks: [{ price: 0.45 }], bids: [{ price: 0.50 }] }, // bid de 0.50 >= entryPrice * 0.55
      down: { asks: [{ price: 0.55 }], bids: [{ price: 0.50 }] }, // oppAsk 0.55 >= 0.50
    },
    identity: { upTokenId: 'token-up-123' },
  };

  const { intents } = strategy.evaluate(snapshotShock, position);
  assert.equal(intents.length, 1);
  const exitIntent = intents[0];
  assert.equal(exitIntent.kind, 'EXIT');
  assert.equal(exitIntent.side, 'UP');
  assert.equal(exitIntent.orderType, 'GTC');
  assert.equal(exitIntent.reason, 'ODDS_SHOCK_PROTECTION');
});
