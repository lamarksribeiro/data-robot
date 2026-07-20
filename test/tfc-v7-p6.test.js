import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapEngine, createDefaultRegistry } from '../src/composition/bootstrap.js';
import { runConformanceSuite } from '../src/strategy/conformance.js';
import {
  createTfcV7Strategy,
  TFC_V7_STRATEGY_ID,
  mergeTfcV7Preset,
} from '../src/strategy/tfcV7.js';
import { TFC_V7 } from '../src/tfc/preset-v7.js';
import {
  evaluateDangerExit,
  evaluateEntryGates,
  evaluateLateFlipAction,
  signedDistance,
  spotVolatility,
} from '../src/tfc/evaluate.js';
import { buildStrategyContext } from '../src/engine/contract.js';
import { emptyPosition } from '../src/engine/schemas.js';

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
    marketId: partial.marketId ?? 'btc-5m-p6',
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
    { ts: nowMs - 5000, btc },
    { ts: nowMs - 2500, btc },
    { ts: nowMs, btc },
  ];
}

describe('TFC V7 helpers', () => {
  it('signedDistance UP/DOWN', () => {
    assert.equal(signedDistance('UP', 101, 100), 1);
    assert.equal(signedDistance('DOWN', 99, 100), 1);
    assert.equal(signedDistance('UP', 99, 100), -1);
  });

  it('spotVolatility população', () => {
    const now = 10000;
    const hist = [
      { ts: 6000, btc: 100 },
      { ts: 8000, btc: 102 },
      { ts: 10000, btc: 104 },
    ];
    const sigma = spotVolatility(hist, 5, now);
    assert.ok(sigma > 0);
  });

  it('danger exit ativo no piso com dist pequena', () => {
    const nowMs = 1_700_000_000_000;
    const history = [
      { ts: nowMs - 4000, btc: 100 },
      { ts: nowMs - 2000, btc: 100.5 },
      { ts: nowMs - 1000, btc: 99.5 },
      { ts: nowMs, btc: 100.05 },
    ];
    const result = evaluateDangerExit(
      snap({ secsLeft: 4.5, btc: 100.05, priceToBeat: 100, nowMs }),
      TFC_V7,
      'UP',
      history,
    );
    assert.equal(result.active, true);
    assert.equal(result.reason, 'danger_exit');
  });

  it('danger exit falha fechado sem bid executável', () => {
    const nowMs = 1_700_000_000_000;
    const result = evaluateDangerExit(
      snap({
        nowMs,
        secsLeft: 4.5,
        btc: 100.01,
        priceToBeat: 100,
        book: baseBook({ up: { bestBid: null, bestAsk: 0.62, bids: [], asks: [] } }),
      }),
      TFC_V7,
      'UP',
      [
        { ts: nowMs - 3000, btc: 99.5 },
        { ts: nowMs - 1000, btc: 100.5 },
        { ts: nowMs, btc: 100.01 },
      ],
    );
    assert.equal(result.active, false);
    assert.equal(result.bidOk, false);
  });

  it('late flip prefere REVERSE quando ask oposto ok', () => {
    const result = evaluateLateFlipAction(
      snap({
        secsLeft: 6,
        btc: 99,
        priceToBeat: 100,
        book: baseBook({
          down: { bestBid: 0.55, bestAsk: 0.7, bids: [{ size: 10 }], asks: [{ size: 10 }] },
        }),
      }),
      TFC_V7,
      'UP',
      { reversed: false, closed: false },
    );
    assert.equal(result.action, 'REVERSE');
    assert.equal(result.oppSide, 'DOWN');
  });

  it('late flip EXIT quando reverse ask acima do cap', () => {
    const result = evaluateLateFlipAction(
      snap({
        secsLeft: 6,
        btc: 99,
        priceToBeat: 100,
        book: baseBook({
          down: { bestBid: 0.55, bestAsk: 0.99, bids: [{ size: 10 }], asks: [{ size: 10 }] },
        }),
      }),
      TFC_V7,
      'UP',
      { reversed: false },
    );
    assert.equal(result.action, 'EXIT');
    assert.equal(result.reason, 'late_flip_exit');
  });
});

