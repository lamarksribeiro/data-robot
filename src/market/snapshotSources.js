/**
 * Fontes contínuas de MarketSnapshot para o processo long-lived.
 * Não conhecem strategy, risk, OMS ou modo de execução.
 */

import { createMarketState } from '../feeds/marketState.js';
import { startRtdsFeed } from '../feeds/rtdsFeed.js';
import { createClobFeed } from '../feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../markets/btc5m.js';
import { fetchPriceToBeat } from '../markets/priceToBeat.js';
import { buildMarketSnapshot } from './normalize.js';
import { createMarketHub } from './hub.js';

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHandlers(handlers) {
  if (typeof handlers === 'function') {
    return { onSnapshot: handlers, onStatus: () => {}, onError: () => {} };
  }
  if (!handlers || typeof handlers.onSnapshot !== 'function') {
    throw new Error('SnapshotSource.start exige onSnapshot');
  }
  return {
    onSnapshot: handlers.onSnapshot,
    onStatus: typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {},
    onError: typeof handlers.onError === 'function' ? handlers.onError : () => {},
  };
}

function createLoopController(opts) {
  const intervalMs = positiveMs(opts.intervalMs, 1000);
  let running = false;
  let timer = null;
  let inFlight = null;
  let pending = false;

  async function poll() {
    if (!running) return null;
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    pending = false;
    inFlight = Promise.resolve()
      .then(opts.tick)
      .finally(() => {
        inFlight = null;
        if (running && pending) {
          pending = false;
          queueMicrotask(() => {
            void poll();
          });
        }
      });
    return inFlight;
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await poll();
      } finally {
        schedule();
      }
    }, intervalMs);
    timer.unref?.();
  }

  return {
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      running = true;
      await poll();
      schedule();
    },
    async pollNow() {
      return poll();
    },
    async stop() {
      running = false;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}

/**
 * Fonte determinística para deploy/smoke/soak sem rede.
 * @param {object} [opts]
 */
export function createFixtureSnapshotSource(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const intervalMs = positiveMs(opts.intervalMs, 1000);
  const marketId = opts.marketId ?? 'fixture-btc-updown-5m';
  let handlers = null;
  let seq = 0;
  let status = {
    kind: 'fixture',
    running: false,
    ok: false,
    reason: 'NOT_STARTED',
    snapshots: 0,
    errors: 0,
    lastSnapshotAtMs: null,
  };

  function emitStatus(patch = {}) {
    status = { ...status, ...patch };
    handlers?.onStatus({ ...status });
  }

  function makeSnapshot() {
    const nowMs = clock();
    const btc = Number(opts.basePrice ?? 100) + (seq % 3);
    const state = createMarketState();
    state.btc = btc;
    state.priceToBeat = Number(opts.priceToBeat ?? 50);
    state.wsRtdsConnected = true;
    state.wsClobConnected = true;
    state.rtdsReceivedAt = nowMs;
    state.clobLastAt = nowMs;
    state.up = {
      bestBid: 0.49,
      bestAsk: 0.5,
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }],
    };
    state.down = {
      bestBid: 0.49,
      bestAsk: 0.5,
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }],
    };
    return buildMarketSnapshot({
      state,
      event: {
        title: 'Fixture BTC Up/Down 5m',
        slug: marketId,
        conditionId: 'fixture-condition',
        upTokenId: 'fixture-up',
        downTokenId: 'fixture-down',
        eventStart: new Date(nowMs - 60_000),
        eventEnd: new Date(nowMs + 60_000),
        acceptingOrders: true,
      },
      nowMs,
    });
  }

  const loop = createLoopController({
    intervalMs,
    tick: async () => {
      try {
        const snapshot = opts.makeSnapshot ? opts.makeSnapshot(seq, clock()) : makeSnapshot();
        seq += 1;
        const ingestion = await handlers.onSnapshot(snapshot);
        const eligible = ingestion?.skipped !== true;
        emitStatus({
          running: true,
          ok:
            eligible &&
            snapshot?.health?.ok !== false &&
            snapshot?.feeds?.healthy !== false,
          reason: eligible ? null : ingestion?.reasons?.[0] ?? 'NOT_ELIGIBLE',
          snapshots: status.snapshots + 1,
          lastSnapshotAtMs: snapshot?.nowMs ?? clock(),
        });
      } catch (error) {
        const message = errorMessage(error);
        emitStatus({
          running: true,
          ok: false,
          reason: 'SNAPSHOT_ERROR',
          errors: status.errors + 1,
          lastError: message,
        });
        handlers.onError(error);
      }
    },
  });

  return {
    kind: 'fixture',
    get status() {
      return { ...status };
    },
    async start(nextHandlers) {
      if (loop.running) return;
      handlers = normalizeHandlers(nextHandlers);
      emitStatus({ running: true, ok: false, reason: 'STARTING' });
      await loop.start();
    },
    pollNow: () => loop.pollNow(),
    async stop() {
      await loop.stop();
      emitStatus({ running: false, ok: false, reason: 'STOPPED' });
    },
  };
}

