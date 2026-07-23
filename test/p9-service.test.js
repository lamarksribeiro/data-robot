import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { createApprovalStore } from '../src/catalog/approvalStore.js';
import { bootstrapMidasCanaryEngine } from '../src/composition/midasCanary.js';
import { bootstrapEngine } from '../src/composition/bootstrap.js';
import { createEngineApp } from '../src/control/engineApp.js';
import { createLiveTransport, createMockClobClient } from '../src/executor/liveTransport.js';
import { createOmsSink } from '../src/oms/omsSink.js';
import { createRiskEngine } from '../src/risk/createRiskEngine.js';
import { RISK_REASON } from '../src/risk/reasons.js';
import { createUiServer } from '../src/ui/server.js';
import { canaryMidasPreset } from '../src/tfc/preset-midas.js';

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function passingChecks() {
  return {
    auth: () => ({ ok: true }),
    geoblock: () => ({ ok: true, blocked: false }),
    clock: () => ({ ok: true }),
    balance: () => ({ ok: true }),
  };
}

function wsChannel() {
  let connected = false;
  const events = new Set();
  const disconnects = new Set();
  return {
    kind: 'ws',
    get connected() { return connected; },
    get lastHeartbeatMs() { return connected ? Date.now() : null; },
    connect() { connected = true; return { ok: true }; },
    disconnect() { connected = false; },
    startHeartbeat() { return () => {}; },
    onEvent(fn) { events.add(fn); return () => events.delete(fn); },
    onDisconnect(fn) { disconnects.add(fn); return () => disconnects.delete(fn); },
  };
}

function fixtureSnapshot(marketId, btc = 100) {
  return {
    marketId,
    nowMs: Date.now(),
    secsLeft: 20,
    btc,
    priceToBeat: 50,
    book: {
      up: { bestBid: 0.49, bestAsk: 0.5, bids: [], asks: [] },
      down: { bestBid: 0.49, bestAsk: 0.5, bids: [], asks: [] },
    },
    feeds: { healthy: true },
    identity: { upTokenId: 'fixture-up', downTokenId: 'fixture-down' },
  };
}

function midasSnapshot(over = {}) {
  const nowMs = over.nowMs ?? Date.now();
  return {
    marketId: 'btc-updown-p9',
    nowMs,
    secsLeft: over.secsLeft ?? 18,
    btc: over.btc ?? 100.5,
    priceToBeat: 100,
    book:
      over.book ?? {
        up: {
          bestBid: 0.6,
          bestAsk: 0.62,
          bids: [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }],
          asks: [{ size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }, { size: 10 }],
        },
        down: {
          bestBid: 0.36,
          bestAsk: 0.4,
          bids: [{ size: 10 }],
          asks: [{ size: 10 }],
        },
      },
    feeds: { healthy: true, rtdsLagMs: 50, clobLagMs: 50 },
    acceptingOrders: true,
    identity: { upTokenId: 'tok-up', downTokenId: 'tok-down' },
  };
}

describe('catálogo de aprovação P9', () => {
  it('aprova MIDAS canário e bloqueia estratégia apenas registrada em live', () => {
    const store = createApprovalStore({ file: 'config/strategy-catalog.json' });
    const midas = store.assertApproved({
      strategyId: 'midas-carry-v1',
      version: '1.0.0',
      presetId: 'btc-micro-aggressive-v1',
      marketScope: 'btc-updown-5m',
      mode: 'live',
    });
    assert.equal(midas.approval, 'canary-approved');
    assert.throws(
      () =>
        store.assertApproved({
          strategyId: 'tfc-v7',
          version: '1.0.0',
          presetId: 'btc-champion-v7',
          marketScope: 'btc-updown-5m',
          mode: 'live',
        }),
      /aprovação insuficiente/,
    );
  });
});