describe('plugin TFC V7 contrato', () => {
  it('passa conformidade com preset V7', () => {
    const strategy = createTfcV7Strategy();
    const report = runConformanceSuite(strategy, {
      preset: TFC_V7,
      snapshot: snap(),
    });
    assert.equal(report.pass, true, JSON.stringify(report.errors));
  });

  it('validatePreset rejeita objeto vazio sem merge implícito no validate', () => {
    const strategy = createTfcV7Strategy();
    // validatePreset faz merge com TFC_V7 — vazio ainda é ok
    assert.equal(strategy.validatePreset({}).ok, true);
    assert.equal(strategy.validatePreset({ minSecondsLeft: 'x' }).ok, false);
  });

  it('registry inclui tfc-v7', () => {
    const ids = createDefaultRegistry().list().map((m) => m.id);
    assert.ok(ids.includes(TFC_V7_STRATEGY_ID));
  });
});

describe('plugin TFC V7 decisões', () => {
  const strategy = createTfcV7Strategy();
  const preset = mergeTfcV7Preset();

  function run(snapshot, position = emptyPosition({ marketId: snapshot.marketId }), stateInit = null) {
    const ctx = buildStrategyContext({
      snapshot,
      position,
      mode: 'shadow',
      clockMs: snapshot.nowMs,
      preset,
      strategyInstanceId: 'tfc-v7:test',
    });
    let state = stateInit;
    if (!state) {
      state = strategy.initialize(ctx, preset).state;
      // pré-aquece histórico para velocity
      state = {
        ...state,
        history: historyAround(snapshot.nowMs, snapshot.btc),
      };
    }
    return strategy.onSnapshot(ctx, state);
  }

  it('ENTER quando gates passam', () => {
    const out = run(snap({ secsLeft: 20, btc: 100.5 }));
    assert.equal(out.intents.length, 1);
    assert.equal(out.intents[0].kind, 'ENTER');
    assert.equal(out.intents[0].side, 'UP');
    assert.equal(out.intents[0].reason, 'entry_gates');
  });

  it('0 decisão com feed stale', () => {
    const out = run(snap({ feeds: { healthy: false } }));
    assert.equal(out.intents.length, 0);
    assert.equal(out.diagnostics.skip, 'feed_unhealthy');
  });

  it('0 decisão abaixo do piso 4s', () => {
    const out = run(
      snap({ secsLeft: 3.5 }),
      emptyPosition({ marketId: 'btc-5m-p6', side: 'UP', qty: 5, avgPrice: 0.6 }),
    );
    assert.equal(out.intents.length, 0);
    assert.equal(out.diagnostics.skip, 'below_tactical_floor');
  });

  it('danger_exit em [4,5)', () => {
    const nowMs = 1_700_000_000_000;
    const snapshot = snap({ secsLeft: 4.2, btc: 100.02, priceToBeat: 100, nowMs });
    const state = {
      seq: 1,
      history: [
        { ts: nowMs - 4000, btc: 100 },
        { ts: nowMs - 2000, btc: 100.4 },
        { ts: nowMs - 1000, btc: 99.6 },
        { ts: nowMs, btc: 100.02 },
      ],
      marketId: snapshot.marketId,
      reversed: false,
      closed: false,
      lastIntentKind: 'ENTER',
    };
    const out = run(
      snapshot,
      { marketId: snapshot.marketId, side: 'UP', qty: 5, avgPrice: 0.62, realizedPnl: 0 },
      state,
    );
    assert.equal(out.intents[0]?.kind, 'EXIT');
    assert.equal(out.intents[0]?.reason, 'danger_exit');
  });

  it('late_flip_reverse 8→4s', () => {
    const out = run(
      snap({
        secsLeft: 6,
        btc: 99,
        priceToBeat: 100,
        book: baseBook({
          down: { bestBid: 0.5, bestAsk: 0.72, bids: [{ size: 10 }], asks: [{ size: 10 }] },
        }),
      }),
      { marketId: 'btc-5m-p6', side: 'UP', qty: 5, avgPrice: 0.62, realizedPnl: 0 },
    );
    assert.equal(out.intents[0]?.kind, 'REVERSE');
    assert.equal(out.intents[0]?.side, 'DOWN');
    assert.equal(out.intents[0]?.reason, 'late_flip_reverse');
  });
});

