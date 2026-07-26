import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapMidasCanaryEngine } from '../src/composition/midasCanary.js';
import { createOms } from '../src/oms/createOms.js';
import { executeReverseSaga } from '../src/oms/reverseSaga.js';
import { isTerminal } from '../src/oms/states.js';
import { canaryMidasPreset } from '../src/tfc/preset-midas.js';

function bookFlip() {
  return {
    up: {
      bestBid: 0.4,
      bestAsk: 0.42,
      bids: [{ size: 50 }, { size: 50 }],
      asks: [{ size: 50 }, { size: 50 }],
    },
    down: {
      bestBid: 0.56,
      bestAsk: 0.58,
      bids: [{ size: 50 }, { size: 50 }],
      asks: [{ size: 50 }, { size: 50 }],
    },
  };
}

function bookEntry() {
  return {
    up: {
      bestBid: 0.6,
      bestAsk: 0.62,
      bids: [{ size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }],
      asks: [{ size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }],
    },
    down: {
      bestBid: 0.36,
      bestAsk: 0.4,
      bids: [{ size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }],
      asks: [{ size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }, { size: 50 }],
    },
  };
}

function snap(partial = {}) {
  const nowMs = partial.nowMs ?? 1_700_000_000_000;
  return {
    marketId: partial.marketId ?? 'btc-5m-rev',
    nowMs,
    secsLeft: partial.secsLeft ?? 20,
    btc: partial.btc ?? 100.5,
    priceToBeat: partial.priceToBeat ?? 100,
    book: partial.book ?? bookEntry(),
    feeds: { healthy: true, rtdsLagMs: 50, clobLagMs: 50 },
    acceptingOrders: true,
    identity: { upTokenId: 'up-t', downTokenId: 'down-t' },
  };
}