/**
 * Fonte BTC Up/Down 5m: descoberta/rotação + RTDS + CLOB market WS.
 * @param {object} [opts]
 */
export function createBtc5mSnapshotSource(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const intervalMs = positiveMs(opts.intervalMs, 1000);
  const syncIntervalMs = positiveMs(opts.syncIntervalMs, 15_000);
  const resolveEvent = opts.resolveEvent ?? findActiveBtc5mEvent;
  const fetchPtb = opts.fetchPtb ?? fetchPriceToBeat;
  const startRtds = opts.startRtds ?? startRtdsFeed;
  const makeClob = opts.createClob ?? createClobFeed;
  const state = opts.state ?? createMarketState();
  const hub = createMarketHub({
    state,
    clock,
    resolveEvent,
    fetchPtb,
    healthLimits: opts.healthLimits,
  });

  let handlers = null;
  let stopRtds = null;
  let clob = null;
  let subscribedMarketId = null;
  let nextSyncAtMs = 0;
  let status = {
    kind: 'btc5m',
    running: false,
    ok: false,
    reason: 'NOT_STARTED',
    marketId: null,
    snapshots: 0,
    eligibleSnapshots: 0,
    syncAttempts: 0,
    syncFailures: 0,
    errors: 0,
    rotations: 0,
    eligible: false,
    eligibilityReason: null,
    lastSnapshotAtMs: null,
    lastSyncAtMs: null,
  };

  function emitStatus(patch = {}) {
    status = { ...status, ...patch };
    handlers?.onStatus({ ...status });
  }

  async function syncMarket(nowMs) {
    emitStatus({ syncAttempts: status.syncAttempts + 1, lastSyncAtMs: nowMs });
    const synced = await hub.syncMarket(new Date(nowMs));
    nextSyncAtMs = nowMs + syncIntervalMs;
    if (!synced.ok) {
      subscribedMarketId = null;
      emitStatus({
        ok: false,
        reason: synced.reason ?? 'MARKET_SYNC_FAILED',
        eligible: false,
        eligibilityReason: synced.reason ?? 'MARKET_SYNC_FAILED',
        marketId: null,
        syncFailures: status.syncFailures + 1,
      });
      return synced;
    }

    const marketChanged = synced.marketId !== subscribedMarketId;
    if (marketChanged) {
      clob.subscribe(synced.event.upTokenId, synced.event.downTokenId);
      subscribedMarketId = synced.marketId;
    }
    if (marketChanged || status.ok !== true) {
      emitStatus({
        marketId: synced.marketId,
        rotations: hub.stats.rotations,
        reason: state.priceToBeat == null ? 'PRICE_TO_BEAT_UNAVAILABLE' : 'AWAITING_FEEDS',
        ok: false,
        eligible: false,
        eligibilityReason: 'AWAITING_FEEDS',
      });
    } else {
      emitStatus({
        marketId: synced.marketId,
        rotations: hub.stats.rotations,
      });
    }
    return synced;
  }

  function shouldSync(nowMs) {
    if (!hub.event || nowMs >= nextSyncAtMs) return true;
    const endMs = hub.event.eventEnd instanceof Date ? hub.event.eventEnd.getTime() : null;
    return endMs != null && nowMs >= endMs;
  }

  function requestSnapshot() {
    void loop.pollNow();
  }

  const loop = createLoopController({
    intervalMs,
    tick: async () => {
      const nowMs = clock();
      try {
        if (shouldSync(nowMs)) await syncMarket(nowMs);
        const captured = hub.capture({
          requireAcceptingOrders: true,
          minSecsLeft: opts.minSecsLeft ?? 5,
          serverNowMs: opts.serverNowMs?.() ?? null,
        });
        if (!captured.snapshot) {
          const reason = captured.reasons?.[0] ?? 'NO_SNAPSHOT';
          emitStatus({
            ok: false,
            reason,
            eligible: false,
            eligibilityReason: reason,
          });
          return;
        }

        await handlers.onSnapshot(captured.snapshot);
        const sourceOk =
          captured.snapshot.health?.ok === true &&
          Number.isFinite(Number(captured.snapshot.priceToBeat)) &&
          Boolean(captured.snapshot.identity?.upTokenId) &&
          Boolean(captured.snapshot.identity?.downTokenId);
        const sourceReason = sourceOk
          ? null
          : captured.snapshot.health?.reasons?.[0] ??
            captured.reasons?.[0] ??
            'SOURCE_NOT_READY';
        emitStatus({
          running: true,
          ok: sourceOk,
          reason: sourceReason,
          eligible: captured.eligible,
          eligibilityReason: captured.eligible
            ? null
            : captured.reasons?.[0] ?? 'NOT_ELIGIBLE',
          marketId: captured.snapshot.marketId,
          snapshots: status.snapshots + 1,
          eligibleSnapshots: status.eligibleSnapshots + (captured.eligible ? 1 : 0),
          rotations: hub.stats.rotations,
          lastSnapshotAtMs: captured.snapshot.nowMs,
          rejectReasons: hub.stats.rejectReasons,
        });
      } catch (error) {
        const message = errorMessage(error);
        nextSyncAtMs = Math.min(nextSyncAtMs, nowMs + positiveMs(opts.retryMs, 2000));
        emitStatus({
          running: true,
          ok: false,
          reason: 'SOURCE_ERROR',
          errors: status.errors + 1,
          lastError: message,
        });
        handlers.onError(error);
      }
    },
  });

  return {
    kind: 'btc5m',
    state,
    hub,
    get status() {
      return { ...status };
    },
    async start(nextHandlers) {
      if (loop.running) return;
      handlers = normalizeHandlers(nextHandlers);
      emitStatus({ running: true, ok: false, reason: 'STARTING' });
      stopRtds = startRtds(state, { onUpdate: requestSnapshot });
      clob = makeClob(state, { onUpdate: requestSnapshot });
      await loop.start();
    },
    pollNow: () => loop.pollNow(),
    async stop() {
      await loop.stop();
      stopRtds?.();
      clob?.stop?.();
      stopRtds = null;
      clob = null;
      subscribedMarketId = null;
      emitStatus({ running: false, ok: false, reason: 'STOPPED' });
    },
  };
}

export function createSnapshotSource(kind, opts = {}) {
  if (kind === 'fixture') return createFixtureSnapshotSource(opts);
  if (kind === 'btc5m') return createBtc5mSnapshotSource(opts);
  if (kind === 'manual' || kind == null) return null;
  throw new Error(`ENGINE_SNAPSHOT_SOURCE inválido: ${kind}`);
}
