/**
 * Binance-lead scalp — setup E (scale-out maker +8/+14).
 * Lógica pura, sem I/O. Espelha o lab data-backtest (variant E).
 *
 * Produção recomendada: VARIANT_E_GOLDEN V2 (sharesCap + cap20 + disaster 25¢ + pre-dump).
 */

export const SIZING_MODES = ['none', 'sharesCap', 'dynamicBudget', 'liqCap'];

export const VARIANT_E = {
  id: 'binance-lead-scalp-e',
  leadSec: 2,
  impulseUsd: 12,
  /** 0 = limiar fixo (impulseUsd); >0 = clamp(mult*σ(Δlead, volWindow), floor, cap) */
  impulseVolMult: 0,
  impulseFloor: 5,
  impulseCap: 12,
  volWindowSec: 300,
  minAsk: 0.15,
  maxAsk: 0.7,
  maxSpread: 0.04,
  staleMidMoveMax: 0.02,
  budget: 10,
  stopLoss: 0.05,
  timeoutSec: 20,
  cooldownSec: 3,
  maxTradesPerEvent: 5,
  minTau: 20,
  maxTau: 280,
  feeRate: 0.07,
  ladderOffsets: [0.08, 0.14],
  maxSpotAgeMs: 2000,
  maxBookAgeMs: 2500,
  /** tick extra exigido no fill maker em modo cruel */
  cruelMakerExtra: 0.01,
  /**
   * Modo resgate: stop/timeout não dumpa; reposiciona ask maker em
   * entryAsk+rescueOffset e segura até o fim do evento. rescueStop>0 = stop-desastre
   * absoluto (dump se bid <= entryAsk - rescueStop); 0 = segura até EOD.
   */
  rescue: false,
  rescueOffset: 0.01,
  rescueStop: 0,
  /**
   * none | sharesCap | dynamicBudget | liqCap
   * sharesCap: min(budget/ask, floor(budget/sharesCapAsk)) — corta oversize em ask barato
   * dynamicBudget: se ask < sharesCapAsk, notional = budget*(ask/sharesCapAsk)
   * liqCap: min(budget/ask, askSz * liqCapMult)
   */
  sizingMode: 'none',
  /** Ask de referência do cap (0.50 = max shares = budget/0.50). */
  sharesCapAsk: 0.5,
  askSizeMult: 0.75,
  liqCapMult: 0.9,
  minShares: 5,
  /**
   * Se bid já fura rescueStop no soft-stop (gap), dump taker imediato
   * em vez de postar rescue maker inútil.
   */
  immediateDisasterDump: true,
  /**
   * Se >0 e entryAsk >= limiar: soft-stop dumpa (ladder_stop) em vez de rescue.
   * Timeout ainda resgata. Corta disasters −25¢ em ask já caro (V2.1).
   */
  noRescueAboveAsk: 0,
  /** Aborta fill se ask no fill > intent.ask + maxEntrySlip (dry cruel / live). 0 = off. */
  maxEntrySlip: 0,
  /** Soft-stop com 0 fills → dump (lab off; A/B V2.3 falhou). */
  noRescueIfNoFill: false,
  /** Em rescue, dump após N segundos sem fill completo. 0 = off. */
  rescueMaxHoldSec: 0,
};

/** E-freq: limiar fixo $8 (lab GO mai–jun). */
export const VARIANT_E_FREQ = {
  ...VARIANT_E,
  id: 'binance-lead-scalp-e-freq',
  impulseUsd: 8,
  staleMidMoveMax: 0.03,
};

/**
 * E-adapt: impulso por vol recente + modo resgate (lab GO mai–jun + julho).
 * thr = clamp(2.5 * σ(Δ2s, 5min), $5, $12); stale mid 0.03;
 * rescue: stop/timeout → ask breakeven+1¢ (lab hold: rescueStop=0; live override 0.15).
 */
export const VARIANT_E_ADAPT = {
  ...VARIANT_E,
  id: 'binance-lead-scalp-e-adapt',
  impulseUsd: 8,
  impulseVolMult: 2.5,
  impulseFloor: 5,
  impulseCap: 12,
  volWindowSec: 300,
  staleMidMoveMax: 0.03,
  rescue: true,
  rescueOffset: 0.01,
  rescueStop: 0,
  sizingMode: 'none',
};

