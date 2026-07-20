import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapEngine, createDefaultRegistry } from '../src/composition/bootstrap.js';
import { runConformanceSuite } from '../src/strategy/conformance.js';
import { createPriceCrossStrategy } from '../src/strategy/fixtures/priceCross.js';
import { createSpreadWideStrategy } from '../src/strategy/fixtures/spreadWide.js';
import { ENGINE_STATES } from '../src/engine/schemas.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function snapshot({ btc = 100, spread = 0.02, marketId = 'btc-5m-1' } = {}) {
  return {
    marketId,
    nowMs: 1_700_000_000_000,
    secsLeft: 25,
    btc,
    priceToBeat: 99,
    book: {
      up: { bestBid: 0.5, bestAsk: 0.5 + spread, bids: [{ size: 10 }], asks: [{ size: 10 }] },
      down: { bestBid: 0.48, bestAsk: 0.5, bids: [{ size: 10 }], asks: [{ size: 10 }] },
    },
    feeds: { healthy: true, rtdsLagMs: 100, clobLagMs: 100 },
    acceptingOrders: true,
  };
}

describe('architecture boundary', () => {
  it('src/engine não importa strategy nem tfc', () => {
    const engineDir = path.join(root, 'src', 'engine');
    const files = listJs(engineDir);
    assert.ok(files.length > 0);
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let m;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(text))) {
        const spec = m[1];
        assert.equal(
          /(^|[./])(strategy|tfc)(\/|$)/.test(spec),
          false,
          `${path.relative(root, file)} importa ${spec}`,
        );
      }
    }
  });

  it('src/market não importa strategy nem tfc', () => {
    const marketDir = path.join(root, 'src', 'market');
    const files = listJs(marketDir);
    assert.ok(files.length > 0);
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let m;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(text))) {
        const spec = m[1];
        assert.equal(
          /(^|[./])(strategy|tfc)(\/|$)/.test(spec),
          false,
          `${path.relative(root, file)} importa ${spec}`,
        );
      }
    }
  });
});

describe('conformance fixtures', () => {
  it('price-cross passa na suíte', () => {
    const report = runConformanceSuite(createPriceCrossStrategy(), {
      preset: { threshold: 100, budget: 1, maxPrice: 0.6 },
    });
    assert.equal(report.pass, true, JSON.stringify(report.errors));
  });

  it('spread-wide passa na suíte', () => {
    const report = runConformanceSuite(createSpreadWideStrategy(), {
      preset: { minSpread: 0.01, budget: 1, quantity: 5 },
    });
    assert.equal(report.pass, true, JSON.stringify(report.errors));
  });
});

describe('registry + bootstrap', () => {
  it('lista fixtures + tfc-v7', () => {
    const ids = createDefaultRegistry().list().map((m) => m.id).sort();
    assert.deepEqual(ids, ['fixture-price-cross', 'fixture-spread-wide', 'tfc-v7']);
  });
});

describe('engine dry-run / shadow', () => {
  it('dry-run gera intent sem abrir posição', async () => {
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'dry-run',
      preset: { threshold: 50, budget: 1, maxPrice: 0.6 },
    });
    engine.start();
    assert.equal(engine.state, 'ARMED');
    await engine.ingestSnapshot(snapshot({ btc: 100 }));
    assert.equal(engine.position.qty, 0);
    assert.ok(engine.journal.some((j) => j.type === 'sink'));
  });

  it('shadow preenche posição no price-cross', async () => {
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 50, budget: 2, maxPrice: 0.5 },
    });
    engine.start();
    await engine.ingestSnapshot(snapshot({ btc: 100 }));
    assert.ok(engine.position.qty > 0);
    assert.equal(engine.position.side, 'UP');
    assert.equal(engine.state, 'POSITION_OPEN');
  });

  it('shadow spread-wide entra DOWN', async () => {
    const engine = bootstrapEngine({
      strategyId: 'fixture-spread-wide',
      mode: 'shadow',
      preset: { minSpread: 0.01, budget: 1, quantity: 7 },
    });
    engine.start();
    await engine.ingestSnapshot(snapshot({ spread: 0.05 }));
    assert.equal(engine.position.side, 'DOWN');
    assert.equal(engine.position.qty, 7);
  });

  it('mesma máquina de estados nos modos', () => {
    for (const mode of ['dry-run', 'shadow', 'live']) {
      const liveSink = {
        assertReady: () => true,
        submit: async () => ({ accepted: true, events: [] }),
      };
      const passingChecks = {
        auth: () => ({ ok: true }),
        geoblock: () => ({ ok: true, blocked: false }),
        clock: () => ({ ok: true }),
        balance: () => ({ ok: true }),
      };
      const engine = bootstrapEngine({
        strategyId: 'fixture-price-cross',
        mode,
        preset: { threshold: 1 },
        liveEnabled: mode === 'live',
        sink: mode === 'live' ? liveSink : undefined,
        riskOpts: mode === 'live' ? { preflightChecks: passingChecks } : undefined,
      });
      const status = engine.start();
      assert.ok(ENGINE_STATES.includes(status.state));
      assert.equal(status.mode, mode);
      assert.equal(status.strategyId, 'fixture-price-cross');
    }
  });

  it('halt bloqueia novos snapshots', async () => {
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1 },
    });
    engine.start();
    engine.halt('test');
    const result = await engine.ingestSnapshot(snapshot({ btc: 999 }));
    assert.equal(result.skipped, true);
    assert.equal(engine.state, 'HALTED');
  });

  it('trocar strategyId não exige mudar o core', async () => {
    for (const strategyId of ['fixture-price-cross', 'fixture-spread-wide']) {
      const preset =
        strategyId === 'fixture-price-cross'
          ? { threshold: 1, budget: 1, maxPrice: 0.5 }
          : { minSpread: 0.01, quantity: 3 };
      const engine = bootstrapEngine({ strategyId, mode: 'shadow', preset });
      engine.start();
      await engine.ingestSnapshot(snapshot({ btc: 100, spread: 0.05 }));
      assert.equal(engine.strategyId, strategyId);
      assert.ok(engine.position.qty > 0);
    }
  });
});