describe('janela de controle persistente', () => {
  it('permite uma entrada, mantém o bloqueio após restore e libera ao expirar', () => {
    let now = 1_700_000_000_000;
    const make = () =>
      createRiskEngine({
        clock: () => now,
        maxEntriesPerControlWindow: 1,
        controlWindowMs: 60_000,
      });
    const intent = (marketId) => ({
      intentId: `i-${marketId}`,
      kind: 'ENTER',
      side: 'UP',
      marketId,
      strategyInstanceId: 'midas:primary',
      budget: 1,
      maxPrice: 0.5,
      reason: 'test',
    });
    const first = make();
    assert.equal(first.evaluate(intent('m1'), { mode: 'shadow' }).allow, true);
    first.recordAccepted(intent('m1'));
    assert.equal(
      first.evaluate(intent('m2'), { mode: 'shadow' }).reasonCode,
      RISK_REASON.CONTROL_WINDOW_LIMIT,
    );
    const restored = make();
    restored.restore(first.snapshot());
    assert.equal(
      restored.evaluate(intent('m2'), { mode: 'shadow' }).reasonCode,
      RISK_REASON.CONTROL_WINDOW_LIMIT,
    );
    now += 60_000;
    assert.equal(restored.evaluate(intent('m2'), { mode: 'shadow' }).allow, true);
  });

  it('bloqueia ENTER quando desarmada, persiste o estado e mantém EXIT liberado', () => {
    const risk = createRiskEngine({ entryEnabled: false });
    const enter = {
      intentId: 'operator-enter',
      kind: 'ENTER',
      side: 'UP',
      marketId: 'm1',
      strategyInstanceId: 'fixture:operator',
      budget: 1,
      maxPrice: 0.5,
      reason: 'test',
    };
    const exit = {
      ...enter,
      intentId: 'operator-exit',
      kind: 'EXIT',
      budget: null,
      quantity: 2,
      minPrice: 0.4,
      maxPrice: null,
    };
    assert.equal(
      risk.evaluate(enter, { mode: 'shadow' }).reasonCode,
      RISK_REASON.OPERATOR_DISARMED,
    );
    assert.equal(risk.evaluate(exit, { mode: 'shadow' }).allow, true);
    const restored = createRiskEngine();
    restored.restore(risk.snapshot());
    assert.equal(restored.entryEnabled, false);
  });
});

describe('isolamento de checkpoint', () => {
  it('recusa restore de outra estratégia, instância ou modo', () => {
    const source = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      strategyInstanceId: 'fixture:a',
      mode: 'shadow',
      preset: { threshold: 1 },
    });
    source.start();
    const checkpoint = source.checkpoint();
    const other = bootstrapEngine({
      strategyId: 'midas-carry-v1',
      strategyInstanceId: 'midas:a',
      mode: 'live',
      preset: canaryMidasPreset({ lateFlipReverseEnabled: false }),
      liveEnabled: true,
      riskOpts: { preflightChecks: passingChecks() },
      sink: { assertReady: () => true, submit: async () => ({ accepted: true, events: [] }) },
    });
    assert.throws(() => other.restore(checkpoint), /outra strategy/);
  });
});

describe('proteção de rotação com posição live', () => {
  it('faz settlement via Gamma e desarma quando o mercado fecha', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-engine-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sink = {
      userChannel: { connected: true, lastHeartbeatMs: Date.now() },
      start: async () => ({ ok: true }),
      assertReady: () => true,
      reconcileAll: async () => ({ ok: true, unresolved: [], orphans: [] }),
      submit: async (intent) => ({
        accepted: true,
        events: [{
          eventId: `fill-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'FILL',
          side: intent.side,
          qty: 2,
          price: 0.5,
          tsMs: Date.now(),
        }],
      }),
      cancelOpenOrders: async () => ({ canceled: [], failed: [] }),
      dispose: () => {},
    };
    const fetchFn = async () => ({
      ok: true,
      json: async () => [{
        closed: true,
        markets: [{
          closed: true,
          outcomes: '["Up","Down"]',
          outcomePrices: '["1","0"]',
        }],
      }],
    });
    const app = createEngineApp({
      mode: 'live',
      liveEnabled: true,
      strategyId: 'fixture-price-cross',
      strategyInstanceId: 'fixture:live',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      riskOpts: { preflightChecks: passingChecks() },
      sink,
      fetchFn,
      serveHttp: false,
      backupDir: path.join(dir, 'backup'),
      executionAuditDir: path.join(dir, 'audit'),
      startArmed: true,
    });
    cleanup.push(() => app.stop());
    await app.start();
    await app.ingestSynthetic(fixtureSnapshot('market-a'));
    assert.ok(app.engine.position.qty > 0);
    const result = await app.ingestSynthetic(fixtureSnapshot('market-b'));
    assert.notEqual(result?.reason, 'POSITION_REQUIRES_SETTLEMENT');
    assert.equal(app.engine.position.qty, 0);
    assert.notEqual(app.engine.state, 'HALTED');
    assert.equal(app.status().operatorState, 'DISARMED');
  });

  it('entra em HALTED se Gamma não resolve o mercado antigo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-engine-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sink = {
      userChannel: { connected: true, lastHeartbeatMs: Date.now() },
      start: async () => ({ ok: true }),
      assertReady: () => true,
      reconcileAll: async () => ({ ok: true, unresolved: [], orphans: [] }),
      submit: async (intent) => ({
        accepted: true,
        events: [{
          eventId: `fill-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'FILL',
          side: intent.side,
          qty: 2,
          price: 0.5,
          tsMs: Date.now(),
        }],
      }),
      cancelOpenOrders: async () => ({ canceled: [], failed: [] }),
      dispose: () => {},
    };
    const fetchFn = async () => ({
      ok: true,
      json: async () => [{
        closed: false,
        markets: [{ closed: false, outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]' }],
      }],
    });
    const app = createEngineApp({
      mode: 'live',
      liveEnabled: true,
      strategyId: 'fixture-price-cross',
      strategyInstanceId: 'fixture:live',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      riskOpts: { preflightChecks: passingChecks() },
      sink,
      fetchFn,
      serveHttp: false,
      backupDir: path.join(dir, 'backup'),
      executionAuditDir: path.join(dir, 'audit'),
      startArmed: true,
    });
    cleanup.push(() => app.stop());
    await app.start();
    await app.ingestSynthetic(fixtureSnapshot('market-a'));
    assert.ok(app.engine.position.qty > 0);
    const result = await app.ingestSynthetic(fixtureSnapshot('market-b'));
    assert.equal(result.reason, 'POSITION_REQUIRES_SETTLEMENT');
    assert.equal(app.engine.state, 'HALTED');
    assert.equal(app.engine.getStatus().haltReason, 'market-rotated-with-position');
  });
});

