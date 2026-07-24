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

  // minEntryZ (0 = desligado). z físico |dist|/(σ_ps√τ).
  const minZ = Number(params.minEntryZ ?? 0);
  const { z } = physicalZScore(dist ?? 0, history, params, secsLeft, snapshot.nowMs);
  gates.minEntryZ = {
    pass: !(minZ > 0) || z >= minZ,
    detail: `z=${z.toFixed(3)} min=${Number.isFinite(minZ) ? minZ : 0}`,
  };

  const ok = Object.values(gates).every((g) => g.pass);

  return { ok, fav, gates, ask, bid, dist, oddsSum, spread, obi, flips, z };
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

/**
 * z físico MIDAS: |spot−PTB| / (σ_level/divisor × √τ)
 * Paridade strategy.gls midas-carry-v1.
 */
export function physicalZScore(distAbs, history, params, secsLeft, nowMs) {
  const lookback = Number(params.sigmaLookbackSecs ?? 90);
  const divisor = Number(params.sigmaDivisor ?? 5.48);
  const sigmaLevel = spotVolatility(history, lookback, nowMs);
  const sigmaPs = divisor > 0 ? sigmaLevel / divisor : 0;
  if (!(sigmaPs > 0) || !(secsLeft > 0) || !Number.isFinite(distAbs)) {
    return { z: 0, sigmaLevel, sigmaPs };
  }
  const z = distAbs / (sigmaPs * Math.sqrt(secsLeft));
  return { z: Number.isFinite(z) ? z : 0, sigmaLevel, sigmaPs };
}

/**
 * Fator de budget por z-score (sigma sizing). Default wZ2=1 se desligado.
 */
export function sigmaBudgetFactor(z, params) {
  const on = params.sigmaSizingEnabled === true || params.sigmaSizingEnabled === 1;
  if (!on) return 1;
  const zT1 = Number(params.zT1 ?? 0.5);
  const zT2 = Number(params.zT2 ?? 1.0);
  const zT3 = Number(params.zT3 ?? 2.5);
  const zT4 = Number(params.zT4 ?? 4.0);
  const wZ0 = Number(params.wZ0 ?? 0.4);
  const wZ1 = Number(params.wZ1 ?? 0.7);
  const wZ2 = Number(params.wZ2 ?? 1.0);
  const wZ3 = Number(params.wZ3 ?? 1.4);
  const wZ4 = Number(params.wZ4 ?? 1.8);
  if (z < zT1) return wZ0;
  if (z < zT2) return wZ1;
  if (z < zT3) return wZ2;
  if (z < zT4) return wZ3;
  return wZ4;
}

/**
 * Danger contínuo: τ ∈ [floor, start] e z = dist/(σ_ps√τ) < minZ (só com dist > 0).
 */
export function evaluateDangerExitContinuous(snapshot, params, positionSide, history = []) {
  const on = params.dangerContinuousEnabled === true || params.dangerContinuousEnabled === 1;
  if (!on || !positionSide) {
    return { active: false, z: null, bid: null };
  }
  const secsLeft = snapshot.secsLeft;
  const floor = Number(params.dangerExitFloorSec ?? 4);
  const start = Number(params.dangerContinuousStartSec ?? 8);
  const inWindow = secsLeft >= floor && secsLeft <= start;
  const dist = signedDistance(positionSide, snapshot.btc, snapshot.priceToBeat);
  const bid = snapshot.book?.[positionSide.toLowerCase()]?.bestBid ?? null;
  const bidOk = bid != null && bid >= Number(params.stopMinBid ?? 0);
  if (!inWindow || !bidOk || !(dist > 0)) {
    return { active: false, z: null, signedDistance: dist, bid, bidOk, reason: 'danger_exit_continuous' };
  }
  const { z, sigmaPs } = physicalZScore(dist, history, params, secsLeft, snapshot.nowMs);
  const minZ = Number(params.dangerContinuousMinZ ?? 0.25);
  const active = sigmaPs > 0 && z < minZ;
  return {
    active: Boolean(active),
    z,
    signedDistance: dist,
    sigmaPs,
    secsLeft,
    bid,
    bidOk,
    reason: 'danger_exit_continuous',
  };
}

/**
 * Early-warn: ask do oposto reprecifica a favor da virada antes do late flip.
 */
