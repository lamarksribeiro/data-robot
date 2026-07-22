import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Side, OrderType } from '@polymarket/clob-client-v2';
import { bootstrapTfcCanaryEngine } from '../src/composition/tfcCanary.js';
import {
  createLiveTransport,
  createMockClobClient,
} from '../src/executor/liveTransport.js';
import { createOmsSink } from '../src/oms/omsSink.js';
import { buildMicroLiveReport, compareIntentParity } from '../src/oms/microLiveReport.js';
import { createRiskEngine } from '../src/risk/createRiskEngine.js';
import { RISK_REASON } from '../src/risk/reasons.js';
import { CANARY_LIMITS, TFC_V7, canaryPreset } from '../src/tfc/preset-v7.js';
import { createTfcV7Strategy } from '../src/strategy/tfcV7.js';
import { buildStrategyContext } from '../src/engine/contract.js';
import { emptyPosition } from '../src/engine/schemas.js';
import { hasLiveFlag } from '../src/cli/liveGate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mockWsChannel() {
  let connected = false;
  const eventListeners = new Set();
  const disconnectListeners = new Set();
  return {
    kind: 'ws',
    get connected() {
      return connected;
    },
    get lastHeartbeatMs() {
      return connected ? Date.now() : null;
    },
    connect() {
      connected = true;
      return { ok: true };
    },
    disconnect() {
      connected = false;
    },
    startHeartbeat() {
      return () => {};
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onDisconnect(fn) {
      disconnectListeners.add(fn);
      return () => disconnectListeners.delete(fn);
    },
    simulateDisconnect(detail = { code: 1006 }) {
      connected = false;
      for (const listener of disconnectListeners) listener(detail);
    },
  };
}

function passingPreflightChecks() {
  return {
    auth: () => ({ ok: true }),
    geoblock: () => ({ ok: true, blocked: false }),
    clock: () => ({ ok: true }),
    balance: () => ({ ok: true }),
  };
}

function bookOk() {
  return {
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
  };
}

function snap(partial = {}) {
  const nowMs = partial.nowMs ?? 1_700_000_000_000;
  return {
    marketId: partial.marketId ?? 'btc-5m-p7',
    nowMs,
    secsLeft: partial.secsLeft ?? 18,
    btc: partial.btc ?? 100.5,
    priceToBeat: partial.priceToBeat ?? 100,
    book: partial.book ?? bookOk(),
    feeds: partial.feeds ?? { healthy: true, rtdsLagMs: 50, clobLagMs: 50 },
    acceptingOrders: true,
    identity: {
      upTokenId: 'tok-up',
      downTokenId: 'tok-down',
      ...(partial.identity ?? {}),
    },
  };
}

describe('canary risk P7', () => {
  it('bloqueia notional de $10 do campeão', () => {
    const risk = createRiskEngine({
      canaryMode: true,
      maxCanaryBudget: CANARY_LIMITS.maxCanaryBudget,
      maxNotionalPerOrder: 50,
      liveEnabled: true,
    });
    const decision = risk.evaluate(
      {
        intentId: 'i1',
        kind: 'ENTER',
        side: 'UP',
        marketId: 'm',
        strategyInstanceId: 's',
        budget: 10,
        reason: 'test',
      },
      { mode: 'live' },
    );
    assert.equal(decision.allow, false);
    assert.equal(decision.reasonCode, RISK_REASON.CANARY_BUDGET_EXCEEDED);
  });

  it('permite 1 share micro (notional < cap)', () => {
    const risk = createRiskEngine({
      canaryMode: true,
      maxCanaryBudget: CANARY_LIMITS.maxCanaryBudget,
      liveEnabled: true,
    });
    const decision = risk.evaluate(
      {
        intentId: 'i2',
        kind: 'ENTER',
        side: 'UP',
        marketId: 'm',
        strategyInstanceId: 's',
        budget: 0.64,
        quantity: 1,
        maxPrice: 0.64,
        reason: 'test',
      },
      { mode: 'live' },
    );
    assert.equal(decision.allow, true);
  });
});

