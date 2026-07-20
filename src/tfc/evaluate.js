/**
 * Avaliação pura TFC V7 (sem SDK, rede, env ou filesystem).
 * Espelha TerminalFavoriteCarry.gls + btc-champion-v7.
 */

export function favoriteSide(btc, priceToBeat) {
  if (!Number.isFinite(btc) || !Number.isFinite(priceToBeat)) return null;
  return btc >= priceToBeat ? 'UP' : 'DOWN';
}

export function oppositeSide(side) {
  if (side === 'UP') return 'DOWN';
  if (side === 'DOWN') return 'UP';
  return null;
}

/**
 * Distância sinalizada a favor da posição.
 * UP: btc - ptb; DOWN: ptb - btc. Cruzamento contra = <= lateFlipExitCrossDist.
 */
export function signedDistance(side, btc, priceToBeat) {
  if (!side || !Number.isFinite(btc) || !Number.isFinite(priceToBeat)) return null;
  return side === 'DOWN' ? priceToBeat - btc : btc - priceToBeat;
}

export function orderBookImbalance(side, book, levels = 5) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  let bidQty = 0;
  let askQty = 0;
  const bids = book?.[prefix]?.bids ?? [];
  const asks = book?.[prefix]?.asks ?? [];
  for (let i = 0; i < Math.min(levels, bids.length); i++) bidQty += bids[i]?.size ?? 0;
  for (let i = 0; i < Math.min(levels, asks.length); i++) askQty += asks[i]?.size ?? 0;
  const sum = bidQty + askQty;
  return sum > 0 ? (bidQty - askQty) / sum : 0;
}

export function spotVelocity(history, lookbackSecs, nowMs) {
  if (!history?.length) return null;
  const cutoff = nowMs - lookbackSecs * 1000;
  const past = [...history].reverse().find((h) => h.ts <= cutoff);
  if (!past || !Number.isFinite(past.btc)) return null;
  return { pastBtc: past.btc, change: history[history.length - 1].btc - past.btc };
}

/**
 * σ populacional do spot nos últimos `lookbackSecs` (paridade GLS signals.volatility).
 */
export function spotVolatility(history, lookbackSecs, nowMs) {
  if (!history?.length) return 0;
  const cutoff = nowMs - Number(lookbackSecs) * 1000;
  const values = history.filter((h) => h.ts >= cutoff && Number.isFinite(h.btc)).map((h) => h.btc);
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
}

/**
 * Contagem de flips do favorito no lookback (minFlips V7 = 0 → sempre passa).
 */
export function ptbFlipCount(history, lookbackSecs, nowMs, priceToBeat) {
  if (!history?.length || !Number.isFinite(priceToBeat)) return 0;
  const cutoff = nowMs - lookbackSecs * 1000;
  const recent = history.filter((h) => h.ts >= cutoff && Number.isFinite(h.btc));
  let flips = 0;
  let prev = null;
  for (const h of recent) {
    const fav = favoriteSide(h.btc, priceToBeat);
    if (prev && fav && prev !== fav) flips += 1;
    if (fav) prev = fav;
  }
  return flips;
}

/**
 * @returns {{ ok: boolean, fav: string|null, gates: Record<string, { pass: boolean, detail?: string }>, ask: number|null, bid: number|null }}
 */
export function evaluateEntryGates(snapshot, params, history = []) {
  const gates = {};
  const { btc, priceToBeat, secsLeft, book } = snapshot;

  gates.terminalWindow = {
    pass: secsLeft >= params.minSecondsLeft && secsLeft < params.maxSecondsLeft,
    detail: `secsLeft=${secsLeft?.toFixed?.(1) ?? secsLeft ?? '?'}`,
  };

  const dist = Number.isFinite(btc) && Number.isFinite(priceToBeat) ? Math.abs(btc - priceToBeat) : null;
  gates.distance = {
    pass: dist != null && dist < params.maxDistAbs,
    detail: dist != null ? `|btc-ptb|=${dist.toFixed(2)}` : 'btc/ptb indisponível',
  };

  const flips = ptbFlipCount(history, params.flipWindowSecs ?? 60, snapshot.nowMs, priceToBeat);
  const minFlips = params.minFlips ?? 0;
  gates.flips = {
    pass: flips >= minFlips,
    detail: `flips=${flips} min=${minFlips}`,
  };

  const fav = favoriteSide(btc, priceToBeat);
  const ask = fav ? book?.[fav.toLowerCase()]?.bestAsk : null;
  const bid = fav ? book?.[fav.toLowerCase()]?.bestBid : null;

  gates.favoriteSide = { pass: !!fav, detail: fav ?? 'n/a' };

  gates.askBand = {
    pass: ask != null && ask >= params.minAsk && ask <= params.maxAsk,
    detail: ask != null ? `ask=${ask.toFixed(3)}` : 'ask indisponível',
  };

  const spread = ask != null && bid != null ? ask - bid : null;
  gates.spread = {
    pass: spread != null && spread <= params.maxSpread,
    detail: spread != null ? `spread=${spread.toFixed(3)}` : 'spread indisponível',
  };

  const upAsk = book?.up?.bestAsk;
  const downAsk = book?.down?.bestAsk;
  const oddsSum = upAsk != null && downAsk != null ? upAsk + downAsk : null;
  gates.oddsSum = {
    pass: oddsSum != null && oddsSum >= params.minOddsSum && oddsSum <= params.maxOddsSum,
    detail: oddsSum != null ? `sum=${oddsSum.toFixed(3)}` : 'odds indisponíveis',
  };

  const vel = spotVelocity(history, params.velocityLookbackSecs, snapshot.nowMs);
  let adverse = false;
  if (vel && fav) {
    if (fav === 'UP' && vel.change < -params.maxAdverseSpotChange) adverse = true;
    if (fav === 'DOWN' && vel.change > params.maxAdverseSpotChange) adverse = true;
  }
  gates.velocity = {
    pass: !adverse,
    detail: vel ? `Δ${vel.change.toFixed(2)} em ${params.velocityLookbackSecs}s` : 'histórico insuficiente',
  };

  const obi = fav ? orderBookImbalance(fav, book, params.obiLevels) : null;
  gates.obi = {
    pass: obi == null || obi >= params.minObi,
    detail: obi != null ? `obi=${obi.toFixed(3)}` : 'book shallow',
  };

  const ok = Object.values(gates).every((g) => g.pass);

  return { ok, fav, gates, ask, bid, dist, oddsSum, spread, obi, flips };
}

