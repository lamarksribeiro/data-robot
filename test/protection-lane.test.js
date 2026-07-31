import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRiskEngine } from '../src/risk/createRiskEngine.js';
import { RISK_REASON } from '../src/risk/reasons.js';
import {
  isExpectedClobReject,
  isProtectionLaneIntent,
  shouldRecordTransportFailure,
} from '../src/risk/protectionLane.js';
import { createLiveTransport } from '../src/executor/liveTransport.js';

const Side = { BUY: 'BUY', SELL: 'SELL' };
const OrderType = { GTC: 'GTC', FAK: 'FAK', FOK: 'FOK' };

function baseIntent(over = {}) {
  return {
    intentId: over.intentId ?? `i-${Math.random().toString(16).slice(2)}`,
    kind: over.kind ?? 'ENTER',
    side: over.side ?? 'UP',
    marketId: over.marketId ?? 'btc-updown-5m-1',
    strategyInstanceId: over.strategyInstanceId ?? 'midas-carry-v1:btc5m:primary',
    budget: over.budget ?? 2,
    quantity: over.quantity ?? 3,
    maxPrice: over.maxPrice ?? 0.66,
    minPrice: over.minPrice ?? null,
    deadlineMs: over.deadlineMs ?? Date.now() + 60_000,
    reason: over.reason ?? 'test',
    orderType: over.orderType ?? 'FAK',
    ...over,
  };
}

describe('protectionLane helpers', () => {
  it('classifica EXIT/CANCEL/REVERSE como protection lane', () => {
    assert.equal(isProtectionLaneIntent({ kind: 'EXIT' }), true);
    assert.equal(isProtectionLaneIntent({ kind: 'CANCEL' }), true);
    assert.equal(isProtectionLaneIntent({ kind: 'REVERSE' }), true);
    assert.equal(isProtectionLaneIntent({ kind: 'ENTER' }), false);
  });

  it('reconhece FAK miss como reject esperado', () => {
    assert.equal(
      isExpectedClobReject(
        'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
      ),
      true,
    );
    assert.equal(shouldRecordTransportFailure('no orders found to match with FAK order'), false);
    assert.equal(shouldRecordTransportFailure('submit_TIMEOUT', { kind: 'ENTER' }), true);
    assert.equal(shouldRecordTransportFailure('submit_TIMEOUT', { kind: 'EXIT' }), false);
  });
});

describe('createRiskEngine protection lane', () => {
  it('com circuit aberto: EXIT e REVERSE passam; ENTER continua bloqueado', () => {
    let now = 1_000_000;
    const risk = createRiskEngine({
      failureThreshold: 3,
      cooldownMs: 60_000,
      clock: () => now,
      maxNotionalPerEvent: 50,
      allowLiveReverse: true,
    });

    for (let i = 0; i < 3; i += 1) {
      risk.recordFailure('fak_miss');
    }
    assert.equal(risk.circuit.evaluate().allow, false);

    const enter = risk.evaluate(baseIntent({ kind: 'ENTER', intentId: 'e1' }));
    assert.equal(enter.allow, false);
    assert.equal(enter.reasonCode, RISK_REASON.CIRCUIT_OPEN);

    const exit = risk.evaluate(
      baseIntent({
        kind: 'EXIT',
        intentId: 'x1',
        budget: null,
        quantity: 3,
        maxPrice: null,
        minPrice: 0.4,
        orderType: 'GTC',
        reason: 'late_flip_exit',
      }),
    );
    assert.equal(exit.allow, true);
    assert.equal(exit.reasonCode, RISK_REASON.OK);

    const reverse = risk.evaluate(
      baseIntent({
        kind: 'REVERSE',
        intentId: 'r1',
        budget: 2,
        maxPrice: 0.7,
        minPrice: 0.4,
        orderType: 'FAK',
        reason: 'late_flip_reverse',
      }),
    );
    assert.equal(reverse.allow, true);

    now += 1;
  });

  it('perda diária bloqueia ENTER mas não EXIT', () => {
    const risk = createRiskEngine({
      maxDailyLoss: 10,
      dailyRealizedPnl: -11,
      maxNotionalPerEvent: 50,
    });
    assert.equal(risk.evaluate(baseIntent({ kind: 'ENTER' })).reasonCode, RISK_REASON.MAX_DAILY_LOSS);
    assert.equal(
      risk.evaluate(
        baseIntent({
          kind: 'EXIT',
          budget: null,
          quantity: 2,
          maxPrice: null,
          minPrice: 0.3,
        }),
      ).allow,
      true,
    );
  });

  it('REVERSE não é negado por MAX_NOTIONAL_EVENT após ENTER ter consumido o cap', () => {
    const risk = createRiskEngine({
      maxNotionalPerEvent: 4,
      maxNotionalPerOrder: 4,
      allowLiveReverse: true,
    });
    const enter = baseIntent({
      kind: 'ENTER',
      intentId: 'e-cap',
      budget: 4,
      quantity: 5,
      maxPrice: 0.8,
    });
    assert.equal(risk.evaluate(enter).allow, true);
    risk.recordAccepted(enter);

    const reverse = risk.evaluate(
      baseIntent({
        kind: 'REVERSE',
        intentId: 'r-cap',
        budget: 4,
        quantity: 5,
        maxPrice: 0.8,
        minPrice: 0.4,
        reason: 'late_flip_reverse',
      }),
    );
    assert.equal(reverse.allow, true);
  });
});

