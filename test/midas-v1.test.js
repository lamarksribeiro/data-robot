import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapEngine, createDefaultRegistry } from '../src/composition/bootstrap.js';
import { runConformanceSuite } from '../src/strategy/conformance.js';
import {
  createMidasV1Strategy,
  MIDAS_V1_STRATEGY_ID,
  mergeMidasV1Preset,
} from '../src/strategy/midasV1.js';
import { MIDAS_V1, resolveMidasEntryBudget } from '../src/tfc/preset-midas.js';
import {
  evaluateDangerExit,
  evaluateEntryGates,
  evaluateLateFlipAction,
} from '../src/tfc/evaluate.js';
import { buildStrategyContext } from '../src/engine/contract.js';
import { emptyPosition } from '../src/engine/schemas.js';

function baseBook(overrides = {}) {
  const deep = (n) => Array.from({ length: 5 }, () => ({ size: n }));
  return {
    up: {
      bestBid: 0.6,
      bestAsk: 0.62,
      bids: deep(100),
      asks: deep(100),
      ...overrides.up,
    },
    down: {
      bestBid: 0.36,
      bestAsk: 0.4,
      bids: deep(100),
      asks: deep(100),
      ...overrides.down,
    },
  };
}

function snap(partial = {}) {
  const nowMs = partial.nowMs ?? 1_700_000_000_000;
  return {
    marketId: partial.marketId ?? 'btc-5m-midas',
    nowMs,
    secsLeft: partial.secsLeft ?? 20,
    btc: partial.btc ?? 100.5,
    priceToBeat: partial.priceToBeat ?? 100,
    book: partial.book ?? baseBook(partial.bookOverrides),
    feeds: partial.feeds ?? { healthy: true, rtdsLagMs: 100, clobLagMs: 100 },
    acceptingOrders: true,
    identity: partial.identity ?? { upTokenId: 'up-t', downTokenId: 'down-t' },
  };
}

function historyAround(nowMs, btc = 100.5) {
  return [
    { ts: nowMs - 5000, btc },
    { ts: nowMs - 2500, btc },
    { ts: nowMs, btc },
  ];
}