/**
 * E-golden V2 — “pato dos ovos de ouro” (shadow/dry default).
 *
 * Mantém o alpha lab (adapt + ladder +8/+14 + rescue) e corrige a armadilha
 * do ask barato + gap de desastre que matou o micro live (−$1.20 forense):
 *   1) sharesCap @ 0.50 → perda max no disaster simétrica em $
 *   2) impulseCap 20    → limiar adaptativo mais seletivo (menos trades ruins)
 *   3) rescueStop 0.25  → disaster folgado vs ds15; menos dumps prematuros
 *   4) immediateDisasterDump → se bid já ≤ entry−25¢, dump sem postar rescue
 *   5) noRescueAboveAsk 0.60 → soft-stop em ask≥60¢ dumpa (−5¢) em vez de
 *      rescue→disaster (−25¢). Lab A/B: +$190 PnL, maxDD $13.69 (melhor).
 *   6) V2.2 sharesCapAsk 0.45 → +$1.2k IS / +$34 OOS (cap45 A/B).
 *   7) maxEntrySlip 0.03 → aborta fill cruel se ask fugiu >3¢ do intent.
 *   8) staleMid 0.04 testado (V2.3) — lab +EV, dry cruel piorou (mais
 *      entradas mid-ask → 2× rescue_stop @0.55/0.56). **Revertido** a 0.03.
 *
 * Lab V2.2 cap45 b5 (mai–jul): PnL +$21.481 · PF 4.80 · maxDD $13.84 · WR 79.3%
 * Lab V2.2 OOS 4d ago: PnL +$608.54 · PF 4.83 · maxDD $5.41
 *
 * Status: RESEARCH / SHADOW-READY — não é autorização de live.
 * Docs: docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md
 *       data-backtest/docs/estrategias/estrategia-definitiva-btc-5m-golden-v2-2026-08-05.md
 */
/**
 * CLS-v1 — Causal Lead Settlement (research dry/shadow).
 * Mesmo lead adaptativo do e-adapt/golden, mas: ask 0.25–0.50, 1 trade/evento,
 * profundidade integral, hold até settlement (sem ladder/rescue/stop).
 * Status: CANDIDATE / HOLD — não é autorização live.
 */
export const VARIANT_E_CLS = {
  ...VARIANT_E_ADAPT,
  id: 'causal-lead-settle-v1',
  impulseCap: 20,
  impulseUsd: 8,
  minAsk: 0.25,
  maxAsk: 0.5,
  maxTradesPerEvent: 1,
  askSizeMult: 1,
  sizingMode: 'sharesCap',
  sharesCapAsk: 0.5,
  rescue: false,
  exitMode: 'settle',
  ladderOffsets: [],
  budget: 5,
  cooldownSec: 0,
};

export const VARIANT_E_GOLDEN = {
  ...VARIANT_E_ADAPT,
  id: 'binance-lead-scalp-e-golden',
  impulseCap: 20,
  sizingMode: 'sharesCap',
  sharesCapAsk: 0.45,
  staleMidMoveMax: 0.03,
  rescue: true,
  rescueOffset: 0.01,
  rescueStop: 0.25,
  immediateDisasterDump: true,
  noRescueAboveAsk: 0.6,
  maxEntrySlip: 0.03,
};

/**
 * Calcula shares a partir de budget, ask e modo de sizing.
 * @param {number} budget
 * @param {number} ask
 * @param {object} cfg
 * @param {number|null} [askSz]
 */