describe('liveTransport: FAK miss não abre circuit; EXIT atravessa', () => {
  it('5 FAK miss esperados não bloqueiam SELL/EXIT posterior', async () => {
    const client = {
      async createAndPostOrder() {
        return {
          success: false,
          errorMsg:
            'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
        };
      },
    };
    const transport = createLiveTransport({ client, Side, OrderType });
    const buyReq = {
      tokenSide: 'UP',
      price: 0.5,
      size: 2,
      tradeSide: 'BUY',
      orderType: 'FAK',
      tokenId: 't1',
    };
    for (let i = 0; i < 5; i += 1) {
      const r = await transport.submit(buyReq, { intentId: `enter-${i}`, kind: 'ENTER' });
      assert.equal(r.accepted, false);
      assert.match(r.events[0].reason, /no orders found/i);
    }

    let sellCalls = 0;
    client.createAndPostOrder = async () => {
      sellCalls += 1;
      return { success: true, orderID: 'exit-1', status: 'LIVE' };
    };
    const exitResult = await transport.submit(
      {
        tokenSide: 'UP',
        price: 0.4,
        size: 2,
        tradeSide: 'SELL',
        orderType: 'GTC',
        tokenId: 't1',
      },
      { intentId: 'exit-1', kind: 'EXIT' },
    );
    assert.equal(exitResult.accepted, true);
    assert.equal(sellCalls, 1);
  });

  it('circuit por erros reais ainda bloqueia ENTER mas não EXIT', async () => {
    const client = {
      async createAndPostOrder() {
        throw new Error('429 rate limit');
      },
    };
    const transport = createLiveTransport({ client, Side, OrderType });
    const buyReq = {
      tokenSide: 'UP',
      price: 0.5,
      size: 1,
      tradeSide: 'BUY',
      orderType: 'GTC',
      tokenId: 't1',
    };
    for (let i = 0; i < 5; i += 1) {
      await transport.submit(buyReq, { intentId: `fail-${i}`, kind: 'ENTER' });
    }
    const blocked = await transport.submit(buyReq, { intentId: 'blocked', kind: 'ENTER' });
    assert.equal(blocked.events[0].reason, 'CIRCUIT_OPEN');

    let exitPosted = 0;
    client.createAndPostOrder = async () => {
      exitPosted += 1;
      return { success: true, orderID: 'x', status: 'LIVE' };
    };
    const exit = await transport.submit(
      {
        tokenSide: 'UP',
        price: 0.4,
        size: 1,
        tradeSide: 'SELL',
        orderType: 'GTC',
        tokenId: 't1',
      },
      { intentId: 'exit-bypass', kind: 'EXIT' },
    );
    assert.equal(exit.accepted, true);
    assert.equal(exitPosted, 1);
  });
});

describe('cushionDecay evaluate (porte lab)', () => {
  it('dispara EXIT quando dist<=0 e bid >= 0.55×entry na janela 20→4s', async () => {
    const { evaluateCushionDecayExit } = await import('../src/tfc/evaluate.js');
    const snapshot = {
      secsLeft: 12,
      btc: 99,
      priceToBeat: 100,
      book: { up: { bestBid: 0.6, bestAsk: 0.61 }, down: { bestBid: 0.38, bestAsk: 0.39 } },
    };
    const params = {
      cushionDecayEnabled: true,
      cushionDecayStartSec: 20,
      cushionDecayEndSec: 4,
      cushionDecayMinDist: 0,
      cushionDecayMinBidRatio: 0.55,
      stopMinBid: 0.05,
    };
    const hit = evaluateCushionDecayExit(snapshot, params, 'UP', -1, 0.7);
    assert.equal(hit.active, true);
    assert.equal(hit.reason, 'cushion_decay_exit');

    const off = evaluateCushionDecayExit(snapshot, { ...params, cushionDecayEnabled: false }, 'UP', -1, 0.7);
    assert.equal(off.active, false);
  });
});
