import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VARIANT_E_GOLDEN,
  VARIANT_E_ADAPT,
  sizeShares,
  createEventState,
  tryEntry,
  applyEntryFill,
  managePosition,
  createSpotRing,
  createMidRing,
  pushSpot,
  pushMid,
} from '../scripts/binance-lead-scalp/scalp-engine.js';

function book(side, ask, bid, askSz = 100) {
  return {
    UP: side === 'UP' ? { bestAsk: ask, bestBid: bid, asks: [{ size: askSz }] } : { bestAsk: 0.5, bestBid: 0.49, asks: [{ size: 100 }] },
    DOWN: side === 'DOWN' ? { bestAsk: ask, bestBid: bid, asks: [{ size: askSz }] } : { bestAsk: 0.5, bestBid: 0.49, asks: [{ size: 100 }] },
  };
}

function warmSpot(ring, nowMs, ret = 10) {
  // spotAt exige sample ≤400ms do alvo — pontos densos no lead de 2s.
  const base = 100000;
  for (let ms = 5000; ms >= 0; ms -= 100) {
    const ts = nowMs - ms;
    // impulso: só sobe nos últimos ~1.5s
    const spot = ms > 1500 ? base : base + ret;
    pushSpot(ring, ts, spot);
  }
  pushSpot(ring, nowMs, base + ret);
}

describe('binance-lead-scalp engine — e-golden', () => {
  it('sizeShares sharesCap caps cheap asks at floor(budget/0.50)', () => {
    const cfg = { sizingMode: 'sharesCap', sharesCapAsk: 0.5 };
    assert.equal(sizeShares(10, 0.5, cfg), 20);
    assert.equal(sizeShares(10, 0.34, cfg), 20); // would be 29.4 without cap
    assert.equal(sizeShares(10, 0.2, cfg), 20);
    assert.equal(sizeShares(3, 0.34, cfg), 6); // forensic micro budget
    assert.ok(sizeShares(10, 0.6, cfg) < 17); // ~16.67, no cap hit
  });

  it('sizeShares none is budget/ask', () => {
    assert.ok(Math.abs(sizeShares(3, 0.34, { sizingMode: 'none' }) - 3 / 0.34) < 1e-9);
  });

  it('tryEntry with e-golden caps shares on cheap ask', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_GOLDEN, budget: 3, impulseVolMult: 0, impulseUsd: 5 });
    const spotRing = createSpotRing(30);
    const midRing = createMidRing(10);
    warmSpot(spotRing, nowMs, 10);
    // mid stale: no large move
    pushMid(midRing, nowMs - 2000, 'UP', 0.34);
    pushMid(midRing, nowMs, 'UP', 0.34);
    const intent = tryEntry(st, {
      spotRing,
      midRing,
      book: book('UP', 0.34, 0.33),
      tau: 120,
      nowMs,
      spotAgeMs: 100,
      bookAgeMs: 100,
    });
    assert.ok(intent, `expected intent, got null last=${st.lastNoEntryReason}`);
    assert.equal(intent.side, 'UP');
    assert.equal(intent.shares, 6); // floor(3/0.5)=6, not 8.82
  });

  it('managePosition gaps past disaster dump without entering rescue', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_GOLDEN, budget: 10 });
    const filled = applyEntryFill(
      st,
      { side: 'UP', ask: 0.4, bid: 0.39, shares: 20, tau: 100, binRet: 8 },
      { fillAsk: 0.4, fillShares: 20, nowMs, acceptSlippedAsk: true },
    );
    assert.ok(filled.ok);
    assert.ok(st.pos);
    assert.equal(st.pos.rescue, undefined);

    // bid gaps from 0.39 straight to 0.20 (entry 0.40 − 0.15 = 0.25 disaster)
    const closed = managePosition(st, {
      book: book('UP', 0.22, 0.2),
      nowMs: nowMs + 500,
      fillMode: 'honest',
    });
    assert.ok(closed?.reason === 'rescue_stop', `got ${closed?.reason || closed?.action}`);
    assert.equal(st.pos, null);
    assert.ok(closed.pnl < 0);
  });

  it('managePosition soft-stop enters rescue when not past disaster', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_GOLDEN, budget: 10 });
    applyEntryFill(
      st,
      { side: 'UP', ask: 0.5, bid: 0.49, shares: 20, tau: 100, binRet: 8 },
      { fillAsk: 0.5, fillShares: 20, nowMs },
    );
    // bid = 0.44 = entry − 6¢ (soft stop −5¢) but above disaster 0.35
    const ev = managePosition(st, {
      book: book('UP', 0.46, 0.44),
      nowMs: nowMs + 1000,
      fillMode: 'honest',
    });
    assert.equal(ev?.action, 'rescue');
    assert.ok(st.pos?.rescue);
  });

  it('e-adapt without sharesCap still oversizes cheap asks (legacy)', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_ADAPT, budget: 3, impulseVolMult: 0, impulseUsd: 5 });
    const spotRing = createSpotRing(30);
    const midRing = createMidRing(10);
    warmSpot(spotRing, nowMs, 10);
    pushMid(midRing, nowMs - 2000, 'UP', 0.34);
    pushMid(midRing, nowMs, 'UP', 0.34);
    const intent = tryEntry(st, {
      spotRing,
      midRing,
      book: book('UP', 0.34, 0.33),
      tau: 120,
      nowMs,
      spotAgeMs: 100,
      bookAgeMs: 100,
    });
    assert.ok(intent);
    assert.ok(intent.shares > 8);
  });
});
