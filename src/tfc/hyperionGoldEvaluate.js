/**
 * Avaliador de Sinais e Regras da Estratégia Hyperion Gold V1.
 * Regras puras e matemáticas para gatilho Binance Lead, envelope High-Ask e saídas protetoras.
 */

export function signedDistance(spot, strikeUsd, side) {
  if (!Number.isFinite(spot) || !Number.isFinite(strikeUsd)) return null;
  const dist = spot - strikeUsd;
  return side === 'UP' ? dist : -dist;
}

/**
 * Avalia o Impulso de Latência da Binance (Binance Lead Gate).
 * Verifica se houve um deslocamento de preço na Binance favorável ao lado líder nos últimos 1.5s.
 */
export function evaluateBinanceLeadGate(snapshot, side, params, history = []) {
  if (!params.binanceLeadEnabled) {
    return { ok: true, reason: 'LEAD_DISABLED' };
  }

  const currentBtc = snapshot.btc;
  const nowMs = snapshot.nowMs;
  if (!Number.isFinite(currentBtc) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'NO_BINANCE_PRICE' };
  }

  const lookbackMs = Number(params.binanceLeadLookbackMs ?? 1500);
  const minDelta = Number(params.binanceLeadMinDeltaUsd ?? 15.0);
  const targetTs = nowMs - lookbackMs;

  // Busca o preço mais próximo no histórico do lookback
  let pastRow = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts <= targetTs) {
      pastRow = history[i];
      break;
    }
  }

  if (!pastRow || !Number.isFinite(pastRow.btc)) {
    // Se histórico for novo, permite passar de forma conservadora
    return { ok: true, reason: 'LEAD_HISTORY_WARMING' };
  }

  const deltaBtc = currentBtc - pastRow.btc;
  const alignedDelta = side === 'UP' ? deltaBtc : -deltaBtc;

  if (alignedDelta >= minDelta) {
    return { ok: true, reason: 'LEAD_IMPULSE_CONFIRMED', delta: alignedDelta };
  }

  // Se não houve movimento contrário forte, ainda autoriza se o delta for neutro/positivo
  if (alignedDelta >= 0) {
    return { ok: true, reason: 'LEAD_NEUTRAL_CONFIRMED', delta: alignedDelta };
  }

  return { ok: false, reason: 'LEAD_IMPULSE_ADVERSE', delta: alignedDelta };
}

/**
 * Avalia o Envelope MIDAS High-Ask Carry (0.82 <= ask <= 0.94).
 */
export function evaluateHighAskEnvelope(ask, dist, secondsLeft, params) {
  const minAsk = Number(params.minAsk ?? 0.82);
  const maxAsk = Number(params.maxAsk ?? 0.94);
  const maxDistAbs = Number(params.maxDistAbs ?? 40);
  const maxSec = Number(params.maxSecondsLeft ?? 30);
  const minSec = Number(params.minSecondsLeft ?? 9);

  if (secondsLeft > maxSec || secondsLeft < minSec) {
    return { ok: false, reason: 'OUTSIDE_TACTICAL_WINDOW' };
  }

  if (ask < minAsk || ask > maxAsk) {
    return { ok: false, reason: 'ASK_OUTSIDE_HIGH_ASK_ENVELOPE' };
  }

  if (Math.abs(dist) > maxDistAbs) {
    return { ok: false, reason: 'DISTANCE_EXCEEDS_MAX' };
  }

  return { ok: true, reason: 'HIGH_ASK_ENVELOPE_VALID' };
}

/**
 * Avalia saída emergencial por choque de cotação oposta (Odds Shock Exit).
 */
export function evaluateHyperionOddsShockExit(snapshot, position, params, history = []) {
  if (!params.oddsShockEnabled || !position) {
    return { trigger: false };
  }

  const side = position.side;
  const oppSide = side === 'UP' ? 'DOWN' : 'UP';
  const oppAsk = snapshot.book?.[oppSide.toLowerCase()]?.asks?.[0]?.price;
  const currentBid = snapshot.book?.[side.toLowerCase()]?.bids?.[0]?.price;
  const entryPrice = position.entryPrice;

  if (!Number.isFinite(oppAsk) || !Number.isFinite(currentBid) || !Number.isFinite(entryPrice)) {
    return { trigger: false };
  }

  const minOppAsk = Number(params.oddsShockMinOppAsk ?? 0.50);
  const minRatio = Number(params.oddsShockMinEntryAskRatio ?? 0.55);

  if (oppAsk >= minOppAsk && currentBid >= entryPrice * minRatio) {
    // Procura variação rápida do oppAsk no histórico
    const lookbackMs = Number(params.oddsShockLookbackSec ?? 2) * 1000;
    const targetTs = snapshot.nowMs - lookbackMs;

    let pastOppAsk = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].ts <= targetTs) {
        pastOppAsk = history[i].oppAsk;
        break;
      }
    }

    if (Number.isFinite(pastOppAsk)) {
      const deltaOpp = oppAsk - pastOppAsk;
      const minDelta = Number(params.oddsShockDeltaMin ?? 0.15);
      if (deltaOpp >= minDelta) {
        return {
          trigger: true,
          reason: 'ODDS_SHOCK_PROTECTION',
          fraction: Number(params.oddsShockFraction ?? 0.50),
          bid: currentBid,
        };
      }
    }
  }

  return { trigger: false };
}