describe('MIDAS V1 tier budget', () => {
  it('resolveMidasEntryBudget: base abaixo do threshold, 1.5x acima', () => {
    assert.equal(resolveMidasEntryBudget(MIDAS_V1, 0.7), 10);
    assert.equal(resolveMidasEntryBudget(MIDAS_V1, 0.82), 15);
    assert.equal(resolveMidasEntryBudget(MIDAS_V1, 0.9), 15);
  });

  it('ENTER high-ask usa tier 1.5x no quantity', () => {
    const strategy = createMidasV1Strategy();
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({
      nowMs,
      secsLeft: 20,
      btc: 100.5,
      book: baseBook({
        up: {
          bestBid: 0.84,
          bestAsk: 0.85,
          bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
        down: {
          bestBid: 0.12,
          bestAsk: 0.16,
          bids: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
      }),
    });
    const ctx = buildStrategyContext({
      snapshot,
      position: emptyPosition({ marketId: snapshot.marketId }),
      mode: 'shadow',
      clockMs: nowMs,
      preset: MIDAS_V1,
      strategyInstanceId: 'midas:tier',
    });
    const init = strategy.initialize(ctx, MIDAS_V1);
    const out = strategy.onSnapshot(ctx, {
      ...init.state,
      history: historyAround(nowMs, 100.5),
    });
    assert.equal(out.intents[0]?.kind, 'ENTER');
    assert.equal(out.diagnostics.tier?.tierApplied, true);
    assert.equal(out.diagnostics.tier?.entryBudgetUsed, 15);
    assert.equal(out.intents[0]?.quantity, Math.floor(15 / 0.85));
    assert.equal(out.state.entryBudgetUsed, 15);
  });

  it('ENTER ask 0.70 sem tier', () => {
    const strategy = createMidasV1Strategy();
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({
      nowMs,
      secsLeft: 20,
      btc: 100.5,
      book: baseBook({
        up: {
          bestBid: 0.68,
          bestAsk: 0.7,
          bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
        down: {
          bestBid: 0.28,
          bestAsk: 0.32,
          bids: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
      }),
    });
    const ctx = buildStrategyContext({
      snapshot,
      position: emptyPosition({ marketId: snapshot.marketId }),
      mode: 'shadow',
      clockMs: nowMs,
      preset: MIDAS_V1,
      strategyInstanceId: 'midas:base',
    });
    const init = strategy.initialize(ctx, MIDAS_V1);
    const out = strategy.onSnapshot(ctx, {
      ...init.state,
      history: historyAround(nowMs, 100.5),
    });
    assert.equal(out.intents[0]?.kind, 'ENTER');
    assert.equal(out.diagnostics.tier?.tierApplied, false);
    assert.equal(out.diagnostics.tier?.entryBudgetUsed, 10);
  });
});

describe('plugin MIDAS V1 contrato', () => {
  it('passa conformidade com preset MIDAS', () => {
    const strategy = createMidasV1Strategy();
    const report = runConformanceSuite(strategy, { preset: MIDAS_V1 });
    assert.equal(report.pass, true, JSON.stringify(report.errors ?? report.checks));
  });

  it('registry inclui midas-carry-v1', () => {
    const registry = createDefaultRegistry();
    assert.ok(registry.resolve(MIDAS_V1_STRATEGY_ID));
  });

  it('validatePreset exige tierAsk*', () => {
    const strategy = createMidasV1Strategy();
    const bad = mergeMidasV1Preset({ tierAskBudgetFactor: 'x' });
    assert.equal(strategy.validatePreset(bad).ok, false);
  });
});

describe('plugin MIDAS V1 decisões', () => {
  it('ENTER quando gates passam (envelope estendido)', () => {
    const strategy = createMidasV1Strategy();
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({
      nowMs,
      secsLeft: 18,
      btc: 100.3,
      book: baseBook({
        up: {
          bestBid: 0.88,
          bestAsk: 0.9,
          bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
        down: {
          bestBid: 0.08,
          bestAsk: 0.12,
          bids: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
      }),
    });
    const entry = evaluateEntryGates(snapshot, MIDAS_V1, historyAround(nowMs, 100.3));
    assert.equal(entry.ok, true);
    const ctx = buildStrategyContext({
      snapshot,
      position: emptyPosition({ marketId: snapshot.marketId }),
      mode: 'shadow',
      clockMs: nowMs,
      preset: MIDAS_V1,
      strategyInstanceId: 'midas:enter',
    });
    const out = strategy.onSnapshot(ctx, {
      seq: 0,
      history: historyAround(nowMs, 100.3),
      marketId: snapshot.marketId,
      reversed: false,
      closed: false,
      lastIntentKind: null,
      entryBudgetUsed: null,
    });
    assert.equal(out.intents[0]?.kind, 'ENTER');
    assert.equal(out.intents[0]?.reason, 'midas_core_entry');
  });

  it('0 decisão abaixo do piso 4s', () => {
    const strategy = createMidasV1Strategy();
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({ nowMs, secsLeft: 3.5 });
    const ctx = buildStrategyContext({
      snapshot,
      position: emptyPosition({ marketId: snapshot.marketId }),
      mode: 'shadow',
      clockMs: nowMs,
      preset: MIDAS_V1,
      strategyInstanceId: 'midas:floor',
    });
    const out = strategy.onSnapshot(ctx, {
      seq: 0,
      history: historyAround(nowMs),
      marketId: snapshot.marketId,
      reversed: false,
      closed: false,
      lastIntentKind: null,
      entryBudgetUsed: null,
    });
    assert.equal(out.intents.length, 0);
    assert.equal(out.diagnostics.skip, 'below_tactical_floor');
  });
});

describe('paridade MIDAS V1 — 100 casos sintéticos', () => {
  const strategy = createMidasV1Strategy();
  const preset = MIDAS_V1;

  function expectedKinds(snapshot, position, state) {
    if (snapshot.feeds?.healthy === false) return [];
    const floor = preset.lateFlipMinSec;
    if (snapshot.secsLeft != null && snapshot.secsLeft < floor) return [];

    if (position.qty > 0 && position.side && !state.closed) {
      const danger = evaluateDangerExit(snapshot, preset, position.side, state.history);
      if (danger.active && !state.reversed) return ['EXIT'];
      const late = evaluateLateFlipAction(snapshot, preset, position.side, state);
      if (late.action === 'REVERSE') return ['REVERSE'];
      if (late.action === 'EXIT') return ['EXIT'];
      return [];
    }

    if (position.qty <= 0 && !state.closed) {
      const entry = evaluateEntryGates(snapshot, preset, state.history);
      return entry.ok ? ['ENTER'] : [];
    }
    return [];
  }

  function buildCases() {
    const cases = [];
    const now0 = 1_700_000_000_000;

    for (let i = 0; i < 25; i++) {
      cases.push({
        id: `entry-window-${i}`,
        snapshot: snap({
          nowMs: now0 + i * 1000,
          secsLeft: 4 + i,
          btc: 100.5,
          marketId: `midas-entry-${i}`,
        }),
        position: emptyPosition({ marketId: `midas-entry-${i}` }),
        historyBtc: 100.5,
      });
    }

    for (let i = 0; i < 25; i++) {
      const dist = i * 2; // 0..48 vs maxDistAbs 40
      const ask = 0.55 + i * 0.02; // cruza 0.82 e 0.94
      const deep = (n) => Array.from({ length: 5 }, () => ({ size: n }));
      cases.push({
        id: `gates-${i}`,
        snapshot: snap({
          nowMs: now0 + 100_000 + i * 1000,
          secsLeft: 15,
          btc: 100 + dist,
          priceToBeat: 100,
          book: baseBook({
            up: {
              bestBid: Math.max(0.01, ask - 0.02),
              bestAsk: Math.min(0.99, ask),
              bids: deep(100),
              asks: deep(100),
            },
            down: {
              bestBid: 0.3,
              bestAsk: Math.min(0.99, Math.max(0.01, 1.02 - ask)),
              bids: deep(100),
              asks: deep(100),
            },
          }),
          marketId: `midas-gates-${i}`,
        }),
        position: emptyPosition({ marketId: `midas-gates-${i}` }),
        historyBtc: 100 + dist,
      });
    }

    for (let i = 0; i < 20; i++) {
      const secsLeft = 4 + (i % 5);
      const oppAsk = 0.5 + i * 0.03;
      cases.push({
        id: `late-${i}`,
        snapshot: snap({
          nowMs: now0 + 200_000 + i * 1000,
          secsLeft,
          btc: 99 - (i % 3),
          priceToBeat: 100,
          book: baseBook({
            down: {
              bestBid: 0.4,
              bestAsk: oppAsk,
              bids: [{ size: 10 }],
              asks: [{ size: 10 }],
            },
          }),
          marketId: `midas-late-${i}`,
        }),
        position: {
          marketId: `midas-late-${i}`,
          side: 'UP',
          qty: 5,
          avgPrice: 0.62,
          realizedPnl: 0,
        },
        historyBtc: 99,
      });
    }

    for (let i = 0; i < 15; i++) {
      const secsLeft = 3.5 + i * 0.1;
      const btc = 100 + (i % 5) * 0.01;
      cases.push({
        id: `danger-${i}`,
        snapshot: snap({
          nowMs: now0 + 300_000 + i * 1000,
          secsLeft,
          btc,
          priceToBeat: 100,
          marketId: `midas-danger-${i}`,
        }),
        position: {
          marketId: `midas-danger-${i}`,
          side: 'UP',
          qty: 3,
          avgPrice: 0.6,
          realizedPnl: 0,
        },
        historyBtc: btc,
        volatileHistory: true,
      });
    }

    for (let i = 0; i < 15; i++) {
      cases.push({
        id: `misc-${i}`,
        snapshot: snap({
          nowMs: now0 + 400_000 + i * 1000,
          secsLeft: 20,
          btc: 100.5,
          feeds: i % 2 === 0 ? { healthy: false } : { healthy: true },
          marketId: `midas-misc-${i}`,
        }),
        position: emptyPosition({ marketId: `midas-misc-${i}` }),
        historyBtc: 100.5,
        closed: i % 3 === 0,
      });
    }

    return cases;
  }

  it('diferença de intenção = 0 em ≥100 casos', () => {
    const cases = buildCases();
    assert.ok(cases.length >= 100, `esperava ≥100, got ${cases.length}`);

    let mismatches = 0;
    const details = [];

    for (const c of cases) {
      const nowMs = c.snapshot.nowMs;
      const hist = c.volatileHistory
        ? [
            { ts: nowMs - 4000, btc: c.historyBtc - 0.5 },
            { ts: nowMs - 2000, btc: c.historyBtc + 0.5 },
            { ts: nowMs - 1000, btc: c.historyBtc - 0.4 },
            { ts: nowMs, btc: c.historyBtc },
          ]
        : historyAround(nowMs, c.historyBtc);

      const state = {
        seq: 0,
        history: hist,
        marketId: c.snapshot.marketId,
        reversed: false,
        closed: Boolean(c.closed),
        lastIntentKind: null,
        entryBudgetUsed: null,
      };

      const expect = expectedKinds(c.snapshot, c.position, state);
      const ctx = buildStrategyContext({
        snapshot: c.snapshot,
        position: c.position,
        mode: 'shadow',
        clockMs: nowMs,
        preset,
        strategyInstanceId: 'midas-carry-v1:parity',
      });
      const out = strategy.onSnapshot(ctx, state);
      const actual = out.intents.map((x) => x.kind);
      const same =
        actual.length === expect.length && actual.every((k, idx) => k === expect[idx]);
      if (!same) {
        mismatches += 1;
        details.push({ id: c.id, expect, actual, diag: out.diagnostics });
      }
    }

    assert.equal(mismatches, 0, JSON.stringify(details.slice(0, 5), null, 2));
  });
});

describe('shadow MIDAS V1 no kernel', () => {
  it('bootstrap shadow gera ENTER e abre posição', async () => {
    const engine = bootstrapEngine({
      strategyId: MIDAS_V1_STRATEGY_ID,
      mode: 'shadow',
      preset: MIDAS_V1,
    });
    engine.start();
    const nowMs = 1_700_000_000_000;
    await engine.ingestMarketSnapshot(
      snap({
        nowMs,
        secsLeft: 20,
        btc: 100.5,
        book: baseBook({
          up: {
            bestBid: 0.6,
            bestAsk: 0.62,
            bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
            asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
          },
        }),
      }),
    );
    const status = engine.getStatus();
    assert.ok(status.position.qty > 0 || engine.journal.some((j) => j.type === 'sink'));
  });
});