export function sizeShares(budget, ask, cfg = {}, askSz = null) {
  if (!(Number.isFinite(budget) && budget > 0 && Number.isFinite(ask) && ask > 0)) return 0;
  const mode = SIZING_MODES.includes(cfg.sizingMode) ? cfg.sizingMode : 'none';
  const capAsk =
    Number.isFinite(cfg.sharesCapAsk) && cfg.sharesCapAsk > 0 ? cfg.sharesCapAsk : 0.5;
  let shares = budget / ask;
  if (mode === 'sharesCap') {
    const maxShares = Math.floor(budget / capAsk);
    shares = Math.min(shares, maxShares);
  } else if (mode === 'dynamicBudget') {
    const eff = ask < capAsk ? budget * (ask / capAsk) : budget;
    shares = eff / ask;
  } else if (mode === 'liqCap') {
    if (Number.isFinite(askSz) && askSz > 0) {
      shares = Math.min(shares, askSz * (cfg.liqCapMult ?? 0.9));
    }
  }
  // liqCap pode combinar com sharesCap se sizingMode for só um; pipeline live
  // pode chamar sizeShares e depois aplicar liq à parte se precisar.
  return shares;
}

export function feeEst(price, shares, rate = VARIANT_E.feeRate) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

export function createSpotRing(maxSecs = 30) {
  return { maxSecs, pts: [] };
}

/** Segundos mínimos de ring para σ adaptativo (volWindow + lead + folga). */
export function spotRingSecsFor(cfg) {
  const base = 30;
  if (!(cfg?.impulseVolMult > 0)) return base;
  return Math.max(base, (cfg.volWindowSec || 300) + (cfg.leadSec || 2) + 30);
}

/**
 * Limiar de impulso: fixo (impulseUsd) ou adaptativo clamp(mult*σ, floor, cap).
 * σ = desvio-padrão dos retornos leadSec amostrados ~1s na janela volWindowSec.
 * Sem amostras suficientes (≥30) → fallback impulseUsd.
 */
export function impulseThreshold(spotRing, nowMs, cfg) {
  if (!(cfg?.impulseVolMult > 0)) return cfg.impulseUsd;
  const leadMs = cfg.leadSec * 1000;
  const windowSec = cfg.volWindowSec || 300;
  const floor = Number.isFinite(cfg.impulseFloor) ? cfg.impulseFloor : 5;
  const cap = Number.isFinite(cfg.impulseCap) ? cfg.impulseCap : 12;
  const endSec = Math.floor(nowMs / 1000);
  const startSec = endSec - windowSec;
  const rets = [];
  for (let sec = startSec; sec <= endSec; sec++) {
    const ts = sec * 1000;
    const a = spotAt(spotRing, ts);
    const b = spotAt(spotRing, ts - leadMs);
    if (a != null && b != null) rets.push(a - b);
  }
  if (rets.length < 30) return cfg.impulseUsd;
  let sum = 0;
  let sumSq = 0;
  for (const r of rets) {
    sum += r;
    sumSq += r * r;
  }
  const n = rets.length;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const sigma = Math.sqrt(variance);
  return Math.min(cap, Math.max(floor, cfg.impulseVolMult * sigma));
}

export function pushSpot(ring, ts, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(ts)) return;
  ring.pts.push({ ts, spot });
  const cutoff = ts - ring.maxSecs * 1000;
  while (ring.pts.length && ring.pts[0].ts < cutoff) ring.pts.shift();
}

/** Spot mais próximo de targetTs (não no futuro). */
export function spotAt(ring, targetTs) {
  if (!ring?.pts?.length || !Number.isFinite(targetTs)) return null;
  let best = null;
  let bestDt = Infinity;
  for (const p of ring.pts) {
    if (p.ts > targetTs) break;
    const dt = targetTs - p.ts;
    if (dt < bestDt) {
      bestDt = dt;
      best = p.spot;
    }
  }
  // aceitar sample até 400ms atrasado do alvo
  if (best == null || bestDt > 400) return null;
  return best;
}

export function createMidRing(maxSecs = 10) {
  return { maxSecs, pts: [] };
}

export function pushMid(ring, ts, side, mid) {
  if (!Number.isFinite(mid) || !Number.isFinite(ts)) return;
  ring.pts.push({ ts, side, mid });
  const cutoff = ts - ring.maxSecs * 1000;
  while (ring.pts.length && ring.pts[0].ts < cutoff) ring.pts.shift();
}

