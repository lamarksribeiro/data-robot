/**
 * Hyperion V4 Terminal — lógica de sinal + fill simulado (dry/shadow).
 * Port do GLS hyperionV1.gls + preset btc-hyperion-terminal-v4.
 * Sem OBI / cross-event (params mortos no GLS).
 */

export const CHAMPION = {
  id: 'btc-hyperion-terminal-v4',
  walletSize: 100,
  maxOrderValue: 15,
  minShares: 5,
  /** Terminal: só últimos 60s. */
  entryWindowStart: 60,
  entryWindowEnd: 5,
  minAsk: 0.5,
  maxAsk: 0.82,
  minEdge: 0.1,
  minJumpIntensity: 0.5,
  jumpSigma: 45.0,
  maxSpread: 0.05,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
  settleWinnerPrice: 0.995,
  feeRate: 0.07,
  maxSpotAgeMs: 2000,
  volWindowSecs: 30,
};

export const CHAMPION_SCALPER_V5 = {
  id: 'btc-hyperion-scalper-v5',
  walletSize: 100,
  maxOrderValue: 30,
  minShares: 5,
  /** Multi-Entrada Scalpe: toda a vela (295s a 20s) */
  entryWindowStart: 295,
  entryWindowEnd: 20,
  maxTradesPerEvent: 4,
  cooldownSec: 8,
  minSpikeAbs: 20.0,
  minAsk: 0.15,
  maxAsk: 0.70,
  targetLimit1Cents: 0.08,
  targetLimit2Cents: 0.14,
  maxHoldTimeSec: 20,
  stopLossPct: 0.15,
  maxSpread: 0.08,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.75,
  settleWinnerPrice: 0.995,
  feeRate: 0.07,
  maxSpotAgeMs: 2000,
  volWindowSecs: 30,
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

export function pushSample(ring, ts, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(ts)) return;
  ring.pts.push({ ts, spot });
  const cutoff = ts - ring.maxSecs * 1000;
  while (ring.pts.length && ring.pts[0].ts < cutoff) ring.pts.shift();
}

/** σ = stdDev do spot na janela (alinha GLS signals.volatility). */
export function volStdDev(ring, nowMs, windowSecs = 30) {
  const cutoff = nowMs - windowSecs * 1000;
  const vals = [];
  for (const p of ring.pts) {
    if (p.ts >= cutoff) vals.push(p.spot);
  }
  if (vals.length < 2) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((sum, v) => sum + (v - avg) ** 2, 0) / vals.length;
  const sigma = Math.sqrt(variance);
  return Number.isFinite(sigma) ? sigma : null;
}

function availableAskQty(bookSide, maxPrice) {
  const asks = bookSide?.asks;
  if (!Array.isArray(asks) || !asks.length) return 0;
  let total = 0;
  for (const lvl of asks) {
    const px = Number(lvl.price);
    const sz = Number(lvl.size);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;
    if (px > maxPrice) break;
    total += sz;
  }
  return total;
}

export function liquidityRatio(bookSide, budget, maxPrice) {
  const limit = Number(maxPrice);
  if (!(budget > 0) || !(limit > 0)) return 0;
  const qty = availableAskQty(bookSide, limit);
  const needed = budget / Math.max(limit, 0.001);
  return needed > 0 ? qty / needed : 0;
}

export function createState(params = {}) {
  const p = { ...CHAMPION, ...params };
  return {
    params: p,
    mode: 'idle', // idle | entered | settled
    side: null,
    ask: null,
    bid: null,
    fillPx: null,
    shares: 0,
    fee: 0,
    cost: 0,
    edge: null,
    netEdge: null,
    pJump: null,
    dist: null,
    sigma: null,
    tauAtEntry: null,
    enteredAt: null,
    blocks: [],
    blockCounts: {},
    signals: [],
    winner: null,
    pnl: null,
    lastNoEntryReason: null,
  };
}

function tally(st, reason, detail = {}) {
  st.blockCounts[reason] = (st.blockCounts[reason] || 0) + 1;
  st.lastNoEntryReason = reason;
  if (st.blocks.length < 80) st.blocks.push({ reason, ...detail, ts: Date.now() });
}