describe('live transport mock', () => {
  it('matched → ACK no POST e FILL somente após reconcile', async () => {
    const client = createMockClobClient({ behavior: 'matched' });
    const transport = createLiveTransport({ client, Side, OrderType });
    const result = await transport.submit(
      {
        tokenId: 'tok-up',
        tokenSide: 'UP',
        tradeSide: 'BUY',
        price: 0.62,
        size: 1,
        orderType: 'FAK',
      },
      { intentId: 'x', tokenSide: 'UP' },
    );
    assert.equal(result.accepted, true);
    assert.ok(result.events.some((e) => e.type === 'ACK'));
    assert.equal(result.events.some((e) => e.type === 'FILL'), false);
    const reconciled = await transport.reconcile({
      intentId: 'x',
      tokenSide: 'UP',
      exchangeOrderId: result.exchangeOrderId,
      qty: 1,
      qtyFilled: 0,
      price: 0.62,
    });
    assert.ok(reconciled.events.some((e) => e.type === 'FILL'));
  });

  it('reject sem tokenId', async () => {
    const client = createMockClobClient();
    const transport = createLiveTransport({ client, Side, OrderType });
    const result = await transport.submit(
      { price: 0.5, size: 1, tradeSide: 'BUY', orderType: 'GTC' },
      { intentId: 'y' },
    );
    assert.equal(result.accepted, false);
    assert.equal(result.events[0].reason, 'NO_TOKEN_ID');
  });

  it('heartbeat recupera Invalid Heartbeat ID com reset', async () => {
    const seq = [];
    let n = 0;
    const client = {
      async postHeartbeat(id = '') {
        n += 1;
        seq.push(id);
        if (n === 1) throw new Error('Invalid Heartbeat ID');
        return { heartbeat_id: 'after-reset' };
      },
    };
    const transport = createLiveTransport({ client, Side, OrderType });
    const stop = await transport.startHeartbeat(() => assert.fail('onFailure'), 60_000);
    assert.deepEqual(seq, ['', '']);
    stop();
  });

  it('cancelOpenOrders no sink live mock', async () => {
    const client = createMockClobClient({ behavior: 'live' });
    const transport = createLiveTransport({ client, Side, OrderType });
    const sink = createOmsSink({ mode: 'live', transport, userChannel: mockWsChannel() });
    await sink.start();
    await sink.submit({
      intentId: 'c1',
      kind: 'ENTER',
      side: 'UP',
      marketId: 'm',
      strategyInstanceId: 's',
      budget: 0.62,
      quantity: 1,
      maxPrice: 0.62,
      reason: 'test',
      tokenId: 'tok-up',
      orderType: 'GTC',
    });
    assert.equal(sink.oms.openOrders().length, 1);
    const r = await sink.cancelOpenOrders('test');
    assert.ok(r.canceled.length >= 1);
  });

  it('recovery detecta ordem remota sem intent local', async () => {
    const client = createMockClobClient({ behavior: 'live' });
    await client.createAndPostOrder({
      tokenID: 'tok-up',
      side: Side.BUY,
      size: 1,
      price: 0.62,
    });
    const transport = createLiveTransport({ client, Side, OrderType });
    const sink = createOmsSink({ mode: 'live', transport, userChannel: mockWsChannel() });
    await sink.start();
    const report = await sink.reconcileAll();
    assert.equal(report.ok, false);
    assert.equal(report.orphans.length, 1);
    await transport.cancelAll();
    sink.dispose();
  });

  it('perda do user WS leva a engine live para HALTED', async () => {
    const client = createMockClobClient({ behavior: 'matched' });
    const channel = mockWsChannel();
    const sink = createOmsSink({
      mode: 'live',
      transport: createLiveTransport({ client, Side, OrderType }),
      userChannel: channel,
    });
    const engine = bootstrapTfcCanaryEngine({
      mode: 'live',
      liveEnabled: true,
      sink,
      riskOpts: { preflightChecks: passingPreflightChecks() },
    });
    await sink.start();
    engine.start();
    channel.simulateDisconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(engine.state, 'HALTED');
    sink.dispose();
  });
});