export function midAt(ring, side, targetTs) {
  if (!ring?.pts?.length || !Number.isFinite(targetTs)) return null;
  let best = null;
  let bestDt = Infinity;
  for (const p of ring.pts) {
    if (p.side !== side) continue;
    if (p.ts > targetTs) continue;
    const dt = targetTs - p.ts;
    if (dt < bestDt) {
      bestDt = dt;
      best = p.mid;
    }
  }
  if (best == null || bestDt > 800) return null;
  return best;
}

function sideBook(book, side) {
  const b = book?.[side];
  return {
    ask: Number(b?.bestAsk),
    bid: Number(b?.bestBid),
    askSz: Number(b?.asks?.[0]?.size),
  };
}

function midOf(book, side) {
  const b = sideBook(book, side);
  if (!Number.isFinite(b.ask) || !Number.isFinite(b.bid)) return null;
  return (b.ask + b.bid) / 2;
}

export function createEventState(params = {}) {
  const p = { ...VARIANT_E, ...params };
  return {
    params: p,
    entryCount: 0,
    cooldownUntilMs: 0,
    pos: null,
    trades: [],
    blocks: [],
    blockCounts: {},
    lastNoEntryReason: null,
    signals: [],
  };
}

function tally(st, reason, detail = {}) {
  st.blockCounts[reason] = (st.blockCounts[reason] || 0) + 1;
  st.lastNoEntryReason = reason;
  if (st.blocks.length < 120) st.blocks.push({ reason, ...detail, ts: Date.now() });
}

function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

function closePosition(st, exitPx, exitFeeExtra, reason, tsMs) {
  const pos = st.pos;
  if (!pos) return null;
  const dumpShares = pos.remaining > 1e-9 ? pos.remaining : 0;
  const proceeds =
    pos.fills.reduce((a, f) => a + f.shares * f.px, 0) + (dumpShares > 0 ? dumpShares * exitPx : 0);
  const exitFee = pos.fills.reduce((a, f) => a + f.fee, 0) + exitFeeExtra;
  const soldShares = pos.fills.reduce((a, f) => a + f.shares, 0) + dumpShares;
  const avgExit = soldShares > 0 ? proceeds / soldShares : exitPx;
  const pnl = round4(proceeds - pos.shares * pos.entryAsk - pos.entryFee - exitFee);
  const makerShares = pos.fills.reduce((a, f) => a + f.shares, 0);
  const trade = {
    side: pos.side,
    entryAsk: pos.entryAsk,
    exitPx: round4(avgExit),
    shares: pos.shares,
    entryFee: round4(pos.entryFee),
    exitFee: round4(exitFee),
    makerExitShares: round4(makerShares),
    takerExitShares: round4(dumpShares),
    pnl,
    holdSec: round4((tsMs - pos.entryTsMs) / 1000),
    reason,
    tauAtEntry: pos.tauAtEntry,
    binRet: pos.binRet,
    entryTsMs: pos.entryTsMs,
    exitTsMs: tsMs,
    ladderFills: pos.fills.length,
    fillMode: pos.fillMode,
  };
  st.trades.push(trade);
  st.pos = null;
  st.cooldownUntilMs = tsMs + st.params.cooldownSec * 1000;
  return trade;
}

/**
 * Tenta fill maker nos níveis resting. fillMode honest|cruel.
 * honest: bid >= limitPx
 * cruel: bid >= limitPx + cruelMakerExtra (fill mais difícil)
 */
function tryMakerFills(pos, bid, fillMode, cfg) {
  if (!(Number.isFinite(bid) && bid > 0)) return;
  const extra = fillMode === 'cruel' ? cfg.cruelMakerExtra : 0;
  for (const lvl of pos.ladder) {
    if (lvl.filled || pos.remaining <= 1e-9) continue;
    if (bid >= lvl.limitPx + extra) {
      const qty = Math.min(lvl.shares, pos.remaining);
      pos.fills.push({ px: lvl.limitPx, shares: qty, fee: 0, kind: 'maker' });
      pos.remaining -= qty;
      lvl.filled = true;
    }
  }
}