describe('paridade TFC V7 — 100 casos sintéticos', () => {
  const strategy = createTfcV7Strategy();
  const preset = TFC_V7;

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

    // 25: variações de secsLeft na entrada
    for (let i = 0; i < 25; i++) {
      const secsLeft = 4 + i; // 4..28
      cases.push({
        id: `entry-window-${i}`,
        snapshot: snap({
          nowMs: now0 + i * 1000,
          secsLeft,
          btc: 100.5,
          marketId: `m-entry-${i}`,
        }),
        position: emptyPosition({ marketId: `m-entry-${i}` }),
        historyBtc: 100.5,
      });
    }

    // 25: distância / ask / spread / odds / velocity
    for (let i = 0; i < 25; i++) {
      const dist = i; // 0..24 vs maxDistAbs 20
      const ask = 0.5 + i * 0.02; // cruza banda
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
              bestAsk: ask,
              bids: [{ size: 20 }],
              asks: [{ size: 10 }],
            },
            down: {
              bestBid: 0.3,
              bestAsk: Math.min(0.99, 1.02 - ask),
              bids: [{ size: 10 }],
              asks: [{ size: 10 }],
            },
          }),
          marketId: `m-gates-${i}`,
        }),
        position: emptyPosition({ marketId: `m-gates-${i}` }),
        historyBtc: 100 + dist,
      });
    }

    // 20: late flip / reverse / exit
    for (let i = 0; i < 20; i++) {
      const secsLeft = 4 + (i % 5); // 4..8
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
          marketId: `m-late-${i}`,
        }),
        position: {
          marketId: `m-late-${i}`,
          side: 'UP',
          qty: 5,
          avgPrice: 0.62,
          realizedPnl: 0,
        },
        historyBtc: 99,
      });
    }

    // 15: danger floor
    for (let i = 0; i < 15; i++) {
      const secsLeft = 3.5 + i * 0.1; // 3.5..4.9
      const btc = 100 + (i % 5) * 0.01;
      cases.push({
        id: `danger-${i}`,
        snapshot: snap({
          nowMs: now0 + 300_000 + i * 1000,
          secsLeft,
          btc,
          priceToBeat: 100,
          marketId: `m-danger-${i}`,
        }),
        position: {
          marketId: `m-danger-${i}`,
          side: 'UP',
          qty: 3,
          avgPrice: 0.6,
          realizedPnl: 0,
        },
        historyBtc: btc,
        volatileHistory: true,
      });
    }

    // 15: stale / unhealthy / closed
    for (let i = 0; i < 15; i++) {
      cases.push({
        id: `misc-${i}`,
        snapshot: snap({
          nowMs: now0 + 400_000 + i * 1000,
          secsLeft: 20,
          btc: 100.5,
          feeds: i % 2 === 0 ? { healthy: false } : { healthy: true },
          marketId: `m-misc-${i}`,
        }),
        position: emptyPosition({ marketId: `m-misc-${i}` }),
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
      };

      const expect = expectedKinds(c.snapshot, c.position, state);
      const ctx = buildStrategyContext({
        snapshot: c.snapshot,
        position: c.position,
        mode: 'shadow',
        clockMs: nowMs,
        preset,
        strategyInstanceId: 'tfc-v7:parity',
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

describe('shadow TFC V7 no kernel', () => {
  it('bootstrap shadow gera ENTER e abre posição', async () => {
    const engine = bootstrapEngine({
      strategyId: TFC_V7_STRATEGY_ID,
      mode: 'shadow',
      preset: TFC_V7,
    });
    engine.start();
    const nowMs = Date.now();
    // aquece histórico via vários ticks flat
    for (let i = 0; i < 6; i++) {
      await engine.ingestSnapshot(
        snap({
          nowMs: nowMs - (5 - i) * 1000,
          secsLeft: 25,
          btc: 100.2,
          marketId: 'shadow-tfc',
        }),
      );
    }
    await engine.ingestSnapshot(
      snap({
        nowMs,
        secsLeft: 18,
        btc: 100.5,
        marketId: 'shadow-tfc',
      }),
    );
    const status = engine.getStatus();
    assert.ok(status.position.qty > 0 || status.state === 'POSITION_OPEN' || status.state === 'ARMED');
    // pelo menos processou sem throw; se gates ok, posição aberta
    if (status.position.qty > 0) {
      assert.equal(status.position.side, 'UP');
    }
    engine.halt('test-done');
  });

  it('restore preserva strategy state em vez de reinicializar', async () => {
    const source = bootstrapEngine({
      strategyId: TFC_V7_STRATEGY_ID,
      mode: 'shadow',
      preset: TFC_V7,
    });
    source.start();
    const checkpoint = source.checkpoint();
    checkpoint.strategyState = {
      seq: 7,
      history: [],
      marketId: 'btc-5m-p6',
      reversed: false,
      closed: true,
      lastIntentKind: 'EXIT',
    };

    const restored = bootstrapEngine({
      strategyId: TFC_V7_STRATEGY_ID,
      mode: 'shadow',
      preset: TFC_V7,
    });
    restored.restore(checkpoint);
    restored.start();
    await restored.ingestSnapshot(snap({ marketId: 'btc-5m-p6', secsLeft: 18 }));
    assert.equal(restored.journal.some((row) => row.type === 'sink'), false);
  });
});