export function evaluateEarlyWarnExit(snapshot, params, positionSide, signedDist = null) {
  const on = params.earlyWarnEnabled === true || params.earlyWarnEnabled === 1;
  if (!on || !positionSide) {
    return { active: false, oppAsk: null, bid: null };
  }
  const secsLeft = snapshot.secsLeft;
  const start = Number(params.earlyWarnStartSec ?? 20);
  const end = Number(params.earlyWarnEndSec ?? 8);
  const inWindow = secsLeft <= start && secsLeft > end;
  const bid = snapshot.book?.[positionSide.toLowerCase()]?.bestBid ?? null;
  const bidOk = bid != null && bid >= Number(params.stopMinBid ?? 0);
  const opp = oppositeSide(positionSide);
  const oppAsk = opp ? snapshot.book?.[opp.toLowerCase()]?.bestAsk ?? null : null;
  const onlyLosing = params.earlyWarnOnlyIfLosing === true || params.earlyWarnOnlyIfLosing === 1;
  const dist =
    signedDist != null
      ? signedDist
      : signedDistance(positionSide, snapshot.btc, snapshot.priceToBeat);
  const losingOk = !onlyLosing || dist == null || dist <= 0;
  const trigger = Number(params.earlyWarnOppAsk ?? 0.45);
  const active =
    inWindow && bidOk && losingOk && oppAsk != null && oppAsk > 0 && oppAsk >= trigger;
  return {
    active: Boolean(active),
    oppAsk,
    bid,
    bidOk,
    signedDistance: dist,
    secsLeft,
    reason: 'early_warn_exit',
  };
}

/**
 * Scoop: entrada complementar (favorito barato, z alto) fora do envelope core.
 */
export function evaluateScoopEntry(snapshot, params, history = []) {
  const on = params.scoopEnabled === true || params.scoopEnabled === 1;
  if (!on) return { ok: false, reason: 'scoop_disabled' };

  const { btc, priceToBeat, secsLeft, book } = snapshot;
  const fav = favoriteSide(btc, priceToBeat);
  if (!fav) return { ok: false, reason: 'no_fav' };

  const dist = Number.isFinite(btc) && Number.isFinite(priceToBeat) ? Math.abs(btc - priceToBeat) : null;
  const ask = book?.[fav.toLowerCase()]?.bestAsk ?? null;
  const bid = book?.[fav.toLowerCase()]?.bestBid ?? null;
  const spread = ask != null && bid != null ? ask - bid : null;
  const { z } = physicalZScore(dist ?? 0, history, params, secsLeft, snapshot.nowMs);

  const vel = spotVelocity(history, params.velocityLookbackSecs, snapshot.nowMs);
  let adverse = false;
  if (vel && fav) {
    if (fav === 'UP' && vel.change < -params.maxAdverseSpotChange) adverse = true;
    if (fav === 'DOWN' && vel.change > params.maxAdverseSpotChange) adverse = true;
  }

  const upAsk = book?.up?.bestAsk;
  const downAsk = book?.down?.bestAsk;
  const oddsSum = upAsk != null && downAsk != null ? upAsk + downAsk : null;

  const ok =
    !adverse &&
    secsLeft >= Number(params.scoopMinSecondsLeft ?? 5) &&
    secsLeft < Number(params.scoopMaxSecondsLeft ?? 30) &&
    dist != null &&
    dist < Number(params.scoopMaxDistAbs ?? 80) &&
    ask != null &&
    ask >= Number(params.scoopMinAsk ?? 0.1) &&
    ask < Number(params.scoopMaxAsk ?? 0.55) &&
    spread != null &&
    spread <= Number(params.scoopMaxSpread ?? 0.05) &&
    z >= Number(params.scoopMinZ ?? 1.5) &&
    oddsSum != null &&
    oddsSum >= Number(params.scoopMinOddsSum ?? 0.9) &&
    oddsSum <= Number(params.scoopMaxOddsSum ?? 1.1);

  return {
    ok: Boolean(ok),
    fav,
    ask,
    bid,
    dist,
    z,
    spread,
    oddsSum,
    adverse,
    reason: ok ? 'midas_scoop_entry' : 'scoop_gates_fail',
  };
}