/** Converte a posição em resgate: ladder restante vira ask único breakeven+offset. */
export function enterRescue(pos, cfg, trigger) {
  pos.rescue = true;
  pos.rescueTrigger = trigger;
  pos.rescueAtMs = Date.now();
  pos.ladder = pos.ladder.filter((l) => l.filled);
  const limitPx = Math.round((pos.entryAsk + cfg.rescueOffset) * 100) / 100;
  pos.ladder.push({
    offset: cfg.rescueOffset,
    limitPx,
    shares: pos.remaining,
    filled: false,
  });
  return {
    action: 'rescue',
    trigger,
    side: pos.side,
    entryAsk: pos.entryAsk,
    limitPx,
    remaining: round4(pos.remaining),
    shares: round4(pos.shares),
  };
}

function pastDisaster(entryAsk, bid, cfg) {
  return (
    cfg.rescueStop > 0 &&
    Number.isFinite(bid) &&
    bid > 0 &&
    Number.isFinite(entryAsk) &&
    bid <= entryAsk - cfg.rescueStop
  );
}

function dumpAtBid(st, bid, reason, nowMs) {
  const rem = st.pos?.remaining ?? 0;
  const exitFee = rem > 0 ? feeEst(bid, rem, st.params.feeRate) : 0;
  return closePosition(st, bid, exitFee, reason, nowMs);
}

/**
 * Gerencia posição aberta.
 * Retorna trade fechado, evento {action:'rescue',...}, ou null.
 */
export function managePosition(st, { book, nowMs, fillMode = 'honest', skipMaker = false }) {
  const pos = st.pos;
  if (!pos) return null;
  const cfg = st.params;
  // CLS / settlement: segura até o fim do evento — sem ladder, rescue ou stop.
  if (cfg.exitMode === 'settle') return null;
  const b = sideBook(book, pos.side);
  const bid = b.bid;
  const holdSec = (nowMs - pos.entryTsMs) / 1000;
  const immedDump = cfg.immediateDisasterDump !== false;

  if (!skipMaker) tryMakerFills(pos, bid, fillMode, cfg);
  if (pos.remaining <= 1e-9) {
    return closePosition(st, 0, 0, pos.rescue ? 'rescue_full' : 'ladder_full', nowMs);
  }

  if (pos.rescue) {
    if (pastDisaster(pos.entryAsk, bid, cfg)) {
      return dumpAtBid(st, bid, 'rescue_stop', nowMs);
    }
    if (
      cfg.rescueMaxHoldSec > 0 &&
      Number.isFinite(bid) &&
      bid > 0 &&
      holdSec >= cfg.rescueMaxHoldSec
    ) {
      return dumpAtBid(st, bid, 'rescue_timeout', nowMs);
    }
    return null;
  }

  // Gap: bid já furou disaster sem passar por rescue — dump imediato (não posta maker).
  if (immedDump && pastDisaster(pos.entryAsk, bid, cfg)) {
    return dumpAtBid(st, bid, 'rescue_stop', nowMs);
  }

  if (Number.isFinite(bid) && bid > 0) {
    if (bid <= pos.entryAsk - cfg.stopLoss) {
      // Soft-stop já em zona de desastre → dump, não rescue.
      if (immedDump && pastDisaster(pos.entryAsk, bid, cfg)) {
        return dumpAtBid(st, bid, 'rescue_stop', nowMs);
      }
      // Ask caro: soft-stop dumpa (−5¢) em vez de rescue→disaster (−25¢).
      const noRescueHigh =
        Number.isFinite(cfg.noRescueAboveAsk) &&
        cfg.noRescueAboveAsk > 0 &&
        pos.entryAsk >= cfg.noRescueAboveAsk;
      const noRescueNoFill = cfg.noRescueIfNoFill && !(pos.fills?.length > 0);
      if (noRescueHigh || noRescueNoFill) {
        return dumpAtBid(st, bid, 'ladder_stop', nowMs);
      }
      if (cfg.rescue) return enterRescue(pos, cfg, 'stop');
      return dumpAtBid(st, bid, 'ladder_stop', nowMs);
    }
    if (holdSec >= cfg.timeoutSec) {
      if (cfg.rescue) return enterRescue(pos, cfg, pos.fills.length ? 'timeout_partial' : 'timeout');
      const reason = pos.fills.length ? 'ladder_timeout_partial' : 'ladder_timeout';
      return dumpAtBid(st, bid, reason, nowMs);
    }
  } else if (holdSec >= cfg.timeoutSec) {
    if (cfg.rescue) return enterRescue(pos, cfg, 'timeout_nobid');
    const px = pos.entryAsk;
    const rem = pos.remaining;
    const exitFee = rem > 0 ? feeEst(px, rem, cfg.feeRate) : 0;
    return closePosition(st, px, exitFee, 'ladder_timeout_nobid', nowMs);
  }
  return null;
}

