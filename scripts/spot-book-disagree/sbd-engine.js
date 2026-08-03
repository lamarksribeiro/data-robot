/**
 * Spot×book disagreement (SBD) — sinal + fill dry.
 * Campeã sonda: follow-spot-cheap (comprar spotLeader barato quando book discorda).
 *
 * ATENÇÃO: GLS holdout-week (2026-07-01..07) negativo — dry é observação/shadow, não GO micro.
 */

export const CHAMPION = {
  entryMode: 3, // 1=follow-book 2=follow-spot 3=follow-spot-cheap
  minSecondsLeft: 10,
  maxSecondsLeft: 40,
  maxDistAbs: 15,
  minBookEdge: 0.05,
  maxSpotAsk: 0.4,
  minBookFavAsk: 0.6,
  minAsk: 0.05,
  maxAsk: 0.99,
  maxSpread: 0.04,
  minOddsSum: 0.96,
  maxOddsSum: 1.06,
  entrySlippageMax: 0.02,
  minLiquidityRatio: 0.6,
  entryBudget: 10,
  settleWinnerPrice: 0.995,
  feeRate: 0.07,
  maxSpotAgeMs: 2000,
};

export function feeEst(price, shares, rate = CHAMPION.feeRate) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

export function createState(params = {}) {
  const p = { ...CHAMPION, ...params };
  return {
    params: p,
    mode: 'idle',
    side: null,
    ask: null,
    bid: null,
    fillPx: null,
    shares: 0,
    fee: 0,
    cost: 0,
    dist: null,
    bookEdge: null,
    spotLeader: null,
    bookFavorite: null,
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
 * Avalia SBD. Retorna intent ou null.
 * @param {object} book { UP:{bestAsk,bestBid,asks}, DOWN:... }
 */
export function tryEntry(st, { btc, ptb, tau, book, spotAgeMs }) {
  if (st.mode !== 'idle') return null;
  const p = st.params;
  if (tau == null || tau < p.minSecondsLeft || tau > p.maxSecondsLeft) return null;
  if (spotAgeMs != null && spotAgeMs > p.maxSpotAgeMs) {
    tally(st, 'SPOT_STALE', { spotAgeMs });
    return null;
  }
  if (!Number.isFinite(btc) || !Number.isFinite(ptb) || btc === ptb) {
    tally(st, 'NO_SPOT_PTB');
    return null;
  }

  const dist = Math.abs(btc - ptb);
  if (dist > p.maxDistAbs) {
    tally(st, 'DIST', { dist });
    return null;
  }

  const upAsk = book.UP?.bestAsk;
  const downAsk = book.DOWN?.bestAsk;
  const upBid = book.UP?.bestBid;
  const downBid = book.DOWN?.bestBid;
  if (![upAsk, downAsk].every(Number.isFinite)) {
    tally(st, 'BOOK_NULL');
    return null;
  }

  const spotLeader = btc >= ptb ? 'UP' : 'DOWN';
  const bookFavorite = upAsk >= downAsk ? 'UP' : 'DOWN';
  if (spotLeader === bookFavorite) {
    tally(st, 'AGREE');
    return null;
  }

  const bookFavAsk = bookFavorite === 'UP' ? upAsk : downAsk;
  const spotAsk = spotLeader === 'UP' ? upAsk : downAsk;
  const bookEdge = bookFavAsk - spotAsk;
  if (!(bookEdge >= p.minBookEdge)) {
    tally(st, 'BOOK_EDGE', { bookEdge });
    return null;
  }

  const oddsSum = upAsk + downAsk;
  if (oddsSum < p.minOddsSum || oddsSum > p.maxOddsSum) {
    tally(st, 'ODDS_SUM', { oddsSum });
    return null;
  }

  let side = spotLeader;
  let ask = spotAsk;
  if (p.entryMode === 1) {
    side = bookFavorite;
    ask = bookFavAsk;
  } else if (p.entryMode === 3) {
    if (spotAsk > p.maxSpotAsk || bookFavAsk < p.minBookFavAsk) {
      tally(st, 'CHEAP_GATE', { spotAsk, bookFavAsk });
      return null;
    }
  }

  const bid = side === 'UP' ? upBid : downBid;
  if (!Number.isFinite(bid) || ask - bid > p.maxSpread) {
    tally(st, 'SPREAD', { spread: ask - bid });
    return null;
  }
  if (ask < p.minAsk || ask > p.maxAsk) {
    tally(st, 'ASK_BAND', { ask });
    return null;
  }

  const depth = bestAskSize(book[side]);
  const budget = p.entryBudget;
  const limitPx = Math.min(0.99, ask + p.entrySlippageMax);
  const targetShares = budget / limitPx;
  if (depth != null && depth / targetShares < p.minLiquidityRatio) {
    tally(st, 'LIQUIDITY', { depth, need: targetShares * p.minLiquidityRatio });
    return null;
  }

  return {
    action: 'enter',
    side,
    ask,
    bid,
    limitPx,
    targetShares,
    depth,
    dist,
    bookEdge,
    spotLeader,
    bookFavorite,
    bookFavAsk,
    spotAsk,
    tau,
    oddsSum,
    entryMode: p.entryMode,
  };
}

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
  st.dist = intent.dist;
  st.bookEdge = intent.bookEdge;
  st.spotLeader = intent.spotLeader;
  st.bookFavorite = intent.bookFavorite;
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
    dist: st.dist,
    bookEdge: st.bookEdge,
    spotLeader: st.spotLeader,
    bookFavorite: st.bookFavorite,
    tauAtEntry: st.tauAtEntry,
    winner: st.winner,
    pnl: st.pnl,
    blockCounts: st.blockCounts,
  };
}