describe('ciclo operacional da instância', () => {
  it('inicia fail-closed, arma, pausa novas entradas e permite a saída', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-ops-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const orders = [];
    const sink = {
      start: async () => ({ ok: true }),
      reconcileAll: async () => ({ ok: true, unresolved: [], orphans: [] }),
      submit: async (intent) => {
        orders.push(intent);
        return {
          accepted: true,
          events: [{
            eventId: `fill-${intent.intentId}`,
            intentId: intent.intentId,
            type: 'FILL',
            side: intent.side,
            qty: intent.kind === 'EXIT' ? intent.quantity : 2,
            price: intent.kind === 'EXIT' ? intent.minPrice : 0.5,
            tsMs: Date.now(),
          }],
        };
      },
      cancelOpenEntries: async () => ({ canceled: [], failed: [] }),
      cancelOpenOrders: async () => ({ canceled: [], failed: [] }),
      dispose: () => {},
    };
    const app = createEngineApp({
      mode: 'shadow',
      strategyId: 'fixture-price-cross',
      strategyInstanceId: 'fixture:operator',
      preset: { threshold: 50, budget: 1, maxPrice: 0.5, minExitPrice: 0.4 },
      sink,
      startArmed: false,
      serveHttp: false,
      backupDir: path.join(dir, 'backup'),
      executionAuditDir: path.join(dir, 'audit'),
    });
    cleanup.push(() => app.stop());
    await app.start();
    await app.ingestSynthetic(fixtureSnapshot('market-a', 100));
    assert.equal(app.status().operatorState, 'DISARMED');
    assert.equal(app.engine.position.qty, 0);
    assert.equal(orders.length, 0);

    await app.arm();
    await app.ingestSynthetic(fixtureSnapshot('market-a', 100));
    assert.equal(app.status().operatorState, 'ARMED');
    assert.ok(app.engine.position.qty > 0);

    await app.flatten();
    assert.equal(app.status().operatorState, 'DISARMED');
    assert.equal(app.engine.position.qty, 0);
    assert.equal(orders.at(-1).orderType, 'FAK');

    await app.arm();
    await app.ingestSynthetic(fixtureSnapshot('market-b', 100));
    assert.ok(app.engine.position.qty > 0);
    await app.pause();
    assert.equal(app.status().operatorState, 'PAUSED');
    assert.equal(app.status().entryEnabled, false);
    await app.ingestSynthetic(fixtureSnapshot('market-b', 0));
    assert.equal(app.engine.position.qty, 0);
    assert.equal(orders.at(-1).kind, 'EXIT');
    assert.ok(app.executionAudit.listRecent(20).some((row) => row.action === 'pause'));

    await app.disarm();
    app.checkpoint();
    const rolledBack = await app.rollbackSafe();
    assert.equal(rolledBack.state === 'BOOT', false);
    assert.equal(app.status().operatorState, 'DISARMED');
  });
});