/**
 * Avalia entrada. Retorna intent ou null.
 */
export function tryEntry(st, { spotRing, midRing, book, tau, nowMs, spotAgeMs, bookAgeMs }) {
  if (st.pos) {
    st.lastNoEntryReason = 'in_position';
    return null;
  }
  const cfg = st.params;
  if (st.entryCount >= cfg.maxTradesPerEvent) {
    tally(st, 'MAX_TRADES');
    return null;
  }
  if (nowMs < st.cooldownUntilMs) {
    tally(st, 'COOLDOWN');
    return null;
  }
  if (tau < cfg.minTau || tau > cfg.maxTau) {
    tally(st, 'OUTSIDE_TAU', { tau });
    return null;
  }
  if (spotAgeMs != null && spotAgeMs > cfg.maxSpotAgeMs) {
    tally(st, 'SPOT_STALE', { spotAgeMs });
    return null;
  }
  if (bookAgeMs != null && bookAgeMs > cfg.maxBookAgeMs) {
    tally(st, 'BOOK_STALE', { bookAgeMs });
    return null;
  }

  const spotNow = spotAt(spotRing, nowMs);
  const spotPrev = spotAt(spotRing, nowMs - cfg.leadSec * 1000);
  if (spotNow == null || spotPrev == null) {
    tally(st, 'NO_SPOT_HISTORY');
    return null;
  }
  const binRet = spotNow - spotPrev;
  const impulseMin = impulseThreshold(spotRing, nowMs, cfg);
  if (Math.abs(binRet) < impulseMin) {
    tally(st, 'NO_IMPULSE', { binRet, impulseMin });
    return null;
  }

  const side = binRet > 0 ? 'UP' : 'DOWN';
  const b = sideBook(book, side);
  if (!Number.isFinite(b.ask) || !Number.isFinite(b.bid)) {
    tally(st, 'BOOK_NULL');
    return null;
  }
  if (b.ask < cfg.minAsk || b.ask > cfg.maxAsk) {
    tally(st, 'ASK_RANGE', { ask: b.ask });
    return null;
  }
  const spread = b.ask - b.bid;
  if (!(spread >= 0) || spread > cfg.maxSpread) {
    tally(st, 'SPREAD', { spread });
    return null;
  }

  const midNow = midOf(book, side);
  const midPrev = midAt(midRing, side, nowMs - cfg.leadSec * 1000);
  if (midNow != null && midPrev != null && Math.abs(midNow - midPrev) > cfg.staleMidMoveMax) {
    tally(st, 'MID_NOT_STALE', { midNow, midPrev, move: midNow - midPrev });
    return null;
  }

  const shares = sizeShares(cfg.budget, b.ask, cfg, b.askSz);
  if (!(shares > 0)) {
    tally(st, 'BAD_SHARES');
    return null;
  }
  const minSh = cfg.minShares ?? 5;
  if (shares + 1e-9 < minSh) {
    tally(st, 'BELOW_MIN_SHARES', { shares, minSh });
    return null;
  }
  const needSz = shares * (cfg.askSizeMult ?? 0.75);
  if (Number.isFinite(b.askSz) && b.askSz > 0 && b.askSz < needSz) {
    tally(st, 'ASK_SIZE', { askSz: b.askSz, need: needSz });
    return null;
  }

  return {
    action: 'enter',
    side,
    ask: b.ask,
    bid: b.bid,
    shares,
    binRet: round4(binRet),
    impulseMin: round4(impulseMin),
    tau: Math.round(tau),
    spotNow,
    spotPrev,
  };
}

