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
  it('VARIANT_E_GOLDEN V2.2 defaults: cap45, nra60, slip0.03, staleMid0.03', () => {
    assert.equal(VARIANT_E_GOLDEN.impulseCap, 20);
    assert.equal(VARIANT_E_GOLDEN.rescueStop, 0.25);
    assert.equal(VARIANT_E_GOLDEN.sizingMode, 'sharesCap');
    assert.equal(VARIANT_E_GOLDEN.sharesCapAsk, 0.45);
    assert.equal(VARIANT_E_GOLDEN.immediateDisasterDump, true);
    assert.equal(VARIANT_E_GOLDEN.noRescueAboveAsk, 0.6);
    assert.equal(VARIANT_E_GOLDEN.maxEntrySlip, 0.03);
    assert.equal(VARIANT_E_GOLDEN.staleMidMoveMax, 0.03);
    assert.deepEqual(VARIANT_E_GOLDEN.ladderOffsets, [0.08, 0.14]);
  });

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

    // bid gaps from 0.39 straight to 0.10 (entry 0.40 − 0.25 = 0.15 disaster)
    const closed = managePosition(st, {
      book: book('UP', 0.12, 0.1),
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
    // bid = 0.44 = entry − 6¢ (soft stop −5¢) but above disaster 0.25; ask 0.50 < nra 0.60
    const ev = managePosition(st, {
      book: book('UP', 0.46, 0.44),
      nowMs: nowMs + 1000,
      fillMode: 'honest',
    });
    assert.equal(ev?.action, 'rescue');
    assert.ok(st.pos?.rescue);
  });

  it('managePosition soft-stop dumps when entryAsk >= noRescueAboveAsk', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_GOLDEN, budget: 10 });
    applyEntryFill(
      st,
      { side: 'UP', ask: 0.62, bid: 0.61, shares: 8, tau: 100, binRet: 8 },
      { fillAsk: 0.62, fillShares: 8, nowMs },
    );
    // soft-stop −5¢ at ask≥0.60 → ladder_stop, não rescue→disaster
    const closed = managePosition(st, {
      book: book('UP', 0.58, 0.56),
      nowMs: nowMs + 1000,
      fillMode: 'honest',
    });
    assert.equal(closed?.reason, 'ladder_stop');
    assert.equal(st.pos, null);
    assert.ok(closed.pnl > -1.2, `expected shallow loss, got ${closed.pnl}`);
  });

  it('applyEntryFill rejects fill when ask slipped too far', () => {
    const nowMs = Date.now();
    const st = createEventState({ ...VARIANT_E_GOLDEN, budget: 5, maxEntrySlip: 0.03 });
    const intent = {
      side: 'UP',
      ask: 0.49,
      bid: 0.48,
      shares: 10,
      tau: 150,
      binRet: 6,
      impulseMin: 5,
    };
    const res = applyEntryFill(st, intent, {
      fillMode: 'cruel',
      fillAsk: 0.6,
      nowMs,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ask_slipped_too_far');
    assert.ok(!st.pos);
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