describe('P8 late-flip no pipeline live simulado', () => {
  it('ENTER reconciliado → late_flip_exit reconciliado → flat, com REVERSE bloqueado', async () => {
    const client = createMockClobClient({ behavior: 'matched' });
    const sink = createOmsSink({
      mode: 'live',
      transport: createLiveTransport({ client, Side, OrderType }),
      userChannel: wsChannel(),
    });
    const engine = bootstrapMidasCanaryEngine({
      mode: 'live',
      liveEnabled: true,
      sink,
      preset: canaryMidasPreset({ lateFlipReverseEnabled: false }),
      riskOpts: { preflightChecks: passingChecks() },
    });
    cleanup.push(async () => {
      await engine.safeShutdown('test-cleanup');
      sink.dispose();
    });
    await sink.start();
    engine.start();
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      await engine.ingestSnapshot(
        midasSnapshot({ nowMs: now - (5 - i) * 1000, secsLeft: 20, btc: 100.5 }),
      );
    }
    const enter = sink.oms.listOrders().find((order) => order.kind === 'ENTER');
    assert.ok(enter, 'esperava ENTER');
    await sink.reconcileOrder(enter.intentId);
    assert.ok(engine.position.qty > 0);

    await engine.ingestSnapshot(
      midasSnapshot({
        nowMs: now + 1000,
        secsLeft: 6,
        btc: 99.5,
        book: {
          up: { bestBid: 0.4, bestAsk: 0.42, bids: [{ size: 20 }], asks: [{ size: 10 }] },
          down: { bestBid: 0.56, bestAsk: 0.58, bids: [{ size: 20 }], asks: [{ size: 10 }] },
        },
      }),
    );
    const exit = sink.oms.listOrders().find((order) => order.kind === 'EXIT');
    assert.ok(
      exit,
      `esperava EXIT; diagnostics=${JSON.stringify(engine.diagnostics)} risk=${JSON.stringify(engine.journal.filter((row) => row.type === 'risk').slice(-2))}`,
    );
    assert.equal(exit.reason, 'late_flip_exit');
    assert.equal(sink.oms.listOrders().some((order) => order.kind === 'REVERSE'), false);
    await sink.reconcileOrder(exit.intentId);
    assert.equal(engine.position.qty, 0);
    assert.equal(engine.position.side, null);
  });
});

describe('dashboard autenticado', () => {
  it('nega acesso anônimo, autentica e faz proxy de status/kill', async () => {
    let killed = false;
    let armed = false;
    const engine = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/status') return res.end(JSON.stringify({ state: 'ARMED' }));
      if (req.url === '/control/arm' && req.headers['x-ops-token'] === 'ops-secret') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        return req.on('end', () => {
          armed = JSON.parse(body).confirm === 'ARM';
          res.end(JSON.stringify({ ok: true }));
        });
      }
      if (req.url === '/control/kill' && req.headers['x-ops-token'] === 'ops-secret') {
        killed = true;
        return res.end(JSON.stringify({ ok: true }));
      }
      res.statusCode = 404;
      return res.end('{}');
    });
    await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => engine.close(resolve)));
    const enginePort = engine.address().port;

    const ui = createUiServer({
      host: '127.0.0.1',
      port: 0,
      publicDir: 'public',
      engineBaseUrl: `http://127.0.0.1:${enginePort}`,
      engineOpsToken: 'ops-secret',
      dashboardUser: 'operator',
      dashboardPassword: 'strong-password',
      secureCookie: false,
    });
    await ui.start();
    cleanup.push(() => ui.stop());
    const base = `http://127.0.0.1:${ui.server.address().port}`;

    const pageResponse = await fetch(base);
    const csp = pageResponse.headers.get('content-security-policy');
    assert.match(csp, /style-src[^;]*'unsafe-inline'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    const page = await pageResponse.text();
    assert.match(page, /src="\/js\/mascot\.js(?:\?[^"]*)?"/);
    assert.match(page, /class="login-wrapper"/);
    assert.match(page, /class="sidebar"/);
    assert.match(page, /class="topbar"/);

    assert.equal((await fetch(`${base}/api/engine/status`)).status, 401);
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'strong-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const status = await fetch(`${base}/api/engine/status`, { headers: { cookie } });
    assert.equal((await status.json()).state, 'ARMED');
    const arm = await fetch(`${base}/api/engine/control/arm`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'ARM' }),
    });
    assert.equal(arm.status, 200);
    assert.equal(armed, true);
    const kill = await fetch(`${base}/api/engine/control/kill`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'HALT' }),
    });
    assert.equal(kill.status, 200);
    assert.equal(killed, true);
  });
});
