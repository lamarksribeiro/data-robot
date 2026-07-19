import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketState } from '../src/feeds/marketState.js';
import { evaluateFeedHealth, STALENESS } from '../src/market/health.js';
import { buildMarketSnapshot } from '../src/market/normalize.js';
import { evaluateSnapshotEligibility } from '../src/market/eligibility.js';
import {
  filterSnapshotForCapabilities,
  assertCapabilitiesHonored,
} from '../src/market/capabilities.js';
import { createMarketHub } from '../src/market/hub.js';
import {
  canonicalize,
  toReplayRecord,
  createReplayRecorder,
  loadReplayJsonl,
  assertReplayDeterministic,
  replaySnapshots,
} from '../src/market/replay.js';
import { bootstrapEngine } from '../src/composition/bootstrap.js';

function freshState(nowMs) {
  const state = createMarketState();
  state.btc = 100.5;
  state.priceToBeat = 100;
  state.wsRtdsConnected = true;
  state.wsClobConnected = true;
  state.rtdsReceivedAt = nowMs - 100;
  state.clobLastAt = nowMs - 100;
  state.up = {
    bestBid: 0.6,
    bestAsk: 0.62,
    bids: [{ price: 0.6, size: 10 }],
    asks: [{ price: 0.62, size: 10 }],
  };
  state.down = {
    bestBid: 0.38,
    bestAsk: 0.4,
    bids: [{ price: 0.38, size: 5 }],
    asks: [{ price: 0.4, size: 5 }],
  };
  return state;
}

function sampleEvent(nowMs) {
  return {
    title: 'BTC 5m',
    slug: 'btc-updown-5m-test',
    conditionId: 'cond-1',
    upTokenId: 'up-1',
    downTokenId: 'down-1',
    eventStart: new Date(nowMs - 60_000),
    eventEnd: new Date(nowMs + 120_000),
    acceptingOrders: true,
  };
}

describe('feed health', () => {
  it('marca stale acima dos limites', () => {
    const h = evaluateFeedHealth({
      rtdsConnected: true,
      clobConnected: true,
      rtdsLagMs: STALENESS.rtdsMaxLagMs + 1,
      clobLagMs: 100,
    });
    assert.equal(h.ok, false);
    assert.ok(h.reasons.includes('RTDS_STALE'));
  });

  it('ok com lags dentro do limite', () => {
    const h = evaluateFeedHealth({
      rtdsConnected: true,
      clobConnected: true,
      rtdsLagMs: 500,
      clobLagMs: 800,
    });
    assert.equal(h.ok, true);
  });
});

describe('eligibility', () => {
  it('rejeita feed stale — 0 elegível', () => {
    const nowMs = 1_700_000_000_000;
    const state = freshState(nowMs);
    state.rtdsReceivedAt = nowMs - 10_000;
    const snap = buildMarketSnapshot({ state, event: sampleEvent(nowMs), nowMs });
    const gate = evaluateSnapshotEligibility(snap, {
      expectedMarketId: 'btc-updown-5m-test',
      expectedUpTokenId: 'up-1',
      expectedDownTokenId: 'down-1',
    });
    assert.equal(gate.eligible, false);
    assert.ok(gate.reasons.includes('RTDS_STALE'));
  });

  it('rejeita market id divergente', () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    const gate = evaluateSnapshotEligibility(snap, {
      expectedMarketId: 'outro-mercado',
      expectedUpTokenId: 'up-1',
      expectedDownTokenId: 'down-1',
    });
    assert.equal(gate.eligible, false);
    assert.ok(gate.reasons.includes('MARKET_ID_MISMATCH'));
  });

  it('aceita snapshot saudável', () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    const gate = evaluateSnapshotEligibility(snap, {
      expectedMarketId: 'btc-updown-5m-test',
      expectedUpTokenId: 'up-1',
      expectedDownTokenId: 'down-1',
    });
    assert.equal(gate.eligible, true);
  });
});

describe('capabilities', () => {
  it('price-only não recebe book', () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    const filtered = filterSnapshotForCapabilities(snap, ['price']);
    assertCapabilitiesHonored(filtered, ['price']);
    assert.equal(filtered.btc, 100.5);
    assert.equal(filtered.book.up.bestAsk, null);
    assert.equal(filtered.book.up.bids.length, 0);
  });

  it('book capability preserva profundidade', () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    const filtered = filterSnapshotForCapabilities(snap, ['price', 'book']);
    assert.equal(filtered.book.up.bestAsk, 0.62);
    assert.ok(filtered.book.up.bids.length > 0);
  });
});

