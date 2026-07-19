import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOms } from '../src/oms/createOms.js';
import { createReconciler } from '../src/oms/reconciler.js';
import { createOmsSink } from '../src/oms/omsSink.js';
import { createSimTransport } from '../src/executor/transport.js';
import { createExecutor } from '../src/executor/createExecutor.js';
import { createUserChannel } from '../src/executor/userChannel.js';
import { quantizePrice, materializeOrderRequest } from '../src/oms/marketRules.js';
import { bootstrapEngine } from '../src/composition/bootstrap.js';
import { isTerminal } from '../src/oms/states.js';

function intent(partial = {}) {
  return {
    intentId: partial.intentId ?? 'i-1',
    kind: partial.kind ?? 'ENTER',
    side: partial.side ?? 'UP',
    marketId: partial.marketId ?? 'm-1',
    strategyInstanceId: partial.strategyInstanceId ?? 'inst-1',
    budget: partial.budget ?? null,
    quantity: partial.quantity ?? 10,
    maxPrice: partial.maxPrice ?? 0.55,
    minPrice: partial.minPrice ?? null,
    deadlineMs: null,
    reason: partial.reason ?? 'test',
    orderType: partial.orderType ?? 'GTC',
  };
}

describe('market rules', () => {
  it('quantiza preço no tick', () => {
    assert.equal(quantizePrice(0.553, 0.01), 0.55);
  });

  it('materializa GTC/FAK/FOK', () => {
    const r = materializeOrderRequest(intent({ orderType: 'FAK', quantity: 5.9 }), {
      minSize: 1,
      tickSize: 0.01,
    });
    assert.equal(r.orderType, 'FAK');
    assert.equal(r.size, 5);
    assert.equal(r.valid, true);
  });
});

describe('OMS idempotência e estados', () => {
  it('dedupa mesmo intentId', async () => {
    const oms = createOms();
    const exec = createExecutor({ oms, transport: createSimTransport() });
    const a = await exec.executeIntent(intent({ intentId: 'dup-1' }));
    const b = await exec.executeIntent(intent({ intentId: 'dup-1' }));
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal(oms.listOrders().length, 1);
    assert.equal(oms.getOrder('dup-1').state, 'MATCHED');
  });

  it('fill parcial → MATCHED e posição acumulada', async () => {
    const oms = createOms();
    const exec = createExecutor({
      oms,
      transport: createSimTransport({ behavior: 'partial', partialRatio: 0.5 }),
    });
    await exec.executeIntent(intent({ intentId: 'p-1', quantity: 10 }));
    const order = oms.getOrder('p-1');
    assert.equal(order.state, 'MATCHED');
    assert.equal(order.qtyFilled, 10);
    assert.equal(oms.position('inst-1').qty, 10);
  });

  it('evento duplicado é ignorado', () => {
    const oms = createOms();
    oms.registerIntent(intent({ intentId: 'd-1', quantity: 4 }));
    oms.bindExchangeId('d-1', 'ex-1');
    const ev = {
      eventId: 'same',
      intentId: 'd-1',
      exchangeOrderId: 'ex-1',
      type: 'FILL',
      qty: 4,
      price: 0.5,
      tsMs: 1,
    };
    const a = oms.applyExchangeEvent(ev);
    const b = oms.applyExchangeEvent(ev);
    assert.equal(a.applied, true);
    assert.equal(b.applied, false);
    assert.equal(b.reason, 'DUPLICATE_EVENT');
    assert.equal(oms.position('inst-1').qty, 4);
  });

  it('ordem pública não expõe exchangeOrderId', async () => {
    const oms = createOms();
    const exec = createExecutor({ oms, transport: createSimTransport() });
    await exec.executeIntent(intent({ intentId: 'hid-1' }));
    const pub = oms.getOrder('hid-1');
    assert.equal('exchangeOrderId' in pub, false);
    assert.equal(pub.hasExchangeId, true);
    assert.ok(oms.getOrderRaw('hid-1').exchangeOrderId);
  });
});

