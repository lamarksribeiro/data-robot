import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEngineApp } from '../src/control/engineApp.js';
import {
  createBtc5mSnapshotSource,
  createFixtureSnapshotSource,
} from '../src/market/snapshotSources.js';

function eventAt(nowMs, suffix = '1') {
  return {
    title: `BTC 5m ${suffix}`,
    slug: `btc-updown-5m-${suffix}`,
    conditionId: `condition-${suffix}`,
    upTokenId: `up-${suffix}`,
    downTokenId: `down-${suffix}`,
    eventStart: new Date(nowMs - 60_000),
    eventEnd: new Date(nowMs + 20_000),
    acceptingOrders: true,
  };
}

function healthySnapshot(nowMs, overrides = {}) {
  return {
    marketId: 'fixture-source-test',
    nowMs,
    secsLeft: 20,
    btc: 100,
    priceToBeat: 99,
    book: {
      up: { bestBid: 0.49, bestAsk: 0.5, bids: [], asks: [] },
      down: { bestBid: 0.49, bestAsk: 0.5, bids: [], asks: [] },
    },
    feeds: {
      healthy: true,
      rtdsConnected: true,
      clobConnected: true,
      rtdsLagMs: 0,
      clobLagMs: 0,
    },
    health: { ok: true, reasons: [] },
    acceptingOrders: true,
    identity: {
      slug: 'fixture-source-test',
      conditionId: 'fixture-condition',
      upTokenId: 'fixture-up',
      downTokenId: 'fixture-down',
    },
    ...overrides,
  };
}

describe('snapshot source + engine app', () => {
  it('fixture alimenta a engine e torna readiness verdadeira', async () => {
    const source = createFixtureSnapshotSource({ intervalMs: 60_000 });
    const app = createEngineApp({
      mode: 'shadow',
      serveHttp: false,
      snapshotSource: source,
    });

    await app.start();
    const health = app.health();
    assert.equal(health.ready, true);
    assert.equal(health.feedsOk, true);
    assert.equal(health.snapshotSource.kind, 'fixture');
    assert.equal(health.snapshotSource.snapshots, 1);
    assert.equal(app.metricsSnap().counters.snapshots_total, 1);

    await app.stop();
    assert.equal(source.status.running, false);
    assert.equal(source.status.reason, 'STOPPED');
  });

  it('snapshot inelegível mantém readiness fail-closed', async () => {
    const source = createFixtureSnapshotSource({
      intervalMs: 60_000,
      makeSnapshot: (_seq, nowMs) => healthySnapshot(nowMs, { priceToBeat: null }),
    });
    const app = createEngineApp({
      mode: 'shadow',
      serveHttp: false,
      snapshotSource: source,
    });

    await app.start();
    const health = app.health();
    assert.equal(health.ready, false);
    assert.equal(health.snapshotSource.ok, false);
    assert.equal(health.snapshotSource.reason, 'NO_PRICE_TO_BEAT');
    assert.equal(app.metricsSnap().counters.snapshots_skipped, 1);
    await app.stop();
  });

  it('falha ao iniciar source encerra a engine sem ficar armada', async () => {
    let stopped = false;
    const source = {
      kind: 'broken',
      async start() {
        throw new Error('source unavailable');
      },
      async stop() {
        stopped = true;
      },
    };
    const app = createEngineApp({ mode: 'shadow', serveHttp: false, snapshotSource: source });

    await assert.rejects(() => app.start(), /source unavailable/);
    assert.equal(stopped, true);
    assert.equal(app.status().state, 'HALTED');
  });
});

describe('btc5m snapshot source', () => {
  it('sincroniza feeds e rotaciona tokens/evento', async () => {
    let nowMs = 1_800_000_000_000;
    let currentEvent = eventAt(nowMs, '1');
    const subscriptions = [];
    let rtdsStopped = false;
    let clobStopped = false;

    const source = createBtc5mSnapshotSource({
      clock: () => nowMs,
      intervalMs: 60_000,
      syncIntervalMs: 1,
      resolveEvent: async () => currentEvent,
      fetchPtb: async () => 100,
      startRtds: (state) => {
        state.btc = 101;
        state.wsRtdsConnected = true;
        state.rtdsReceivedAt = nowMs;
        return () => {
          rtdsStopped = true;
          state.wsRtdsConnected = false;
        };
      },
      createClob: (state) => ({
        subscribe(upTokenId, downTokenId) {
          subscriptions.push([upTokenId, downTokenId]);
          state.upTokenId = upTokenId;
          state.downTokenId = downTokenId;
          state.wsClobConnected = true;
          state.clobLastAt = nowMs;
          state.up = { bestBid: 0.5, bestAsk: 0.51, bids: [], asks: [] };
          state.down = { bestBid: 0.48, bestAsk: 0.49, bids: [], asks: [] };
        },
        stop() {
          clobStopped = true;
          state.wsClobConnected = false;
        },
      }),
    });

    const snapshots = [];
    await source.start({ onSnapshot: async (snapshot) => snapshots.push(snapshot) });
    assert.equal(source.status.ok, true);
    assert.deepEqual(subscriptions, [['up-1', 'down-1']]);
    assert.equal(snapshots[0].marketId, 'btc-updown-5m-1');

    nowMs += 30_000;
    source.state.rtdsReceivedAt = nowMs;
    currentEvent = eventAt(nowMs, '2');
    await source.pollNow();
    assert.equal(source.status.ok, true);
    assert.equal(source.status.rotations, 1);
    assert.deepEqual(subscriptions[1], ['up-2', 'down-2']);
    assert.equal(snapshots.at(-1).marketId, 'btc-updown-5m-2');

    await source.stop();
    assert.equal(rtdsStopped, true);
    assert.equal(clobStopped, true);
  });

  it('mantém fail-closed sem evento e recupera no retry', async () => {
    let nowMs = 1_800_000_000_000;
    let currentEvent = null;
    const source = createBtc5mSnapshotSource({
      clock: () => nowMs,
      intervalMs: 60_000,
      syncIntervalMs: 1,
      resolveEvent: async () => currentEvent,
      fetchPtb: async () => 100,
      startRtds: (state) => {
        state.btc = 101;
        state.wsRtdsConnected = true;
        state.rtdsReceivedAt = nowMs;
        return () => {};
      },
      createClob: (state) => ({
        subscribe(upTokenId, downTokenId) {
          state.upTokenId = upTokenId;
          state.downTokenId = downTokenId;
          state.wsClobConnected = true;
          state.clobLastAt = nowMs;
          state.up = { bestBid: 0.5, bestAsk: 0.51, bids: [], asks: [] };
          state.down = { bestBid: 0.48, bestAsk: 0.49, bids: [], asks: [] };
        },
        stop() {},
      }),
    });

    const snapshots = [];
    await source.start({ onSnapshot: async (snapshot) => snapshots.push(snapshot) });
    assert.equal(source.status.ok, false);
    assert.equal(source.status.reason, 'NO_EVENT');

    nowMs += 10;
    currentEvent = eventAt(nowMs, 'retry');
    await source.pollNow();
    assert.equal(source.status.ok, true);
    assert.equal(snapshots.length, 1);
    await source.stop();
  });
});