/**
 * Registra fill maker externo (CLOB getOrder) sem depender do cruzamento do bid.
 * px = preço real do trade; limitPx opcional para casar o nível da ladder.
 */
export function applyExternalMakerFill(st, px, shares, opts = {}) {
  const pos = st.pos;
  if (!pos || !(shares > 0) || pos.remaining <= 1e-9) return 0;
  const qty = Math.min(shares, pos.remaining);
  pos.fills.push({ px, shares: qty, fee: 0, kind: 'maker' });
  pos.remaining -= qty;
  const matchPx = Number.isFinite(opts.limitPx) ? opts.limitPx : px;
  for (const lvl of pos.ladder) {
    if (lvl.filled) continue;
    if (Math.abs(lvl.limitPx - matchPx) > 1e-9) continue;
    lvl.matched = (lvl.matched || 0) + qty;
    if (lvl.matched + 1e-9 >= lvl.shares) lvl.filled = true;
    break;
  }
  return qty;
}

export function closeOpenPosition(st, exitPx, exitFeeExtra, reason, tsMs) {
  return closePosition(st, exitPx, exitFeeExtra, reason, tsMs);
}

/**
 * Aplica fill de entrada taker + coloca ladder maker.
 * fillShares/fillAsk opcionais para live (fill real CLOB).
 */
export function applyEntryFill(
  st,
  intent,
  {
    fillMode = 'honest',
    fillAsk = null,
    fillShares = null,
    nowMs,
    /** Live: shares já compradas — nunca rejeitar por range (dump falho = -$budget). */
    acceptSlippedAsk = false,
  },
) {
  if (st.pos) return { ok: false, reason: 'already_in' };
  const cfg = st.params;
  const maxSlip = Number(cfg.maxEntrySlip);
  if (
    Number.isFinite(maxSlip) &&
    maxSlip > 0 &&
    Number.isFinite(fillAsk) &&
    fillAsk > 0 &&
    Number.isFinite(intent?.ask) &&
    fillAsk > intent.ask + maxSlip + 1e-9
  ) {
    return { ok: false, reason: 'ask_slipped_too_far' };
  }
  let ask =
    fillMode === 'cruel' && Number.isFinite(fillAsk) && fillAsk > 0
      ? Math.max(intent.ask, fillAsk)
      : Number.isFinite(fillAsk) && fillAsk > 0
        ? fillAsk
        : intent.ask;
  if (ask < cfg.minAsk || ask > cfg.maxAsk) {
    if (!acceptSlippedAsk) return { ok: false, reason: 'ask_slipped_out' };
    // Já somos donos do inventário: aceita e usa intent.ask só se fill vier absurdo.
    if (!(ask > 0 && ask < 1)) ask = intent.ask;
  }
  const shares =
    Number.isFinite(fillShares) && fillShares > 0
      ? fillShares
      : Number.isFinite(intent?.shares) && intent.shares > 0
        ? intent.shares
        : sizeShares(cfg.budget, ask, cfg);
  const entryFee = feeEst(ask, shares, cfg.feeRate);
  const offsets = Array.isArray(cfg.ladderOffsets) ? cfg.ladderOffsets : [];
  let ladder;
  if (shares + 1e-9 < 5) {
    return { ok: false, reason: 'below_min_shares' };
  }
  if (offsets.length === 0 || cfg.exitMode === 'settle') {
    ladder = [];
  } else if (offsets.length > 1 && shares + 1e-9 < 5 * offsets.length) {
    // CLOB min 5/ordem: consolida em um nível (+primeiro offset)
    ladder = [
      {
        offset: offsets[0],
        limitPx: Math.round((ask + offsets[0]) * 100) / 100,
        shares,
        filled: false,
        matched: 0,
      },
    ];
  } else {
    const nLvl = offsets.length;
    const perLvl = Math.floor((shares / nLvl) * 100) / 100;
    ladder = offsets.map((off, i) => {
      const sh = i === nLvl - 1 ? round4(shares - perLvl * (nLvl - 1)) : perLvl;
      return {
        offset: off,
        limitPx: Math.round((ask + off) * 100) / 100,
        shares: sh,
        filled: false,
        matched: 0,
      };
    });
  }
  st.pos = {
    side: intent.side,
    entryAsk: ask,
    entryBid: intent.bid,
    shares,
    remaining: shares,
    fills: [],
    ladder,
    entryFee,
    entryTsMs: nowMs,
    tauAtEntry: intent.tau,
    binRet: intent.binRet,
    fillMode,
  };
  st.entryCount += 1;
  st.signals.push({
    ts: nowMs,
    side: intent.side,
    ask,
    binRet: intent.binRet,
    tau: intent.tau,
  });
  return { ok: true, ask, shares, entryFee, ladder: st.pos.ladder.map((l) => ({ ...l })) };
}