describe('reconciler + UNKNOWN', () => {
  it('lost-ack → UNKNOWN → reconcile para MATCHED', async () => {
    const oms = createOms();
    const exec = createExecutor({
      oms,
      transport: createSimTransport({ behavior: 'lost-ack' }),
    });
    await exec.executeIntent(intent({ intentId: 'u-1', quantity: 3 }));
    assert.equal(oms.getOrder('u-1').state, 'UNKNOWN');

    const recon = createReconciler(oms);
    const raw = oms.getOrderRaw('u-1');
    const report = recon.reconcileOpenOrders([
      {
        intentId: 'u-1',
        exchangeOrderId: raw.exchangeOrderId,
        status: 'MATCHED',
        qtyFilled: 3,
        price: 0.55,
      },
    ]);
    assert.equal(report.resolved.length, 1);
    assert.equal(oms.getOrder('u-1').state, 'MATCHED');
    assert.equal(oms.position('inst-1').qty, 3);
  });
});

describe('journal restart', () => {
  it('checkpoint + restore reconstrói posição antes de nova intenção', async () => {
    const oms = createOms();
    const exec = createExecutor({ oms, transport: createSimTransport() });
    await exec.executeIntent(intent({ intentId: 'r-1', quantity: 7 }));
    oms.checkpoint();
    const snap = oms.journal.snapshot();

    const oms2 = createOms();
    oms2.restoreFromJournal(snap);
    assert.equal(oms2.position('inst-1').qty, 7);
    assert.equal(oms2.getOrder('r-1').state, 'MATCHED');

    // nova intenção após restore
    const exec2 = createExecutor({ oms: oms2, transport: createSimTransport() });
    await exec2.executeIntent(
      intent({ intentId: 'r-2', quantity: 2, strategyInstanceId: 'inst-1' }),
    );
    assert.equal(oms2.position('inst-1').qty, 9);
  });
});

describe('OMS sink + engine', () => {
  it('100% ordens shadow terminam em estado final', async () => {
    const sink = createOmsSink({ mode: 'shadow' });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'shadow',
      preset: { threshold: 1, budget: 5, maxPrice: 0.5 },
      sink,
    });
    engine.start();
    await engine.ingestSnapshot({
      marketId: 'm-1',
      nowMs: Date.now(),
      secsLeft: 20,
      btc: 100,
      priceToBeat: 90,
      book: {
        up: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
        down: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
      },
      feeds: { healthy: true },
    });

    const orders = sink.oms.listOrders();
    assert.ok(orders.length >= 1);
    for (const o of orders) {
      assert.equal(isTerminal(o.state), true, `order ${o.intentId} state=${o.state}`);
    }
    assert.ok(engine.position.qty > 0);
    sink.dispose();
  });

  it('dry-run não abre posição e cancela resting', async () => {
    const sink = createOmsSink({ mode: 'dry-run' });
    const engine = bootstrapEngine({
      strategyId: 'fixture-price-cross',
      mode: 'dry-run',
      preset: { threshold: 1, budget: 5, maxPrice: 0.5 },
      sink,
    });
    engine.start();
    await engine.ingestSnapshot({
      marketId: 'm-1',
      nowMs: Date.now(),
      secsLeft: 20,
      btc: 100,
      priceToBeat: 90,
      book: {
        up: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
        down: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
      },
      feeds: { healthy: true },
    });
    assert.equal(engine.position.qty, 0);
    for (const o of sink.oms.listOrders()) {
      assert.equal(o.state, 'CANCELED');
    }
    sink.dispose();
  });

  it('cancel-on-disconnect cancela open orders', async () => {
    const oms = createOms();
    const sink = createOmsSink({
      mode: 'shadow',
      oms,
      transport: createSimTransport({ behavior: 'ack-only' }),
      withUserChannel: true,
    });
    await sink.submit(intent({ intentId: 'cod-1', quantity: 2 }));
    assert.equal(oms.getOrder('cod-1').state, 'LIVE');
    const { canceled } = sink.cancelOnDisconnect();
    assert.ok(canceled.includes('cod-1'));
    assert.equal(oms.getOrder('cod-1').state, 'CANCELED');
    sink.dispose();
  });
});

describe('user channel', () => {
  it('connect / heartbeat / disconnect', () => {
    const ch = createUserChannel({ kind: 'sim' });
    ch.connect();
    assert.equal(ch.connected, true);
    const stop = ch.startHeartbeat(20);
    assert.equal(typeof stop, 'function');
    ch.disconnect();
    assert.equal(ch.connected, false);
    stop();
  });
});