export function evaluateLateFlip(snapshot, params, positionSide) {
  const { btc, priceToBeat, secsLeft, book } = snapshot;
  if (!positionSide) return { active: false, signedDistance: null };

  const dist = signedDistance(positionSide, btc, priceToBeat);
  const bid = book?.[positionSide.toLowerCase()]?.bestBid;
  const inWindow = secsLeft <= params.lateFlipExitSec && secsLeft >= params.lateFlipMinSec;
  const crossed = dist != null && dist <= params.lateFlipExitCrossDist;
  const bidOk = bid != null && bid >= params.stopMinBid;

  return {
    active: Boolean(inWindow && crossed && bidOk),
    signedDistance: dist,
    secsLeft,
    bid,
    hedgeStopWindow:
      params.hedgeStopPlaceSec != null &&
      secsLeft <= params.hedgeStopPlaceSec &&
      secsLeft >= params.lateFlipMinSec,
  };
}

/**
 * Late flip → REVERSE (preferido) ou EXIT.
 */
export function evaluateLateFlipAction(snapshot, params, positionSide, strategyState = {}) {
  const base = evaluateLateFlip(snapshot, params, positionSide);
  if (!params.lateFlipExitEnabled || !base.active || strategyState.closed || strategyState.reversed) {
    return { action: null, ...base };
  }

  const oppSide = oppositeSide(positionSide);
  const oppAsk = oppSide ? snapshot.book?.[oppSide.toLowerCase()]?.bestAsk : null;
  const reverseOn = params.lateFlipReverseEnabled === true || params.lateFlipReverseEnabled === 1;
  const askOk =
    oppAsk != null &&
    oppAsk > 0 &&
    oppAsk >= (params.lateFlipReverseMinAsk ?? 0) &&
    oppAsk <= (params.lateFlipReverseMaxAsk ?? 0.95);

  if (reverseOn && !strategyState.reversed && askOk) {
    return {
      action: 'REVERSE',
      oppSide,
      oppAsk,
      exitBid: base.bid,
      reason: 'late_flip_reverse',
      ...base,
    };
  }

  return {
    action: 'EXIT',
    oppSide: null,
    oppAsk: null,
    exitBid: base.bid,
    reason: 'late_flip_exit',
    ...base,
  };
}

/**
 * Danger exit: τ ∈ [floor, floor+1) e |signedDistance| < k × σ(5s).
 */
export function evaluateDangerExit(snapshot, params, positionSide, history = []) {
  if (!params.dangerExitEnabled || !positionSide) {
    return { active: false, signedDistance: null, sigma: null };
  }
  const floor = params.dangerExitFloorSec ?? 4;
  const secsLeft = snapshot.secsLeft;
  const inWindow = secsLeft >= floor && secsLeft < floor + 1;
  const dist = signedDistance(positionSide, snapshot.btc, snapshot.priceToBeat);
  const sigma = spotVolatility(history, 5, snapshot.nowMs);
  const threshold = (params.dangerExitK ?? 0.3) * sigma;
  const bid = snapshot.book?.[positionSide.toLowerCase()]?.bestBid ?? null;
  const bidOk = bid != null && bid >= Number(params.stopMinBid ?? 0);
  const active =
    inWindow &&
    bidOk &&
    dist != null &&
    Number.isFinite(sigma) &&
    Math.abs(dist) < threshold &&
    threshold > 0;

  return {
    active: Boolean(active),
    signedDistance: dist,
    sigma,
    threshold,
    secsLeft,
    bid,
    bidOk,
    reason: 'danger_exit',
  };
}
