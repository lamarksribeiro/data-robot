/**
 * Late Surprise (mode 3) — lógica de sinal + fill simulado.
 * Params alinhados ao campeão m3-ask35 do lab late-cheap-flip-v1.
 */

export const CHAMPION = {
  entryMode: 3,
  minSecondsLeft: 3,
  maxSecondsLeft: 15,
  minDistAbs: 8,
  maxDistAbs: 80,
  minEdge: 0.12,
  volStepSecs: 30,
  minAsk: 0.05,
  maxAsk: 0.35,
  maxSpread: 0.04,
  minOddsSum: 0.96,
  maxOddsSum: 1.06,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.6,
  entryBudget: 10,
  settleWinnerPrice: 0.995,
  feeRate: 0.07,
  /** Spot stale → skip entry. */
  maxSpotAgeMs: 2000,
  /** Anti-flip gate opcional (§6 da doc). */
  antiFlipEnabled: false,
  antiFlipMidDrop: 0.05,
  antiFlipMaxZ: 0.5,
  antiFlipMaxAsk: 0.68,
};

/** CDF normal padrão (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x) {
  if (!Number.isFinite(x)) return 0.5;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function feeEst(price, shares, rate = CHAMPION.feeRate) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

export function createSampleRing(maxSecs = 120) {
  return { maxSecs, pts: [] };
}

export function pushSample(ring, ts, btc) {
  if (!Number.isFinite(btc) || !Number.isFinite(ts)) return;
  ring.pts.push({ ts, btc });
  const cutoff = ts - ring.maxSecs * 1000;
  while (ring.pts.length && ring.pts[0].ts < cutoff) ring.pts.shift();
}

function underlyingAgo(ring, nowMs, secsAgo) {
  const target = nowMs - secsAgo * 1000;
  let best = null;
  let bestDt = Infinity;
  for (const p of ring.pts) {
    const dt = Math.abs(p.ts - target);
    if (dt < bestDt) {
      bestDt = dt;
      best = p;
    }
  }
  // Aceita amostra se estiver a ≤ 40% do lookback (ou ≤ 8s).
  if (!best || bestDt > Math.max(8000, secsAgo * 400)) return null;
  return best.btc;
}

export function volPerSecond(ring, nowMs, stepSecs = 30) {
  const u0 = underlyingAgo(ring, nowMs, 0) ?? ring.pts.at(-1)?.btc;
  const u1 = underlyingAgo(ring, nowMs, stepSecs);
  const u2 = underlyingAgo(ring, nowMs, stepSecs * 2);
  const u3 = underlyingAgo(ring, nowMs, stepSecs * 3);
  if (![u0, u1, u2, u3].every(Number.isFinite)) return null;
  const d1 = u0 - u1;
  const d2 = u1 - u2;
  const d3 = u2 - u3;
  const meanSq = (d1 * d1 + d2 * d2 + d3 * d3) / (3 * stepSecs);
  const sigma = Math.sqrt(meanSq);
  return sigma > 0 ? sigma : null;
}

export function createMidRing(maxSecs = 30) {
  return { maxSecs, pts: [] };
}

export function pushMid(ring, ts, mid) {
  if (!Number.isFinite(mid) || !Number.isFinite(ts)) return;
  ring.pts.push({ ts, mid });
  const cutoff = ts - ring.maxSecs * 1000;
  while (ring.pts.length && ring.pts[0].ts < cutoff) ring.pts.shift();
}

export function midDropSince(ring, nowMs, secsAgo = 15) {
  const target = nowMs - secsAgo * 1000;
  let then = null;
  let bestDt = Infinity;
  for (const p of ring.pts) {
    const dt = Math.abs(p.ts - target);
    if (dt < bestDt) {
      bestDt = dt;
      then = p;
    }
  }
  if (!then || bestDt > 5000) return null;
  const now = ring.pts.at(-1);
  if (!now) return null;
  return then.mid - now.mid; // positivo = mid caiu
}

export function createState(params = {}) {
  const p = { ...CHAMPION, ...params };
  return {
    params: p,
    mode: 'idle', // idle | entered | settled | blocked
    side: null,
    ask: null,
    bid: null,
    fillPx: null,
    shares: 0,
    fee: 0,
    cost: 0,
    edge: null,
    z: null,
    pPhys: null,
    dist: null,
    tauAtEntry: null,
    enteredAt: null,
    blocks: [],
    blockCounts: {},
    signals: [],
    winner: null,
    pnl: null,
  };
}

function tally(st, reason, detail = {}) {
  st.blockCounts[reason] = (st.blockCounts[reason] || 0) + 1;
  if (st.blocks.length < 80) st.blocks.push({ reason, ...detail, ts: Date.now() });
}

function bestAskSize(bookSide) {
  const lvl = bookSide?.asks?.[0];
  if (!lvl) return null;
  const s = Number(lvl.size);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * Avalia entrada mode 3. Retorna intent ou null.
 * @param {object} book { UP:{bestAsk,bestBid,asks}, DOWN:... }
 */
