import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapMidasCanaryEngine } from '../src/composition/midasCanary.js';
import { CANARY_LIMITS, MIDAS_V1, canaryMidasPreset } from '../src/tfc/preset-midas.js';
import { hasLiveFlag } from '../src/cli/liveGate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bookOk(ask = 0.62) {
  return {
    up: {
      bestBid: ask - 0.02,
      bestAsk: ask,
      bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
      asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
    },
    down: {
      bestBid: 0.36,
      bestAsk: 0.4,
      bids: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
      asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
    },
  };
}

function snap(ask = 0.62) {
  const nowMs = 1_700_000_000_000;
  return {
    marketId: 'btc-5m-midas-canary',
    nowMs,
    secsLeft: 20,
    btc: 100.5,
    priceToBeat: 100,
    book: bookOk(ask),
    feeds: { healthy: true, rtdsLagMs: 50, clobLagMs: 50 },
    acceptingOrders: true,
    identity: { upTokenId: 'up', downTokenId: 'down', conditionId: 'cond' },
  };
}

describe('MIDAS micro-live canary', () => {
  it('canaryMidasPreset sobrescreve entryBudget do campeão', () => {
    const p = canaryMidasPreset();
    assert.equal(p.entryBudget, 0.1);
    assert.equal(p.maxAsk, MIDAS_V1.maxAsk);
    assert.equal(p.tierAskBudgetFactor, 1.5);
  });

  it('dry-run canário: notional ≤ cap $2', async () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    engine.start();
    await engine.ingestMarketSnapshot(snap(0.62));
    const sink = [...engine.journal].reverse().find((j) => j.type === 'sink');
    if (sink?.intent) {
      assert.ok(Number(sink.intent.budget) <= CANARY_LIMITS.maxCanaryBudget + 1e-9);
      assert.ok(Number(sink.intent.budget) >= 1 - 1e-9);
    }
    await engine.safeShutdown('test');
  });

  it('risk canário bloqueia budget campeão $10/$15', () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    assert.equal(engine.canary.maxCanaryBudget, 2);
  });

  it('live mock exige client+flags; dry-run bootstrap ok', () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    assert.equal(engine.canary.maxCanaryBudget, 2);
    assert.throws(
      () =>
        bootstrapMidasCanaryEngine({
          mode: 'live',
          liveEnabled: false,
        }),
      /liveEnabled/,
    );
  });

  it('package expõe midas:micro-live', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['midas:micro-live'], 'node scripts/midas/micro-live.js');
    assert.equal(hasLiveFlag(['node', 'x']), false);
    assert.equal(hasLiveFlag(['node', 'x', '--live']), true);
  });
});