describe('bootstrap TFC canary', () => {
  it('dry-run processa ENTER com notional ≤ cap e tokenId', async () => {
    const engine = bootstrapTfcCanaryEngine({ mode: 'dry-run' });
    engine.start();
    const nowMs = Date.now();
    for (let i = 0; i < 5; i++) {
      await engine.ingestSnapshot(
        snap({
          nowMs: nowMs - (4 - i) * 1000,
          secsLeft: 20,
          btc: 100.4,
        }),
      );
    }
    await engine.ingestSnapshot(snap({ nowMs, secsLeft: 16, btc: 100.5 }));
    const sinkEntry = [...engine.journal].reverse().find((j) => j.type === 'sink');
    assert.ok(sinkEntry, 'esperava sink ENTER');
    assert.equal(sinkEntry.intent.kind, 'ENTER');
    assert.ok(sinkEntry.intent.budget <= CANARY_LIMITS.maxCanaryBudget);
    assert.equal(sinkEntry.intent.tokenId, 'tok-up');
    engine.halt('done');
  });

  it('live + mock CLOB preenche posição sem rede', async () => {
    const client = createMockClobClient({ behavior: 'matched' });
    const transport = createLiveTransport({ client, Side, OrderType });
    const sink = createOmsSink({ mode: 'live', transport, userChannel: mockWsChannel() });
    const engine = bootstrapTfcCanaryEngine({
      mode: 'live',
      liveEnabled: true,
      sink,
      riskOpts: { preflightChecks: passingPreflightChecks() },
    });
    await sink.start();
    engine.start();
    const nowMs = Date.now();
    for (let i = 0; i < 5; i++) {
      await engine.ingestSnapshot(
        snap({ nowMs: nowMs - (4 - i) * 1000, secsLeft: 22, btc: 100.3 }),
      );
    }
    await engine.ingestSnapshot(snap({ nowMs, secsLeft: 15, btc: 100.6 }));
    const sinkEntry = [...engine.journal].reverse().find((j) => j.type === 'sink');
    await sink.reconcileOrder(sinkEntry.intentId);
    const status = engine.getStatus();
    assert.ok(status.position.qty > 0, 'posição deveria abrir no fill mock');
    assert.equal(status.position.side, 'UP');

    const report = buildMicroLiveReport({
      intent: sinkEntry.intent,
      events: engine.journal
        .filter((row) => row.type === 'execution' && row.event?.intentId === sinkEntry.intentId)
        .map((row) => row.event),
      position: status.position,
      askAtSignal: 0.62,
    });
    assert.equal(report.filled, true);
    assert.equal(report.orphan, false);
    engine.halt('done');
  });

  it('live sem liveEnabled falha no bootstrap', () => {
    assert.throws(
      () =>
        bootstrapTfcCanaryEngine({
          mode: 'live',
          liveEnabled: false,
        }),
      /liveEnabled/,
    );
  });
});

describe('micro-live report + parity', () => {
  it('marca órfã quando só ACK', () => {
    const report = buildMicroLiveReport({
      intent: { intentId: 'a', kind: 'ENTER', side: 'UP', budget: 0.1, reason: 'entry_gates' },
      events: [{ type: 'ACK', qty: 0, tsMs: 1 }],
    });
    assert.equal(report.orphan, true);
    assert.equal(report.reconciled, false);
  });

  it('paridade de intenção ENTER', () => {
    const strategy = createTfcV7Strategy();
    const preset = canaryPreset();
    const snapshot = snap();
    const ctx = buildStrategyContext({
      snapshot,
      position: emptyPosition({ marketId: snapshot.marketId }),
      mode: 'shadow',
      clockMs: snapshot.nowMs,
      preset,
      strategyInstanceId: 'p',
    });
    const state = {
      ...strategy.initialize(ctx, preset).state,
      history: [
        { ts: snapshot.nowMs - 5000, btc: 100.5 },
        { ts: snapshot.nowMs, btc: 100.5 },
      ],
    };
    const out = strategy.onSnapshot(ctx, state);
    const intent = out.intents[0];
    assert.equal(intent.kind, 'ENTER');
    assert.equal(intent.quantity, 1);
    assert.deepEqual(compareIntentParity(intent, { ...intent }), { ok: true, mismatches: [] });
  });

  it('canaryPreset sobrescreve entryBudget do campeão', () => {
    assert.equal(TFC_V7.entryBudget, 10);
    assert.equal(canaryPreset().entryBudget, 0.1);
    assert.ok(CANARY_LIMITS.maxCanaryBudget < TFC_V7.entryBudget);
  });

  it('package expõe tfc:micro-live e hasLiveFlag', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['tfc:micro-live']);
    assert.equal(hasLiveFlag(['node', 'x']), false);
    assert.equal(hasLiveFlag(['node', 'x', '--live']), true);
  });
});