describe('MIDAS reverse saga', () => {
  it('late flip executa SELL→BUY e fica no lado oposto', async () => {
    const engine = bootstrapMidasCanaryEngine({
      mode: 'shadow',
      preset: canaryMidasPreset(),
    });
    engine.start();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 6; i += 1) {
      await engine.ingestMarketSnapshot(
        snap({ nowMs: now - (5 - i) * 1000, secsLeft: 20, btc: 100.5 }),
      );
    }
    assert.ok(engine.position.qty > 0, 'esperava ENTER');
    assert.equal(engine.position.side, 'UP');
    const entrySide = engine.position.side;

    await engine.ingestMarketSnapshot(
      snap({
        nowMs: now + 1000,
        secsLeft: 6,
        btc: 99.5,
        book: bookFlip(),
      }),
    );

    const orders = engine.sink.oms.listOrders();
    const parent = orders.find(
      (o) => o.kind === 'REVERSE' && !String(o.intentId).includes(':exit') && !String(o.intentId).includes(':enter'),
    );
    const exitLeg = orders.find((o) => o.kind === 'EXIT' && String(o.intentId).endsWith(':exit'));
    const enterLeg = orders.find((o) => o.kind === 'ENTER' && String(o.intentId).endsWith(':enter'));
    assert.ok(parent, `esperava REVERSE pai; orders=${orders.map((o) => o.kind + ':' + o.intentId)}`);
    assert.ok(exitLeg, 'esperava perna EXIT');
    assert.ok(enterLeg, 'esperava perna ENTER');
    // Pernas não podem compartilhar orderType: exit é protetora (exitOrderType do
    // preset), enter segue a entrada normal (entryOrderType) — nunca o inverso.
    assert.equal(exitLeg.orderType, canaryMidasPreset().exitOrderType);
    assert.equal(enterLeg.orderType, canaryMidasPreset().entryOrderType);
    assert.notEqual(exitLeg.orderType, enterLeg.orderType);
    assert.equal(engine.position.side, 'DOWN');
    assert.ok(engine.position.qty > 0);
    assert.notEqual(engine.position.side, entrySide);

    await engine.safeShutdown('test');
  });

  it('com reverse desligado, late flip vira EXIT flat', async () => {
    const engine = bootstrapMidasCanaryEngine({
      mode: 'shadow',
      preset: canaryMidasPreset({ lateFlipReverseEnabled: false }),
    });
    engine.start();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 6; i += 1) {
      await engine.ingestMarketSnapshot(
        snap({ nowMs: now - (5 - i) * 1000, secsLeft: 20, btc: 100.5 }),
      );
    }
    assert.ok(engine.position.qty > 0);

    await engine.ingestMarketSnapshot(
      snap({
        nowMs: now + 1000,
        secsLeft: 6,
        btc: 99.5,
        book: bookFlip(),
      }),
    );

    const orders = engine.sink.oms.listOrders();
    assert.equal(orders.some((o) => o.kind === 'REVERSE'), false);
    assert.ok(orders.some((o) => o.kind === 'EXIT' && o.reason === 'late_flip_exit'));
    assert.equal(engine.position.qty, 0);

    await engine.safeShutdown('test');
  });

  it('EXIT GTC resting: cancel + reprice preenche na retry', async () => {
    const oms = createOms({ clock: () => 1_700_000_000_000 });
    const strategyInstanceId = 'rev-retry';
    // Seed posição UP
    oms.registerIntent({
      intentId: 'seed-enter',
      kind: 'ENTER',
      side: 'UP',
      marketId: 'm-rev',
      strategyInstanceId,
      quantity: 3,
      maxPrice: 0.6,
      orderType: 'FAK',
    });
    oms.applyExchangeEvent({
      eventId: 'seed-ack',
      intentId: 'seed-enter',
      type: 'ACK',
      qty: 0,
      price: 0.6,
      tsMs: 1,
    });
    oms.applyExchangeEvent({
      eventId: 'seed-fill',
      intentId: 'seed-enter',
      type: 'FILL',
      qty: 3,
      price: 0.6,
      tsMs: 2,
    });
    assert.equal(oms.position(strategyInstanceId).qty, 3);

    let exitPosts = 0;
    const canceled = [];
    const minPrices = [];

    const executeIntent = async (intent) => {
      const { order, deduped } = oms.registerIntent(intent);
      if (deduped) return { accepted: true, deduped: true, events: [] };
      if (order.state === 'REJECTED') {
        return {
          accepted: false,
          events: [{ eventId: `rej-${intent.intentId}`, intentId: intent.intentId, type: 'REJECT', qty: 0, price: null, tsMs: 3 }],
        };
      }
      if (intent.kind === 'EXIT') {
        exitPosts += 1;
        minPrices.push(Number(intent.minPrice));
        oms.applyExchangeEvent({
          eventId: `ack-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'ACK',
          qty: 0,
          price: intent.minPrice,
          tsMs: 10 + exitPosts,
        });
        if (exitPosts === 1) {
          // Book some: GTC fica LIVE sem fill
          return {
            accepted: true,
            events: [
              {
                eventId: `ack-ev-${intent.intentId}`,
                intentId: intent.intentId,
                type: 'ACK',
                qty: 0,
                price: intent.minPrice,
                tsMs: 10,
              },
            ],
          };
        }
        // Retry com preço mais agressivo: fill completo
        const fill = oms.applyExchangeEvent({
          eventId: `fill-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'FILL',
          qty: intent.quantity,
          price: intent.minPrice,
          tsMs: 20,
        });
        return { accepted: true, events: fill.executionEvents ?? [] };
      }
      // ENTER
      oms.applyExchangeEvent({
        eventId: `ack-${intent.intentId}`,
        intentId: intent.intentId,
        type: 'ACK',
        qty: 0,
        price: intent.maxPrice,
        tsMs: 30,
      });
      const fill = oms.applyExchangeEvent({
        eventId: `fill-${intent.intentId}`,
        intentId: intent.intentId,
        type: 'FILL',
        qty: 3,
        price: intent.maxPrice,
        tsMs: 31,
      });
      return { accepted: true, events: fill.executionEvents ?? [] };
    };

    const cancelOrder = async (intentId, reason) => {
      canceled.push({ intentId, reason });
      const raw = oms.getOrderRaw(intentId);
      if (!raw || isTerminal(raw.state)) return { ok: true };
      oms.applyExchangeEvent({
        eventId: `cancel-${intentId}-${canceled.length}`,
        intentId,
        type: 'CANCEL',
        qty: 0,
        price: null,
        reason: reason ?? 'cancel',
        tsMs: 15 + canceled.length,
      });
      return { ok: true };
    };

    const waitForFinal = async (intentId, waitOpts = {}) => {
      const order = oms.getOrder(intentId);
      if (order && isTerminal(order.state)) return { ok: true, order };
      if (waitOpts.killOnTimeout) {
        await cancelOrder(intentId, 'exit_timeout_killed');
      }
      return { ok: true, order: oms.getOrder(intentId) };
    };

    const result = await executeReverseSaga({
      intent: {
        intentId: 'rev-1',
        kind: 'REVERSE',
        side: 'DOWN',
        marketId: 'm-rev',
        strategyInstanceId,
        budget: 2,
        maxPrice: 0.6,
        minPrice: 0.38,
        exitSide: 'UP',
        exitQuantity: 3,
        exitTokenId: 'up-t',
        tokenId: 'down-t',
        orderType: 'FAK',
        exitOrderType: 'GTC',
        reason: 'late_flip_reverse',
        secsLeftMs: 6000,
      },
      oms,
      executeIntent,
      waitForFinal,
      cancelOrder,
      exitRetries: 2,
      legTimeoutMs: 1000,
    });

    assert.equal(result.accepted, true, `esperava reverse ok; ${JSON.stringify(result)}`);
    assert.equal(exitPosts, 2);
    assert.ok(minPrices[1] < minPrices[0], `reprice: ${minPrices}`);
    assert.ok(canceled.some((c) => String(c.intentId).includes(':exit')));
    assert.equal(oms.position(strategyInstanceId).side, 'DOWN');
    assert.ok(oms.position(strategyInstanceId).qty > 0);
  });

  it('esgota retries: incomplete e residual cancelado', async () => {
    const oms = createOms({ clock: () => 1_700_000_000_000 });
    const strategyInstanceId = 'rev-incomplete';
    oms.registerIntent({
      intentId: 'seed-enter-2',
      kind: 'ENTER',
      side: 'UP',
      marketId: 'm-rev-2',
      strategyInstanceId,
      quantity: 2,
      maxPrice: 0.55,
      orderType: 'FAK',
    });
    oms.applyExchangeEvent({
      eventId: 'seed2-ack',
      intentId: 'seed-enter-2',
      type: 'ACK',
      qty: 0,
      price: 0.55,
      tsMs: 1,
    });
    oms.applyExchangeEvent({
      eventId: 'seed2-fill',
      intentId: 'seed-enter-2',
      type: 'FILL',
      qty: 2,
      price: 0.55,
      tsMs: 2,
    });

    const canceled = [];
    let exitPosts = 0;
    const executeIntent = async (intent) => {
      oms.registerIntent(intent);
      if (intent.kind === 'EXIT') {
        exitPosts += 1;
        oms.applyExchangeEvent({
          eventId: `ack-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'ACK',
          qty: 0,
          price: intent.minPrice,
          tsMs: 10 + exitPosts,
        });
        return {
          accepted: true,
          events: [
            {
              eventId: `ack-ev-${intent.intentId}`,
              intentId: intent.intentId,
              type: 'ACK',
              qty: 0,
              price: intent.minPrice,
              tsMs: 10,
            },
          ],
        };
      }
      assert.fail('não deve postar ENTER após EXIT incomplete');
    };

    const cancelOrder = async (intentId, reason) => {
      canceled.push({ intentId, reason });
      const raw = oms.getOrderRaw(intentId);
      if (!raw || isTerminal(raw.state)) return { ok: true };
      oms.applyExchangeEvent({
        eventId: `cancel-${intentId}-${canceled.length}`,
        intentId,
        type: 'CANCEL',
        qty: 0,
        price: null,
        reason: reason ?? 'cancel',
        tsMs: 50 + canceled.length,
      });
      return { ok: true };
    };

    const waitForFinal = async (intentId, waitOpts = {}) => {
      if (waitOpts.killOnTimeout) await cancelOrder(intentId, 'exit_timeout_killed');
      return { ok: true, order: oms.getOrder(intentId) };
    };

    const result = await executeReverseSaga({
      intent: {
        intentId: 'rev-fail',
        kind: 'REVERSE',
        side: 'DOWN',
        marketId: 'm-rev-2',
        strategyInstanceId,
        budget: 2,
        maxPrice: 0.6,
        minPrice: 0.4,
        exitSide: 'UP',
        exitQuantity: 2,
        orderType: 'FAK',
        exitOrderType: 'GTC',
        reason: 'late_flip_reverse',
      },
      oms,
      executeIntent,
      waitForFinal,
      cancelOrder,
      exitRetries: 2,
      legTimeoutMs: 200,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.events[0]?.reason, 'REVERSE_EXIT_INCOMPLETE');
    assert.equal(exitPosts, 3); // 1 + 2 retries
    assert.ok(canceled.length >= 1, `esperava cancel residual; canceled=${JSON.stringify(canceled)}`);
    assert.equal(oms.position(strategyInstanceId).qty, 2);
    for (const order of oms.listOrders().filter((o) => o.kind === 'EXIT')) {
      assert.ok(isTerminal(order.state), `EXIT residual deve ser terminal: ${order.intentId} ${order.state}`);
    }
  });
});
