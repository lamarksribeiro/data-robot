import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import { createMetrics } from '../src/observability/metrics.js';
import { createLogger } from '../src/observability/logger.js';
import { createAlertHub } from '../src/observability/alerts.js';
import { evaluateSlos, DEFAULT_SLOS } from '../src/observability/slo.js';
import { createJournalBackup } from '../src/observability/journalBackup.js';
import { buildHealthReport } from '../src/control/health.js';
import { createEngineApp } from '../src/control/engineApp.js';
import { createControlServer } from '../src/control/httpServer.js';
import { runSoak } from '../src/control/soak.js';
import {
  createFaultTransport,
  createDisconnectableSink,
  runFaultInjectionSuite,
} from '../src/control/faultInjection.js';
import { createOmsSink } from '../src/oms/omsSink.js';
import { bootstrapEngine } from '../src/composition/bootstrap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function snapshot(over = {}) {
  return {
    marketId: 'p5-mkt',
    nowMs: Date.now(),
    secsLeft: over.secsLeft ?? 20,
    btc: over.btc ?? 100,
    priceToBeat: 50,
    book: {
      up: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
      down: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
    },
    feeds: { healthy: over.healthy ?? true },
  };
}

describe('observability', () => {
  it('métricas calculam p50/p95/p99', () => {
    const m = createMetrics();
    for (let i = 1; i <= 100; i++) m.observe('decision_ms', i);
    const snap = m.snapshot();
    assert.equal(snap.histograms.decision_ms.count, 100);
    assert.equal(snap.histograms.decision_ms.p50, 50);
    assert.ok(snap.histograms.decision_ms.p95 >= 95);
    assert.ok(snap.histograms.decision_ms.p99 >= 99);
  });

  it('logger redacta secrets', () => {
    const lines = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info('test', { apiSecret: 'shh', ok: true });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.apiSecret, '[REDACTED]');
    assert.equal(parsed.ok, true);
  });

  it('alertas disparam em HALTED', () => {
    const hub = createAlertHub();
    const fired = hub.evaluate({
      engineStatus: { state: 'HALTED', killActive: false },
      health: { feedsOk: true },
      metrics: { histograms: {} },
    });
    assert.ok(fired.some((a) => a.id === 'engine_halted'));
  });

  it('SLOs default', () => {
    const r = evaluateSlos(
      { histograms: { decision_ms: { p99: 10 }, ingest_ms: { p99: 20 } } },
      { availability: 1, orphanOrders: 0 },
      DEFAULT_SLOS,
    );
    assert.equal(r.ok, true);
  });

  it('journal backup roundtrip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-bak-'));
    const bak = createJournalBackup({ dir });
    const file = bak.save([{ seq: 1, type: 'x' }], 't');
    const loaded = bak.load(file);
    assert.equal(loaded[0].type, 'x');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('health probes', () => {
  it('distingue healthy/ready/armed/live/halted', () => {
    const h = buildHealthReport({
      engineStatus: { state: 'ARMED', mode: 'shadow', killActive: false },
      feedsOk: true,
      orphanOrders: 0,
    });
    assert.equal(h.ready, true);
    assert.equal(h.armed, true);
    assert.equal(h.live, false);
    assert.equal(h.halted, false);
  });
});

describe('control HTTP', () => {
  it('GET /health e /metrics', async () => {
    const server = createControlServer({
      host: '127.0.0.1',
      port: 0,
      getHealth: () => ({ ok: true, ready: true, state: 'ARMED' }),
      getStatus: () => ({ state: 'ARMED' }),
      getMetrics: () => ({ counters: { x: 1 } }),
      onKill: async () => ({ state: 'HALTED' }),
    });
    await new Promise((resolve, reject) => {
      server.server.listen(0, '127.0.0.1', resolve);
      server.server.once('error', reject);
    });
    const { port } = server.server.address();

    const health = await fetchJson(port, '/health');
    assert.equal(health.ok, true);
    const metrics = await fetchJson(port, '/metrics');
    assert.equal(metrics.counters.x, 1);

    await new Promise((resolve) => server.server.close(resolve));
  });

  it('POST /control/kill exige token quando configurado', async () => {
    const server = createControlServer({
      host: '127.0.0.1',
      port: 0,
      opsToken: 'secret',
      getHealth: () => ({ ok: true }),
      getStatus: () => ({}),
      getMetrics: () => ({}),
      onKill: async () => ({ ok: true }),
    });
    await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    const { port } = server.server.address();

    const denied = await fetchJson(port, '/control/kill', { method: 'POST' });
    assert.equal(denied.reason, 'UNAUTHORIZED');

    const ok = await fetchJson(port, '/control/kill', {
      method: 'POST',
      headers: { 'x-ops-token': 'secret' },
    });
    assert.equal(ok.ok, true);

    await new Promise((resolve) => server.server.close(resolve));
  });
});

describe('engine app + soak', () => {
  it('app shadow processa snapshots e checkpoint/rollback', async () => {
    const app = createEngineApp({
      mode: 'shadow',
      serveHttp: false,
      strategyId: 'fixture-price-cross',
    });
    await app.start();
    await app.ingestSynthetic(snapshot());
    assert.ok(app.engine.position.qty > 0);
    app.checkpoint();
    const qty = app.engine.position.qty;
    await app.ingestSynthetic(snapshot({ btc: 120 }));
    // already in position — may not increase; rollback restores checkpoint qty
    app.rollback();
    assert.equal(app.engine.position.qty, qty);
    await app.stop();
  });

  it('soak curto sem órfãs', async () => {
    const app = createEngineApp({ mode: 'shadow', serveHttp: false });
    await app.start();
    const report = await runSoak(app, {
      iterations: 50,
      makeSnapshot: (i) => snapshot({ btc: 100 + (i % 2) }),
    });
    assert.equal(report.orphans, 0);
    assert.equal(report.divergences, 0);
    await app.stop();
  });
});

describe('fault injection', () => {
  it('401/429/503 rejeitam sem órfã', async () => {
    for (const code of ['401', '429', '503']) {
      const sink = createOmsSink({
        mode: 'shadow',
        transport: createFaultTransport(code),
      });
      const engine = bootstrapEngine({
        strategyId: 'fixture-price-cross',
        mode: 'shadow',
        preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
        sink,
      });
      engine.start();
      await engine.ingestSnapshot(snapshot());
      assert.equal(engine.position.qty, 0);
      const unknowns = sink.oms.listOrders().filter((o) => o.state === 'UNKNOWN');
      assert.equal(unknowns.length, 0);
      const rejected = sink.oms.listOrders().filter((o) => o.state === 'REJECTED');
      assert.ok(rejected.length >= 1);
      sink.dispose();
    }
  });

  it('perda do user WS dispara cancel-on-disconnect', async () => {
    const sink = createDisconnectableSink({ behavior: 'ack-only' });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      sink,
    });
    engine.start();
    await engine.ingestSnapshot(snapshot());
    assert.equal(sink.oms.openOrders().length, 1);
    sink.simulateUserWsLoss();
    assert.equal(sink.oms.openOrders().length, 0);
    sink.dispose();
  });

  it('suite restart/kill sem órfãs', async () => {
    const app = createEngineApp({ mode: 'shadow', serveHttp: false });
    await app.start();
    const report = await runFaultInjectionSuite(app, (o) => snapshot(o));
    assert.equal(report.orphanOrders, 0);
    // kill case leaves halted — ok flag from cases
    assert.ok(report.cases.find((c) => c.id === 'kill_switch')?.ok);
    await app.stop();
  });
});

function fetchJson(port, pathName, init = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
