import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapEngine, createAccountRiskBook, createRiskEngine } from '../src/composition/bootstrap.js';
import { createPreflight } from '../src/risk/preflight.js';
import { RISK_REASON } from '../src/risk/reasons.js';
import { createOmsSink } from '../src/oms/omsSink.js';
import { createSimTransport } from '../src/executor/transport.js';
import { runLivePreflight } from '../src/risk/livePreflight.js';

function snap(over = {}) {
  return {
    marketId: 'm-risk',
    nowMs: Date.now(),
    secsLeft: over.secsLeft ?? 20,
    btc: over.btc ?? 100,
    priceToBeat: 50,
    book: {
      up: { bestBid: 0.4, bestAsk: 0.5, bids: [{ size: 1 }], asks: [{ size: 1 }] },
      down: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
    },
    feeds: { healthy: over.healthy ?? true },
    eligibility: over.eligibility,
  };
}

describe('preflight fail-closed', () => {
  it('bloqueia live sem liveEnabled', () => {
    const risk = createRiskEngine({ liveEnabled: false });
    const pf = risk.runPreflight({ mode: 'live' });
    assert.equal(pf.ok, false);
    assert.ok(pf.failures.some((f) => f.reasonCode === RISK_REASON.LIVE_DISABLED));
  });

  it('bloqueia liveEnabled quando checks obrigatórios não foram configurados', () => {
    const risk = createRiskEngine({ liveEnabled: true });
    const pf = risk.runPreflight({ mode: 'live' });
    assert.equal(pf.ok, false);
    for (const check of ['auth', 'geoblock', 'clock', 'balance']) {
      assert.ok(pf.failures.some((failure) => failure.check === check));
    }
  });

  it('preflight real agrega auth, clock, balance/allowance e geoblock', async () => {
    const nowMs = 1_700_000_000_000;
    const client = {
      getOpenOrders: async () => [],
      getServerTime: async () => nowMs / 1000,
      getBalanceAllowance: async () => ({
        balance: '2000000',
        allowances: { exchange: '2000000' },
      }),
    };
    const result = await runLivePreflight({
      client,
      clock: () => nowMs,
      signerAddress: `0x${'1'.repeat(40)}`,
      funderAddress: `0x${'2'.repeat(40)}`,
      signatureType: 1,
      minBalanceUsd: 1,
      fetchFn: async (url) => {
        if (String(url).includes('/value')) {
          return { ok: true, json: async () => [{ value: 0.75 }] };
        }
        return { ok: true, json: async () => ({ blocked: false, country: 'BR' }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.checks.balance.cashUsd, 2);
    assert.equal(result.checks.balance.positionsValueUsd, 0.75);
    assert.equal(result.checks.balance.portfolioUsd, 2.75);
    assert.equal(result.checks.balance.balanceUsd, 2.75);
  });

  it('geoblock injetado falha no start', () => {
    const risk = createRiskEngine({
      preflight: createPreflight({
        checks: {
          geoblock: () => ({ ok: false, blocked: true }),
        },
      }),
    });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1 },
      risk,
    });
    assert.throws(() => engine.start(), /preflight fail-closed/);
  });

  it('auth/clock/balance ok passam', () => {
    const risk = createRiskEngine({
      preflight: createPreflight({
        liveEnabled: false,
        checks: {
          auth: () => ({ ok: true }),
          clock: () => ({ ok: true, skewMs: 10 }),
          balance: () => ({ ok: true, balance: 100 }),
          geoblock: () => ({ ok: true, blocked: false }),
        },
      }),
    });
    assert.equal(risk.runPreflight({ mode: 'shadow' }).ok, true);
  });
});

describe('risk limits + audit', () => {
  it('bloqueia deadline expirado e reverse live sem allowLiveReverse', () => {
    const nowMs = 1000;
    const risk = createRiskEngine({ liveEnabled: true, clock: () => nowMs });
    const base = {
      intentId: 'deadline',
      kind: 'ENTER',
      side: 'UP',
      marketId: 'm',
      strategyInstanceId: 's',
      budget: 1,
      maxPrice: 0.5,
      deadlineMs: nowMs,
      reason: 'test',
    };
    assert.equal(risk.evaluate(base, { mode: 'live' }).reasonCode, RISK_REASON.DEADLINE_EXPIRED);
    assert.equal(
      risk.evaluate({ ...base, intentId: 'reverse', kind: 'REVERSE', deadlineMs: nowMs + 1 }, { mode: 'live' })
        .reasonCode,
      RISK_REASON.LIVE_REVERSE_UNSUPPORTED,
    );
  });

  it('permite reverse live quando allowLiveReverse=true', () => {
    const nowMs = 1000;
    const risk = createRiskEngine({
      liveEnabled: true,
      allowLiveReverse: true,
      clock: () => nowMs,
      maxNotionalPerOrder: 5,
      maxNotionalPerEvent: 5,
    });
    const decision = risk.evaluate(
      {
        intentId: 'reverse-ok',
        kind: 'REVERSE',
        side: 'DOWN',
        marketId: 'm',
        strategyInstanceId: 's',
        budget: 2,
        maxPrice: 0.5,
        deadlineMs: nowMs + 1000,
        reason: 'late_flip_reverse',
      },
      {
        mode: 'live',
        health: { ok: true },
        position: { side: 'UP', qty: 2, avgPrice: 0.6, realizedPnl: 0 },
        openIntents: [],
        snapshot: { secsLeft: 6, feeds: { healthy: true } },
      },
    );
    assert.equal(decision.allow, true);
  });

  it('paridade GLS: BELOW_MIN_SECS_LEFT bloqueia ENTER mas não REVERSE/EXIT', () => {
    const nowMs = 1000;
    const risk = createRiskEngine({
      liveEnabled: true,
      allowLiveReverse: true,
      tacticalFloorSec: 4,
      clock: () => nowMs,
      maxNotionalPerOrder: 5,
      maxNotionalPerEvent: 5,
    });
    const eligibility = {
      eligible: true,
      reasons: [],
      entryReasons: ['BELOW_MIN_SECS_LEFT'],
      entryEligible: false,
    };
    const ctx = {
      mode: 'live',
      health: { ok: true },
      position: { side: 'DOWN', qty: 3, avgPrice: 0.53, realizedPnl: 0 },
      openIntents: [],
      snapshot: { secsLeft: 4.5, feeds: { healthy: true } },
      eligibility,
    };
    const enter = risk.evaluate(
      {
        intentId: 'enter-blocked',
        kind: 'ENTER',
        side: 'UP',
        marketId: 'm',
        strategyInstanceId: 's',
        budget: 2,
        maxPrice: 0.6,
        deadlineMs: nowMs + 1000,
        reason: 'midas_core_entry',
      },
      ctx,
    );
    assert.equal(enter.allow, false);
    assert.equal(enter.reasonCode, RISK_REASON.PREFLIGHT_ELIGIBILITY);

    const reverse = risk.evaluate(
      {
        intentId: 'reverse-ok-late',
        kind: 'REVERSE',
        side: 'UP',
        marketId: 'm',
        strategyInstanceId: 's',
        budget: 2,
        maxPrice: 0.83,
        deadlineMs: nowMs + 1000,
        reason: 'late_flip_reverse',
      },
      ctx,
    );
    assert.equal(reverse.allow, true);

    const exit = risk.evaluate(
      {
        intentId: 'exit-ok-late',
        kind: 'EXIT',
        side: 'DOWN',
        marketId: 'm',
        strategyInstanceId: 's',
        quantity: 3,
        minPrice: 0.1,
        deadlineMs: nowMs + 1000,
        reason: 'late_flip_exit',
      },
      ctx,
    );
    assert.equal(exit.allow, true);
  });

  it('bloqueia notional acima do limite com reason code', async () => {
    const risk = createRiskEngine({ maxNotionalPerOrder: 1 });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 5, maxPrice: 0.5 },
      risk,
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    assert.equal(engine.position.qty, 0);
    assert.ok(risk.audit.metrics()[RISK_REASON.MAX_NOTIONAL_ORDER] >= 1);
    const denied = engine.journal.filter((j) => j.type === 'risk' && j.decision?.allow === false);
    assert.ok(denied.length >= 1);
    assert.equal(denied[0].decision.reasonCode, RISK_REASON.MAX_NOTIONAL_ORDER);
  });

  it('bloqueia ação tática abaixo de 4s (exceto cancel implícito)', async () => {
    const risk = createRiskEngine({ tacticalFloorSec: 4 });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      risk,
    });
    engine.start();
    await engine.ingestSnapshot(snap({ secsLeft: 3 }));
    assert.equal(engine.position.qty, 0);
    assert.ok(risk.audit.metrics()[RISK_REASON.BELOW_TACTICAL_FLOOR] >= 1);
  });

  it('health block fail-closed', async () => {
    const risk = createRiskEngine();
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      risk,
    });
    engine.start();
    await engine.ingestSnapshot(snap({ healthy: false }));
    assert.equal(engine.position.qty, 0);
    assert.ok(risk.audit.metrics()[RISK_REASON.HEALTH_BLOCK] >= 1);
  });

  it('libera reserva quando o transport rejeita a entrada', async () => {
    const book = createAccountRiskBook({ maxAccountExposure: 5 });
    const risk = createRiskEngine({ accountBook: book, maxNotionalPerOrder: 5 });
    const sink = createOmsSink({
      mode: 'shadow',
      transport: createSimTransport({ behavior: 'reject' }),
    });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 2, maxPrice: 0.5 },
      risk,
      sink,
      strategyInstanceId: 'release-on-reject',
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    assert.equal(book.totalExposure(), 0);
  });
});