/** Force-close residual no fim do evento. */
export function forceCloseEod(st, book, nowMs) {
  if (!st.pos) return null;
  if (st.params.exitMode === 'settle') {
    throw new Error('forceCloseEod: use forceCloseSettle quando exitMode=settle');
  }
  const b = sideBook(book, st.pos.side);
  const exitPx = Number.isFinite(b.bid) && b.bid > 0 ? b.bid : st.pos.entryAsk;
  const rem = st.pos.remaining;
  const exitFee = rem > 0 ? feeEst(exitPx, rem, st.params.feeRate) : 0;
  const reason = st.pos.rescue
    ? 'rescue_eod'
    : st.pos.fills.length
      ? 'ladder_eod_partial'
      : 'ladder_eod';
  return closePosition(st, exitPx, exitFee, reason, nowMs);
}

/**
 * Settlement binário: exit 1 se ganhou o lado, 0 se perdeu. Fee só na entrada.
 */
export function forceCloseSettle(st, { won, nowMs, winner = null }) {
  if (!st.pos) return null;
  const exitPx = won ? 1 : 0;
  const trade = closePosition(
    st,
    exitPx,
    0,
    won ? 'settle_win' : 'settle_loss',
    nowMs,
  );
  if (trade && winner) trade.winner = winner;
  return trade;
}

export function summarize(st) {
  const trades = st.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const fees = trades.reduce((a, t) => a + t.entryFee + t.exitFee, 0);
  const entryFees = trades.reduce((a, t) => a + t.entryFee, 0);
  const exitFees = trades.reduce((a, t) => a + t.exitFee, 0);
  const makerExitShares = trades.reduce((a, t) => a + (t.makerExitShares || 0), 0);
  const takerExitShares = trades.reduce((a, t) => a + (t.takerExitShares || 0), 0);
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  return {
    variant: st.params.id,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Math.round((1000 * wins.length) / trades.length) / 10 : null,
    totalPnl: round4(totalPnl),
    lucroBruto: round4(totalPnl + fees),
    fees: round4(fees),
    entryFees: round4(entryFees),
    exitFees: round4(exitFees),
    lucroLiquido: round4(totalPnl),
    profitFactor: grossLossAbs > 0 ? round4(grossProfit / grossLossAbs) : wins.length ? Infinity : null,
    feeDrag:
      Math.abs(grossProfit) + grossLossAbs > 0
        ? round4(fees / (Math.abs(grossProfit) + grossLossAbs))
        : null,
    makerExitSharePct:
      makerExitShares + takerExitShares > 0
        ? Math.round((1000 * makerExitShares) / (makerExitShares + takerExitShares)) / 10
        : null,
    avgHoldSec:
      trades.length > 0
        ? round4(trades.reduce((a, t) => a + t.holdSec, 0) / trades.length)
        : null,
    exitReasons: byReason,
    blockCounts: { ...st.blockCounts },
    lastNoEntryReason: st.lastNoEntryReason,
    openPos: st.pos
      ? {
          side: st.pos.side,
          entryAsk: st.pos.entryAsk,
          remaining: round4(st.pos.remaining),
          rescue: !!st.pos.rescue,
          rescueTrigger: st.pos.rescueTrigger || null,
          ladder: st.pos.ladder.map((l) => ({
            limitPx: l.limitPx,
            filled: l.filled,
          })),
        }
      : null,
  };
}