export function tryEntry(st, { btc, ptb, tau, book, spotAgeMs, ring, midRing, nowMs }) {
  if (st.mode !== 'idle') return null;
  const p = st.params;
  if (tau == null || tau < p.minSecondsLeft || tau > p.maxSecondsLeft) return null;
  if (spotAgeMs != null && spotAgeMs > p.maxSpotAgeMs) {
    tally(st, 'SPOT_STALE', { spotAgeMs });
    return null;
  }
  if (!Number.isFinite(btc) || !Number.isFinite(ptb)) {
    tally(st, 'NO_SPOT_PTB');
    return null;
  }

  const dist = Math.abs(btc - ptb);
  if (dist < p.minDistAbs || dist > p.maxDistAbs) {
    tally(st, 'DIST', { dist });
    return null;
  }

  const fav = btc > ptb ? 'UP' : 'DOWN';
  const ask = book[fav]?.bestAsk;
  const bid = book[fav]?.bestBid;
  const opp = fav === 'UP' ? 'DOWN' : 'UP';
  const oppAsk = book[opp]?.bestAsk;
  if (ask == null || bid == null || oppAsk == null) {
    tally(st, 'BOOK_NULL');
    return null;
  }

  const oddsSum = ask + oppAsk;
  if (oddsSum < p.minOddsSum || oddsSum > p.maxOddsSum) {
    tally(st, 'ODDS_SUM', { oddsSum });
    return null;
  }
  if (ask < p.minAsk || ask > p.maxAsk) {
    tally(st, 'ASK_BAND', { ask, fav });
    return null;
  }
  if (ask - bid > p.maxSpread) {
    tally(st, 'SPREAD', { spread: ask - bid });
    return null;
  }

  const sigma = volPerSecond(ring, nowMs, p.volStepSecs);
  if (sigma == null || !(sigma > 0) || !(tau > 0)) {
    tally(st, 'NO_VOL');
    return null;
  }
  const z = dist / (sigma * Math.sqrt(tau));
  const pPhys = normalCdf(z);
  const edge = pPhys - ask;
  if (edge < p.minEdge) {
    tally(st, 'EDGE', { edge, pPhys, ask, z });
    return null;
  }

  if (p.antiFlipEnabled && midRing) {
    const drop = midDropSince(midRing, nowMs, 15);
    if (drop != null && drop >= p.antiFlipMidDrop && z <= p.antiFlipMaxZ && ask <= p.antiFlipMaxAsk) {
      tally(st, 'ANTI_FLIP', { drop, z, ask });
      return null;
    }
  }

  const depth = bestAskSize(book[fav]);
  const budget = p.entryBudget;
  const limitPx = Math.min(0.99, ask + p.entrySlippageMax);
  const targetShares = budget / limitPx;
  if (depth != null && depth / targetShares < p.minLiquidityRatio) {
    tally(st, 'LIQUIDITY', { depth, need: targetShares * p.minLiquidityRatio });
    return null;
  }

  return {
    action: 'enter',
    side: fav,
    ask,
    bid,
    limitPx,
    targetShares,
    depth,
    edge,
    z,
    pPhys,
    dist,
    tau,
    sigma,
    oddsSum,
  };
}

/**
 * Simula fill dry.
 * fillMode: honest | cruel
 * cruel = +1¢ slip + depth cap + latência já aplicada pelo caller.
 */
export function applyDryFill(st, intent, fillMode = 'honest') {
  const p = st.params;
  let px = intent.ask;
  let sh = intent.targetShares;
  if (fillMode === 'cruel') {
    px = Math.min(intent.limitPx, intent.ask + 0.01);
    if (intent.depth != null) sh = Math.min(sh, intent.depth);
  }
  if (!(sh > 0) || !(px > 0)) {
    tally(st, 'FILL_ZERO');
    return { ok: false };
  }
  const fee = feeEst(px, sh, p.feeRate);
  st.mode = 'entered';
  st.side = intent.side;
  st.ask = intent.ask;
  st.bid = intent.bid;
  st.fillPx = px;
  st.shares = sh;
  st.fee = fee;
  st.cost = sh * px;
  st.edge = intent.edge;
  st.z = intent.z;
  st.pPhys = intent.pPhys;
  st.dist = intent.dist;
  st.tauAtEntry = intent.tau;
  st.enteredAt = Date.now();
  st.signals.push({ ...intent, fillPx: px, shares: sh, fee, fillMode, ts: st.enteredAt });
  return { ok: true, px, sh, fee };
}

export function settle(st, winner) {
  if (st.mode !== 'entered') return null;
  st.winner = winner;
  st.mode = 'settled';
  const payout =
    winner === st.side ? st.shares * st.params.settleWinnerPrice : 0;
  st.pnl = Math.round((payout - st.cost - st.fee) * 10000) / 10000;
  return st.pnl;
}

export function summarize(st) {
  return {
    mode: st.mode,
    side: st.side,
    ask: st.ask,
    fillPx: st.fillPx,
    shares: st.shares != null ? Math.round(st.shares * 1000) / 1000 : 0,
    cost: st.cost != null ? Math.round(st.cost * 100) / 100 : 0,
    fee: st.fee != null ? Math.round(st.fee * 1000) / 1000 : 0,
    edge: st.edge,
    z: st.z,
    pPhys: st.pPhys,
    dist: st.dist,
    tauAtEntry: st.tauAtEntry,
    winner: st.winner,
    pnl: st.pnl,
    blockCounts: st.blockCounts,
  };
}
