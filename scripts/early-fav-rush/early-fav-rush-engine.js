/**
 * Early Favorite Rush — engine (1º toque do favorito cedo → hold settle).
 *
 * Status pesquisa: REJEITADA / HOLD após auditoria causal-canônica
 * (`data-backtest/reports/research/early-favorite-rush-causal-canonical-audit-2026-08-05.md`).
 * Dry/shadow só para observação; não dimensionar capital pelos labs antigos (lookahead).
 *
 * Disaster 0.15 + majority/quorum: mitigação relativa no stack causal — não promovem EV.
 */

export const FEE_RATE = 0.07;
export const SETTLE = 0.995;

/** Presets por asset (janelas operacionais do lab; edge causal não aprovado). */
export const ASSET_RULES = Object.freeze({
  btc: { thr: 0.85, minTau: 60, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  eth: { thr: 0.85, minTau: 90, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  sol: { thr: 0.85, minTau: 60, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  xrp: { thr: 0.85, minTau: 120, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  bnb: { thr: 0.85, minTau: 120, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  doge: { thr: 0.87, minTau: 60, maxTau: 300, requireSpot: true, mode: 'earlyMin' },
  hype: { thr: 0.85, minTau: 180, maxTau: 240, requireSpot: false, mode: 'bucket' },
});

/**
 * Disaster exit: spotFlip ∧ bookFlip ∧ bid≤0.15 ∧ τ≤120.
 * Preferido ao 0.25 (menos falso-stop no stack causal).
 */
export const DISASTER_EXIT = Object.freeze({
  bidMax: 0.15,
  tauMax: 120,
  requireSpotFlip: true,
  requireBookFlip: true,
});

/** Gates cross-asset (mesmo eventStart / epoch 5m). */
export const CROSS_GATES = Object.freeze({
  none: 'none',
  majority: 'majority',
  quorum2: 'quorum2',
});

export function ruleFor(assetKey) {
  const r = ASSET_RULES[String(assetKey || '').toLowerCase()];
  if (!r) throw new Error(`early-fav-rush: sem regra para ${assetKey}`);
  return r;
}

export function normalizeCrossGate(raw) {
  const g = String(raw || CROSS_GATES.majority).toLowerCase();
  if (g === 'none' || g === 'off' || g === '0') return CROSS_GATES.none;
  if (g === 'quorum2' || g === 'quorum' || g === 'peer') return CROSS_GATES.quorum2;
  if (g === 'majority' || g === 'maj') return CROSS_GATES.majority;
  throw new Error(`cross-gate inválido: ${raw} (none|majority|quorum2)`);
}

/**
 * Filtra candidatos do mesmo epoch 5m.
 * @param {{ asset: string, side: string }[]} cands
 * @param {'none'|'majority'|'quorum2'} gate
 */
export function applyCrossGate(cands, gate = CROSS_GATES.majority) {
  if (!Array.isArray(cands) || !cands.length) return [];
  if (gate === CROSS_GATES.none) return cands.slice();
  const up = cands.filter((c) => c.side === 'UP');
  const down = cands.filter((c) => c.side === 'DOWN');
  if (gate === CROSS_GATES.quorum2) {
    const out = [];
    if (up.length >= 2) out.push(...up);
    if (down.length >= 2) out.push(...down);
    return out;
  }
  // majority: empate → zero entradas
  if (up.length === down.length) return [];
  return up.length > down.length ? up : down;
}

export function createEventState() {
  return {
    armed: true,
    entered: false,
    side: null,
    ask: null,
    tauAtEntry: null,
    entryTs: null,
    prevFavAsk: null,
    shares: 0,
    fee: 0,
    feeOut: 0,
    settled: false,
    exitKind: null, // 'settle' | 'disaster'
    exitBid: null,
    exitTau: null,
    pnl: null,
    won: null,
    skipReason: null,
  };
}

function feeEst(price, shares) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return FEE_RATE * p * (1 - p) * shares;
}

function spotSide(spot, ptb) {
  if (spot > ptb) return 'UP';
  if (spot < ptb) return 'DOWN';
  return null;
}

function bookFavSide(upAsk, downAsk) {
  return upAsk >= downAsk ? 'UP' : 'DOWN';
}

/**
 * Avalia entrada no tick atual.
 * @returns {{ enter: boolean, side?: string, ask?: number, tau?: number, reason?: string }}
 */
export function tryEntry(st, tick, rule, budget) {
  if (!st?.armed || st.entered) return { enter: false, reason: 'already' };
  const {
    tau,
    upAsk,
    downAsk,
    spot,
    ptb,
  } = tick;
  if (![tau, upAsk, downAsk, spot, ptb].every(Number.isFinite)) {
    return { enter: false, reason: 'incomplete' };
  }
  if (tau < 3 || tau > 300) return { enter: false, reason: 'tau_out' };

  const favAsk = Math.max(upAsk, downAsk);
  const side = upAsk >= downAsk ? 'UP' : 'DOWN';
  const thr = rule.thr;
  const prev = st.prevFavAsk;
  const crossed = favAsk >= thr && favAsk < 1 && (prev == null || prev < thr);
  st.prevFavAsk = favAsk;

  if (!crossed) return { enter: false, reason: 'no_cross' };

  const inWindow =
    rule.mode === 'bucket'
      ? tau >= rule.minTau && tau < rule.maxTau
      : tau >= rule.minTau && tau < rule.maxTau;
  if (!inWindow) {
    st.skipReason = `cross_outside_window tau=${tau}`;
    st.armed = false; // 1º toque fora da janela — não entra neste evento
    return { enter: false, reason: 'cross_outside_window' };
  }

  if (rule.requireSpot) {
    const ss = spotSide(spot, ptb);
    if (ss !== side) {
      st.skipReason = 'spot_disagree';
      st.armed = false;
      return { enter: false, reason: 'spot_disagree' };
    }
  }

  const ask = favAsk;
  const shares = budget / ask;
  const fee = feeEst(ask, shares);
  st.entered = true;
  st.armed = false;
  st.side = side;
  st.ask = ask;
  st.tauAtEntry = tau;
  st.entryTs = Date.now();
  st.shares = shares;
  st.fee = fee;
  return { enter: true, side, ask, tau };
}

/**
 * Disaster exit: proteção assimétrica pós-entrada.
 * @returns {{ exit: boolean, bid?: number, tau?: number, reason?: string }}
 */
export function tryDisasterExit(st, tick, cfg = DISASTER_EXIT) {
  if (!st?.entered || st.settled) return { exit: false, reason: 'no_pos' };
  const {
    tau,
    upAsk,
    downAsk,
    upBid,
    downBid,
    spot,
    ptb,
  } = tick;
  if (![tau, upAsk, downAsk, spot, ptb].every(Number.isFinite)) {
    return { exit: false, reason: 'incomplete' };
  }
  if (!(tau <= cfg.tauMax)) return { exit: false, reason: 'tau' };

  const bid = st.side === 'UP' ? upBid : downBid;
  if (!Number.isFinite(bid) || bid <= 0 || bid >= 1) {
    return { exit: false, reason: 'no_bid' };
  }
  if (!(bid <= cfg.bidMax)) return { exit: false, reason: 'bid' };

  if (cfg.requireSpotFlip) {
    const ss = spotSide(spot, ptb);
    if (!ss || ss === st.side) return { exit: false, reason: 'spot' };
  }
  if (cfg.requireBookFlip) {
    if (bookFavSide(upAsk, downAsk) === st.side) {
      return { exit: false, reason: 'book' };
    }
  }

  return { exit: true, bid, tau, reason: 'disaster' };
}

/**
 * Fecha no bid (venda taker simulada) — disaster / early exit.
 */
export function exitAtBid(st, bid, tau, budget, kind = 'disaster') {
  if (!st?.entered || st.settled) return null;
  if (!Number.isFinite(bid) || bid <= 0 || bid >= 1) return null;
  const feeOut = feeEst(bid, st.shares);
  const pnl = st.shares * bid - budget - st.fee - feeOut;
  st.settled = true;
  st.exitKind = kind;
  st.exitBid = bid;
  st.exitTau = tau;
  st.feeOut = feeOut;
  st.won = pnl > 0;
  st.pnl = pnl;
  return { won: st.won, pnl, exitBid: bid, exitTau: tau, exitKind: kind };
}

export function settle(st, spot, ptb, budget) {
  if (!st?.entered || st.settled) return null;
  const winner = spotSide(spot, ptb);
  if (!winner) return null;
  const won = st.side === winner;
  const payout = won ? st.shares * SETTLE : 0;
  const pnl = payout - budget - st.fee;
  st.settled = true;
  st.exitKind = 'settle';
  st.won = won;
  st.pnl = pnl;
  return { won, pnl, winner, exitKind: 'settle' };
}

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.won).length;
  const pnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  let gp = 0;
  let gl = 0;
  let disasterExits = 0;
  for (const t of trades) {
    if (t.pnl > 0) gp += t.pnl;
    else if (t.pnl < 0) gl += -t.pnl;
    if (t.exitKind === 'disaster') disasterExits += 1;
  }
  const pf = gl <= 0 ? (gp > 0 ? 999 : null) : gp / gl;
  return {
    trades: n,
    wins,
    winRatePct: n ? Math.round((wins / n) * 10000) / 100 : null,
    pnl: Math.round(pnl * 100) / 100,
    ppt: n ? Math.round((pnl / n) * 10000) / 10000 : null,
    pf: pf == null ? null : Math.round(pf * 1000) / 1000,
    disasterExits,
  };
}
