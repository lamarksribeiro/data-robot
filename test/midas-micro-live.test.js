import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapMidasCanaryEngine } from '../src/composition/midasCanary.js';
import {
  CANARY_LIMITS,
  MIDAS_ROBUST_V1,
  MIDAS_V1,
  MICRO_ROBUST,
  canaryMidasPreset,
  resolveMidasEntryBudget,
} from '../src/tfc/preset-midas.js';
import { hasLiveFlag } from '../src/cli/liveGate.js';
import { MIDAS_V1_PRESET_ID } from '../src/strategy/midasV1.js';

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
  it('canaryMidasPreset = Robust + micro $2/$3', () => {
    const p = canaryMidasPreset();
    assert.equal(p.maxDistAbs, 30);
    assert.equal(p.entryBudget, MICRO_ROBUST.entryBudget);
    assert.equal(p.maxEntryBudget, MICRO_ROBUST.maxEntryBudget);
    assert.equal(p.maxAsk, MIDAS_ROBUST_V1.maxAsk);
    assert.equal(p.tierAskBudgetFactor, 1.5);
    assert.equal(p.entryOrderType, 'FAK');
    assert.notEqual(p.maxDistAbs, MIDAS_V1.maxDistAbs);
  });

  it('tier 1.5× sobe $2 → $3 e não é cortado', () => {
    const p = canaryMidasPreset();
    assert.equal(resolveMidasEntryBudget(p, 0.7), 2);
    assert.equal(resolveMidasEntryBudget(p, 0.82), 3);
    assert.equal(resolveMidasEntryBudget(p, 0.9), 3);
  });

  it('dry-run canário: notional ≤ cap $3 e ≥ $1 marketable', async () => {
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

  it('risk canário aceita teto $3 (tier) e presetId micro-robust', () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    assert.equal(engine.canary.maxCanaryBudget, 3);
    assert.equal(engine.canary.presetId, `${MIDAS_V1_PRESET_ID}-canary`);
  });

  it('dry-run com ask high-tier: budget efetivo ≤ $3', async () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    engine.start();
    await engine.ingestMarketSnapshot(snap(0.85));
    const sink = [...engine.journal].reverse().find((j) => j.type === 'sink');
    if (sink?.intent) {
      assert.ok(Number(sink.intent.budget) <= 3 + 1e-9);
      assert.ok(Number(sink.intent.budget) >= 1 - 1e-9);
    }
    await engine.safeShutdown('test');
  });

  it('live mock exige client+flags; dry-run bootstrap ok', () => {
    const engine = bootstrapMidasCanaryEngine({ mode: 'dry-run' });
    assert.equal(engine.canary.maxCanaryBudget, 3);
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
    assert.equal(pkg.scripts['midas:exit-live'], 'node scripts/midas/micro-live.js --wait-exit');
    assert.equal(hasLiveFlag(['node', 'x']), false);
    assert.equal(hasLiveFlag(['node', 'x', '--live']), true);
  });

  it('EXIT danger inclui tokenId e orderType FAK no canário', async () => {
    const { createMidasV1Strategy } = await import('../src/strategy/midasV1.js');
    const { buildStrategyContext } = await import('../src/engine/contract.js');
    const strategy = createMidasV1Strategy();
    const preset = canaryMidasPreset({ lateFlipReverseEnabled: false });
    const nowMs = 1_700_000_000_000;
    const snapshot = {
      ...snap(0.62),
      nowMs,
      secsLeft: 4.5,
      btc: 100.01,
      priceToBeat: 100,
      book: bookOk(0.62),
    };
    snapshot.book.up.bestBid = 0.6;
    const ctx = buildStrategyContext({
      snapshot,
      position: { marketId: snapshot.marketId, side: 'UP', qty: 2, avgPrice: 0.62, realizedPnl: 0 },
      mode: 'shadow',
      clockMs: nowMs,
      preset,
      strategyInstanceId: 'exit-tok',
    });
    const init = strategy.initialize(ctx, preset);
    const history = [];
    for (let i = 0; i < 12; i += 1) {
      history.push({ ts: nowMs - (12 - i) * 400, btc: 100 + (i % 2 === 0 ? 0.5 : -0.5) });
    }
    history.push({ ts: nowMs, btc: 100.01 });
    snapshot.btc = 100.01;
    const out = strategy.onSnapshot(ctx, { ...init.state, history, marketId: snapshot.marketId });
    const exit = out.intents.find((i) => i.kind === 'EXIT');
    assert.ok(exit, `esperava EXIT, intents=${JSON.stringify(out.intents)} diag=${JSON.stringify(out.diagnostics)}`);
    assert.equal(exit.tokenId, 'up');
    assert.equal(exit.orderType, 'FAK');
    assert.ok(Number(exit.minPrice) >= 0.05);
  });
});