describe('kill switch + shutdown', () => {
  it('kill cancela resting e bloqueia novas entradas', async () => {
    const { createSimTransport } = await import('../src/executor/transport.js');
    const sink = createOmsSink({
      mode: 'shadow',
      transport: createSimTransport({ behavior: 'ack-only' }),
      withUserChannel: true,
    });

    const risk = createRiskEngine();
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 1, maxPrice: 0.5 },
      risk,
      sink,
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    assert.equal(sink.oms.openOrders().length, 1);

    await engine.kill('test-kill');
    assert.equal(engine.state, 'HALTED');
    assert.equal(sink.oms.openOrders().length, 0);

    const again = await engine.ingestSnapshot(snap({ btc: 200 }));
    assert.equal(again.skipped, true);
    sink.dispose();
  });
});

describe('global exposure multi-instance', () => {
  it('segunda strategy é bloqueada quando soma estoura', async () => {
    const book = createAccountRiskBook({ maxAccountExposure: 5 });
    const riskA = createRiskEngine({ accountBook: book, maxNotionalPerOrder: 10 });
    const riskB = createRiskEngine({ accountBook: book, maxNotionalPerOrder: 10 });

    const a = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 4, maxPrice: 0.5 },
      risk: riskA,
      strategyInstanceId: 'inst-a',
      accountBook: book,
    });
    const b = bootstrapEngine({
      strategyId: 'fixture-spread-wide',
      mode: 'shadow',
      preset: { minSpread: 0.01, quantity: 10, budget: 4 },
      risk: riskB,
      strategyInstanceId: 'inst-b',
      accountBook: book,
    });

    a.start();
    b.start();
    await a.ingestSnapshot(snap());
    assert.ok(a.position.qty > 0);
    assert.ok(book.totalExposure() > 0);

    await b.ingestSnapshot(snap());
    // budget 4 estouraria 4+4 > 5
    assert.equal(b.position.qty, 0);
    assert.ok(riskB.audit.metrics()[RISK_REASON.MAX_ACCOUNT_EXPOSURE] >= 1);
  });
});

