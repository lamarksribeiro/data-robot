/**
 * Avaliação read-only dos gates de entrada TFC (sem enviar ordens).
 */

export function favoriteSide(btc, priceToBeat) {
  if (!Number.isFinite(btc) || !Number.isFinite(priceToBeat)) return null;
  return btc >= priceToBeat ? 'UP' : 'DOWN';
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
 * @returns {{ ok: boolean, fav: string|null, gates: Record<string, { pass: boolean, detail?: string }>, ask: number|null, bid: number|null }}
 */
export function evaluateEntryGates(snapshot, params, history = []) {
  const gates = {};
  const { btc, priceToBeat, secsLeft, book } = snapshot;

  gates.terminalWindow = {
    pass: secsLeft >= params.minSecondsLeft && secsLeft < params.maxSecondsLeft,
    detail: `secsLeft=${secsLeft?.toFixed?.(1) ?? '?'}`,
  };

  const dist = Number.isFinite(btc) && Number.isFinite(priceToBeat)
    ? Math.abs(btc - priceToBeat)
    : null;
  gates.distance = {
    pass: dist != null && dist < params.maxDistAbs,
    detail: dist != null ? `|btc-ptb|=${dist.toFixed(2)}` : 'btc/ptb indisponível',
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

  return { ok, fav, gates, ask, bid, dist, oddsSum, spread, obi };
}

export function evaluateLateFlip(snapshot, params, positionSide) {
  const { btc, priceToBeat, secsLeft, book } = snapshot;
  if (!positionSide) return { active: false };

  let signedDistance = btc - priceToBeat;
  if (positionSide === 'DOWN') signedDistance = priceToBeat - btc;

  const bid = book?.[positionSide.toLowerCase()]?.bestBid;
  const inWindow = secsLeft <= params.lateFlipExitSec && secsLeft >= params.lateFlipMinSec;
  const crossed = signedDistance <= params.lateFlipExitCrossDist;
  const bidOk = bid != null && bid >= params.stopMinBid;

  return {
    active: inWindow && crossed && bidOk,
    signedDistance,
    secsLeft,
    bid,
    hedgeStopWindow: secsLeft <= params.hedgeStopPlaceSec && secsLeft >= params.lateFlipMinSec,
  };
}