describe('hub + availability', () => {
  it('disponibilidade ≥99,5% com feeds saudáveis', () => {
    const nowMs = 1_700_000_000_000;
    let t = nowMs;
    const hub = createMarketHub({
      clock: () => t,
      resolveEvent: async () => sampleEvent(t),
      fetchPtb: async () => 100,
    });
    hub.setEvent(sampleEvent(t));
    Object.assign(hub.state, freshState(t));

    for (let i = 0; i < 1000; i++) {
      t = nowMs + i * 10;
      hub.state.rtdsReceivedAt = t - 50;
      hub.state.clobLastAt = t - 50;
      hub.capture({ minSecsLeft: 0 });
    }
    assert.ok(hub.stats.availability >= 0.995, `availability=${hub.stats.availability}`);
    assert.equal(hub.stats.eligible, 1000);
  });

  it('rotação limpa book e incrementa counter', () => {
    const hub = createMarketHub({
      resolveEvent: async () => null,
      fetchPtb: async () => null,
    });
    hub.setEvent(sampleEvent(1_700_000_000_000));
    hub.state.up.bestAsk = 0.7;
    const next = {
      ...sampleEvent(1_700_000_000_000),
      slug: 'btc-updown-5m-next',
      upTokenId: 'up-2',
      downTokenId: 'down-2',
    };
    const rot = hub.setEvent(next);
    assert.equal(rot.rotated, true);
    assert.equal(hub.stats.rotations, 1);
    assert.equal(hub.state.up.bestAsk, null);
  });
});

describe('replay determinístico', () => {
  it('roundtrip JSONL byte-equivalente (canonical)', () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    const recorder = createReplayRecorder();
    recorder.push(snap);
    recorder.push({ ...snap, nowMs: nowMs + 1000, btc: 101 });

    assertReplayDeterministic(recorder.records);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-robot-replay-'));
    const file = path.join(dir, 'stream.jsonl');
    recorder.writeJsonl(file);
    const loaded = loadReplayJsonl(file);
    const again = loaded.map((r) => canonicalize(toReplayRecord(r))).join('\n');
    const original = recorder.records.map((r) => canonicalize(r)).join('\n');
    assert.equal(again, original);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaySnapshots não precisa de strategy', async () => {
    const records = [
      toReplayRecord(
        buildMarketSnapshot({
          state: freshState(1),
          event: sampleEvent(1),
          nowMs: 1,
        }),
      ),
    ];
    let seen = 0;
    await replaySnapshots(records, async () => {
      seen += 1;
    });
    assert.equal(seen, 1);
  });
});

describe('engine + capability ingest', () => {
  it('price-cross opera sem book; spread-wide precisa do book', async () => {
    const nowMs = 1_700_000_000_000;
    const base = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    base.eligibility = { eligible: true, reasons: [] };

    const priceEngine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 50, budget: 1, maxPrice: 0.5 },
    });
    priceEngine.start();
    const priceResult = await priceEngine.ingestMarketSnapshot(base);
    assert.equal(priceResult.skipped, false);
    assert.equal(priceResult.filtered.book.up.bids.length, 0);
    assert.ok(priceEngine.position.qty > 0);

    const spreadEngine = bootstrapEngine({
      strategyId: 'fixture-spread-wide',
      mode: 'shadow',
      preset: { minSpread: 0.01, quantity: 4 },
    });
    spreadEngine.start();
    const spreadResult = await spreadEngine.ingestMarketSnapshot(base);
    assert.equal(spreadResult.skipped, false);
    assert.ok(spreadResult.filtered.book.up.bids.length > 0);
    assert.equal(spreadEngine.position.side, 'DOWN');
  });

  it('snapshot não elegível não chega na strategy', async () => {
    const nowMs = 1_700_000_000_000;
    const snap = buildMarketSnapshot({
      state: freshState(nowMs),
      event: sampleEvent(nowMs),
      nowMs,
    });
    snap.eligibility = { eligible: false, reasons: ['RTDS_STALE'] };

    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1 },
    });
    engine.start();
    const result = await engine.ingestMarketSnapshot(snap);
    assert.equal(result.skipped, true);
    assert.equal(engine.position.qty, 0);
  });
});
