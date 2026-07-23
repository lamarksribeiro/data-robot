import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapMidasCanaryEngine } from '../src/composition/midasCanary.js';
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
});