describe('checkpoint / restore', () => {
  it('restore não duplica exposição e preserva posição', async () => {
    const sink = createOmsSink({ mode: 'shadow' });
    const risk = createRiskEngine({ maxAccountExposure: 100 });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 2, maxPrice: 0.5 },
      risk,
      sink,
      strategyInstanceId: 'inst-restore',
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    const qty = engine.position.qty;
    assert.ok(qty > 0);

    const cp = engine.checkpoint();
    assert.equal(cp.schemaVersion, 1);

    const sink2 = createOmsSink({ mode: 'shadow' });
    const risk2 = createRiskEngine();
    const engine2 = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 2, maxPrice: 0.5 },
      risk: risk2,
      sink: sink2,
      strategyInstanceId: 'inst-restore',
    });
    engine2.restore(cp);
    assert.equal(engine2.position.qty, qty);
    assert.equal(engine2.state, 'BOOT');

    // start após restore não deve zerar posição
    engine2.start();
    assert.equal(engine2.position.qty, qty);

    sink.dispose();
    sink2.dispose();
  });
});

describe('ENTER retry após FAK miss', () => {
  function enterIntent(over = {}) {
    return {
      intentId: over.intentId ?? `i-${Math.random().toString(16).slice(2)}`,
      kind: 'ENTER',
      side: 'UP',
      marketId: over.marketId ?? 'btc-updown-5m-1',
      strategyInstanceId: 'midas-carry-v1:btc5m:primary',
      budget: 2,
      quantity: 3,
      maxPrice: 0.66,
      minPrice: null,
      deadlineMs: Date.now() + 5_000,
      reason: 'midas_core_entry',
      orderType: 'FAK',
    };
  }

  it('libera slot após releaseUnfilledEnter e permite novo ENTER', () => {
    const risk = createRiskEngine({ maxEntryAttemptsPerEvent: 3, maxNotionalPerEvent: 50 });
    const first = enterIntent({ intentId: 'a1' });
    assert.equal(risk.evaluate(first).allow, true);
    risk.recordAccepted(first);

    const blocked = enterIntent({ intentId: 'a2' });
    assert.equal(risk.evaluate(blocked).allow, false);
    assert.equal(risk.evaluate(blocked).reasonCode, RISK_REASON.ONE_INTENT_PER_EVENT);

    assert.equal(risk.releaseUnfilledEnter(first), true);

    const retry = enterIntent({ intentId: 'a3' });
    assert.equal(risk.evaluate(retry).allow, true);
    risk.recordAccepted(retry);
    assert.equal(risk.snapshot().entryAttempts[`${retry.strategyInstanceId}:${retry.marketId}`], 2);
  });

  it('esgota retries com ENTRY_ATTEMPTS_EXHAUSTED', () => {
    const risk = createRiskEngine({ maxEntryAttemptsPerEvent: 2, maxNotionalPerEvent: 50 });
    const m = 'btc-updown-5m-retry';
    for (let i = 0; i < 2; i += 1) {
      const intent = enterIntent({ intentId: `e${i}`, marketId: m });
      assert.equal(risk.evaluate(intent).allow, true);
      risk.recordAccepted(intent);
      risk.releaseUnfilledEnter(intent);
    }
    const denied = enterIntent({ intentId: 'e-final', marketId: m });
    const decision = risk.evaluate(denied);
    assert.equal(decision.allow, false);
    assert.equal(decision.reasonCode, RISK_REASON.ENTRY_ATTEMPTS_EXHAUSTED);
  });

  it('engine retenta ENTER após REJECT FAK sem fill', async () => {
    let seq = 0;
    const audit = [];
    const strategy = {
      manifest: { id: 'retry-fak', version: '1.0.0', stateVersion: 1 },
      validatePreset: () => ({ ok: true }),
      initialize: () => ({ state: { armed: true }, diagnostics: {} }),
      onSnapshot(ctx, state) {
        if (ctx.position.qty > 0) return { state, intents: [] };
        seq += 1;
        return {
          state,
          intents: [
            {
              intentId: `retry-fak:m:ENTER:${seq}`,
              kind: 'ENTER',
              side: 'UP',
              marketId: ctx.snapshot.marketId,
              strategyInstanceId: ctx.strategyInstanceId,
              budget: 1.5,
              quantity: 3,
              maxPrice: 0.5,
              minPrice: null,
              deadlineMs: ctx.clockMs + 5_000,
              reason: 'test_retry',
              orderType: 'FAK',
            },
          ],
          diagnostics: {
            entry: {
              ok: true,
              fav: 'UP',
              ask: 0.48,
              bid: 0.47,
              gates: {
                askBand: { pass: true, detail: '0.48' },
              },
            },
            liquidity: { liq: 10, quantity: 3, ok: true },
          },
        };
      },
      onExecutionEvent(_ctx, state) {
        return { state, intents: [], diagnostics: { lastEventType: 'REJECT' } };
      },
    };

    let submits = 0;
    const sink = {
      async submit(intent) {
        submits += 1;
        if (submits === 1) {
          return {
            accepted: false,
            events: [
              {
                eventId: `rej-${intent.intentId}`,
                intentId: intent.intentId,
                type: 'REJECT',
                qty: 0,
                price: null,
                reason: 'no orders found to match with FAK order',
                tsMs: Date.now(),
              },
            ],
          };
        }
        return {
          accepted: true,
          events: [
            {
              eventId: `ack-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'ACK',
              qty: 0,
              price: intent.maxPrice,
              side: intent.side,
              kind: 'ENTER',
              tsMs: Date.now(),
            },
            {
              eventId: `fill-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'FILL',
              qty: intent.quantity,
              price: intent.maxPrice,
              side: intent.side,
              kind: 'ENTER',
              tsMs: Date.now() + 1,
            },
          ],
        };
      },
    };

    const risk = createRiskEngine({
      maxEntryAttemptsPerEvent: 5,
      maxNotionalPerOrder: 50,
      maxNotionalPerEvent: 50,
    });
    const { createEngine } = await import('../src/engine/runtime.js');
    const engine = createEngine({
      mode: 'shadow',
      strategy,
      preset: {},
      sink,
      risk,
      strategyInstanceId: 'retry-inst',
      onAudit: (type, payload) => audit.push({ type, ...payload }),
    });
    engine.start();
    await engine.ingestSnapshot(snap({ btc: 100 }));
    assert.equal(submits, 1);
    assert.equal(engine.position.qty, 0);
    assert.equal(engine.state, 'ARMED');
    assert.ok(audit.some((a) => a.type === 'order_submit' && a.attempt === 1));
    assert.ok(audit.some((a) => a.type === 'order_terminal' && a.eventType === 'REJECT'));
    assert.ok(audit.some((a) => a.type === 'entry_slot_released' && a.canRetry === true));

    await engine.ingestSnapshot(snap({ btc: 101 }));
    assert.equal(submits, 2);
    assert.equal(engine.position.qty, 3);
    assert.ok(audit.some((a) => a.type === 'order_submit' && a.isRetry === true && a.attempt === 2));
  });

  it('audita entry_retry_gated quando gates bloqueiam o retry', async () => {
    const audit = [];
    let phase = 'fire';
    const strategy = {
      manifest: { id: 'retry-gate', version: '1.0.0', stateVersion: 1 },
      validatePreset: () => ({ ok: true }),
      initialize: () => ({ state: {}, diagnostics: {} }),
      onSnapshot(ctx, state) {
        if (phase === 'fire') {
          return {
            state,
            intents: [
              {
                intentId: 'retry-gate:m:ENTER:1',
                kind: 'ENTER',
                side: 'UP',
                marketId: ctx.snapshot.marketId,
                strategyInstanceId: ctx.strategyInstanceId,
                budget: 1.5,
                quantity: 3,
                maxPrice: 0.5,
                orderType: 'FAK',
                reason: 'test',
              },
            ],
            diagnostics: {
              entry: {
                ok: true,
                fav: 'UP',
                ask: 0.48,
                gates: { askBand: { pass: true, detail: 'ok' } },
              },
            },
          };
        }
        return {
          state,
          intents: [],
          diagnostics: {
            entry: {
              ok: false,
              fav: 'UP',
              ask: null,
              gates: {
                askBand: { pass: false, detail: 'ask indisponível · [0.55, 0.94]' },
              },
            },
          },
        };
      },
      onExecutionEvent(_ctx, state) {
        return { state, intents: [], diagnostics: { lastEventType: 'REJECT' } };
      },
    };
    const sink = {
      async submit(intent) {
        return {
          accepted: false,
          events: [
            {
              eventId: `rej-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'REJECT',
              qty: 0,
              reason: 'no orders found to match with FAK order',
              tsMs: Date.now(),
            },
          ],
        };
      },
    };
    const { createEngine } = await import('../src/engine/runtime.js');
    const engine = createEngine({
      mode: 'shadow',
      strategy,
      preset: {},
      sink,
      risk: createRiskEngine({ maxEntryAttemptsPerEvent: 5 }),
      strategyInstanceId: 'gate-inst',
      onAudit: (type, payload) => audit.push({ type, ...payload }),
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    phase = 'blocked';
    await engine.ingestSnapshot(snap({ btc: 101 }));
    const gated = audit.find((a) => a.type === 'entry_retry_gated');
    assert.ok(gated);
    assert.equal(gated.failingGates[0].name, 'askBand');
    assert.match(String(gated.previousRejectReason), /no orders found/i);
  });
});
