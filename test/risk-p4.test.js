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
      fetchFn: async () => ({ ok: true, json: async () => ({ blocked: false, country: 'BR' }) }),
    });
    assert.equal(result.ok, true);
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
  it('bloqueia deadline expirado e reverse live sem saga', () => {
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

describe('circuit breaker', () => {
  it('abre após falhas consecutivas', async () => {
    const risk = createRiskEngine({
      failureThreshold: 2,
      maxNotionalPerOrder: 0.01,
    });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 5, maxPrice: 0.5 },
      risk,
    });
    engine.start();
    await engine.ingestSnapshot(snap());
    await engine.ingestSnapshot(snap({ btc: 101 }));
    assert.equal(risk.circuit.state, 'OPEN');

    // mesmo com threshold alto de notional agora, circuit bloqueia
    risk.limits.maxNotionalPerOrder = 100;
    await engine.ingestSnapshot(snap({ btc: 102 }));
    assert.equal(engine.position.qty, 0);
    assert.ok(risk.audit.metrics()[RISK_REASON.CIRCUIT_OPEN] >= 1);
  });
});
