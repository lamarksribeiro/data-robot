import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapEngine, createDefaultRegistry } from '../src/composition/bootstrap.js';
import { runConformanceSuite } from '../src/strategy/conformance.js';
import {
  createApexTriadV1Strategy,
  APEX_TRIAD_V1_STRATEGY_ID,
  mergeApexTriadV1Preset,
} from '../src/strategy/apexTriadV1.js';
import { APEX_TRIAD_V1 } from '../src/tfc/preset-apex.js';
import {
  evaluateEdgeEntry,
  evaluateTerminalEntry,
  inWindow,
} from '../src/tfc/apexEvaluate.js';
import { scoreSides } from '../src/tfc/edgeModels.js';

function baseBook(overrides = {}) {
  return {
    up: {
      bestBid: 0.6,
      bestAsk: 0.62,
      bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
      asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
      ...overrides.up,
    },
    down: {
      bestBid: 0.36,
      bestAsk: 0.4,
      bids: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
      asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
      ...overrides.down,
    },
  };
}

function snap(partial = {}) {
  const nowMs = partial.nowMs ?? 1_700_000_000_000;
  return {
    marketId: partial.marketId ?? 'btc-5m-apex',
    nowMs,
    secsLeft: partial.secsLeft ?? 20,
    btc: partial.btc ?? 100.5,
    priceToBeat: partial.priceToBeat ?? 100,
    book: partial.book ?? baseBook(partial.bookOverrides),
    feeds: partial.feeds ?? { healthy: true, rtdsLagMs: 100, clobLagMs: 100 },
    acceptingOrders: true,
  };
}

function historyAround(nowMs, btc = 100.5) {
  return [
    { ts: nowMs - 8000, btc: btc - 2 },
    { ts: nowMs - 6000, btc: btc - 1 },
    { ts: nowMs - 4000, btc },
    { ts: nowMs - 2000, btc },
    { ts: nowMs, btc },
  ];
}

describe('Apex Triad helpers', () => {
  it('inWindow segue semântica GLS', () => {
    assert.equal(inWindow(50, 105, 31), true);
    assert.equal(inWindow(31, 105, 31), false);
    assert.equal(inWindow(106, 105, 31), false);
  });

  it('scoreSides retorna candidato com edge positivo', () => {
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({ nowMs, btc: 145, priceToBeat: 100, secsLeft: 60 });
    const scored = scoreSides(snapshot, historyAround(nowMs, 145), APEX_TRIAD_V1);
    assert.ok(scored.best);
    assert.ok(scored.best.edge > 0);
  });

  it('terminal entry passa com gates TFC', () => {
    const nowMs = 1_700_000_000_000;
    const result = evaluateTerminalEntry(
      snap({ nowMs, secsLeft: 20, btc: 100.5, priceToBeat: 100 }),
      APEX_TRIAD_V1,
      historyAround(nowMs),
    );
    assert.equal(result.ok, true);
    assert.equal(result.side, 'UP');
  });
});

describe('Apex Triad plugin', () => {
  it('passa conformidade', () => {
    const strategy = createApexTriadV1Strategy();
    const report = runConformanceSuite(strategy, { preset: APEX_TRIAD_V1 });
    assert.equal(report.pass, true, JSON.stringify(report.errors));
  });

  it('registry inclui apex-triad-v1', () => {
    const ids = createDefaultRegistry().list().map((m) => m.id);
    assert.ok(ids.includes(APEX_TRIAD_V1_STRATEGY_ID));
  });

  it('shadow entra no terminal quando gates passam', async () => {
    const engine = bootstrapEngine({
      strategyId: APEX_TRIAD_V1_STRATEGY_ID,
      mode: 'shadow',
      preset: mergeApexTriadV1Preset({ terminalEnabled: true, edgeEnabled: false }),
    });
    engine.start();
    const nowMs = 1_700_000_000_000;
    await engine.ingestSnapshot(snap({ nowMs, secsLeft: 20, btc: 100.5, priceToBeat: 100 }));
    assert.ok(engine.position.qty > 0);
    assert.equal(engine.position.side, 'UP');
  });
});