function bestAskSize(bookSide) {
  const lvl = bookSide?.asks?.[0];
  if (!lvl) return null;
  const s = Number(lvl.size);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * Avalia entrada Hyperion V4 Terminal (GLS + preset). Retorna intent ou null.
 * @param {object} book { UP:{bestAsk,bestBid,asks}, DOWN:... }
 */
export function tryEntry(st, { spot, ptb, tau, book, spotAgeMs, ring, nowMs }) {
  if (st.mode !== 'idle') {
    st.lastNoEntryReason = 'already_in_position';
    return null;
  }
  const p = st.params;
  if (tau == null || tau < p.entryWindowEnd || tau > p.entryWindowStart) {
    st.lastNoEntryReason = 'outside_entry_window';
    return null;
  }
  if (spotAgeMs != null && spotAgeMs > p.maxSpotAgeMs) {
    tally(st, 'SPOT_STALE', { spotAgeMs });
    return null;
  }
  if (!Number.isFinite(spot) || !Number.isFinite(ptb)) {
    tally(st, 'NO_SPOT_PTB');
    return null;
  }

  const distSigned = spot - ptb;
  const rawSigma = volStdDev(ring, nowMs, p.volWindowSecs);
  if (rawSigma == null) {
    tally(st, 'NO_VOL');
    return null;
  }
  const localSigma = Math.max(10, rawSigma);
  const T = Math.max(1, tau) / 300.0;
  const normDist = distSigned / (localSigma * Math.sqrt(T));
  let pJumpUp = normalCdf(normDist);
  if (distSigned > 0) {
    pJumpUp = Math.min(0.99, pJumpUp + p.minJumpIntensity * 0.05);
  } else {
    pJumpUp = Math.max(0.01, pJumpUp - p.minJumpIntensity * 0.05);
  }

  const side = distSigned >= 0 ? 'UP' : 'DOWN';
  const ask = book[side]?.bestAsk;
  const bid = book[side]?.bestBid;
  if (ask == null || bid == null) {
    tally(st, 'BOOK_NULL');
    return null;
  }
  const spread = ask - bid;
  const candidateProb = side === 'UP' ? pJumpUp : 1.0 - pJumpUp;
  const edge = candidateProb - ask;
  const gapCushion = Math.max(0.015, spread * 1.2);
  const netEdge = edge - gapCushion;

  if (ask < p.minAsk || ask > p.maxAsk || spread > p.maxSpread) {
    tally(st, 'PRICE_OR_SPREAD', { ask, spread });
    return null;
  }
  if (netEdge < p.minEdge) {
    tally(st, 'INSUFFICIENT_EDGE', { netEdge, edge, ask, candidateProb });
    return null;
  }

  const budget = Math.min(p.maxOrderValue, p.walletSize);
  const limitPx = Math.min(p.maxAsk, ask + p.entrySlippageMax);
  const liq = liquidityRatio(book[side], budget, limitPx);
  if (liq < p.minLiquidityRatio) {
    tally(st, 'INSUFFICIENT_LIQUIDITY', { liq, need: p.minLiquidityRatio });
    return null;
  }

  const targetShares = Math.max(p.minShares, budget / Math.max(limitPx, 0.001));
  const depth = bestAskSize(book[side]);

  return {
    action: 'enter',
    side,
    ask,
    bid,
    limitPx,
    targetShares,
    depth,
    edge,
    netEdge,
    pJump: candidateProb,
    pJumpUp,
    dist: Math.abs(distSigned),
    distSigned,
    tau,
    sigma: localSigma,
    liq,
    budget,
  };
}

/**
 * Simula fill dry. fillMode: honest | cruel
 */
export function applyDryFill(st, intent, fillMode = 'honest') {
  const p = st.params;
  let px = intent.ask;
  let sh = intent.targetShares;
  if (fillMode === 'cruel') {
    px = Math.min(intent.limitPx, intent.ask + 0.01);
    if (intent.depth != null) sh = Math.min(sh, intent.depth);
  }
  if (!(sh > 0) || !(px > 0) || sh < p.minShares * 0.5) {
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
  st.netEdge = intent.netEdge;
  st.pJump = intent.pJump;
  st.dist = intent.dist;
  st.sigma = intent.sigma;
  st.tauAtEntry = intent.tau;
  st.enteredAt = Date.now();
  st.signals.push({ ...intent, fillPx: px, shares: sh, fee, fillMode, ts: st.enteredAt });
  return { ok: true, px, sh, fee };
}

export function settle(st, winner) {
  if (st.mode !== 'entered') return null;
  st.winner = winner;
  st.mode = 'settled';
  const payout = winner === st.side ? st.shares * st.params.settleWinnerPrice : 0;
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
    netEdge: st.netEdge,
    pJump: st.pJump,
    dist: st.dist,
    sigma: st.sigma,
    tauAtEntry: st.tauAtEntry,
    winner: st.winner,
    pnl: st.pnl,
    lastNoEntryReason: st.lastNoEntryReason,
    blockCounts: st.blockCounts,
  };
}
