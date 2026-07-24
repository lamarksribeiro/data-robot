/**
 * Modelos Edge Sniper para runtime (paridade edge-sniper-models v1).
 */

import { orderBookImbalance } from './evaluate.js';

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function sampleAgo(history, seconds, nowMs) {
  if (!history?.length) return null;
  const cutoff = nowMs - Number(seconds) * 1000;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].ts <= cutoff) return history[i];
  }
  return history[0];
}

function recentVolatility(history, lookbackSec, nowMs) {
  if (!history?.length || history.length < 3) return 0;
  const cutoff = nowMs - Number(lookbackSec) * 1000;
  const values = history
    .filter((h) => h.ts >= cutoff && Number.isFinite(h.btc))
    .map((h) => h.btc);
  if (values.length < 2) return 0;
  const changes = [];
  for (let i = 1; i < values.length; i += 1) {
    changes.push(values[i] - values[i - 1]);
  }
  if (changes.length < 2) return 0;
  const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
  return Math.sqrt(changes.reduce((sum, v) => sum + (v - avg) ** 2, 0) / changes.length);
}

function sideMid(book, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const bid = book?.[prefix]?.bestBid;
  const ask = book?.[prefix]?.bestAsk;
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  return Number.isFinite(ask) ? ask : Number.isFinite(bid) ? bid : null;
}

function marketProbUpFromBook(book) {
  const upMid = sideMid(book, 'UP');
  const downMid = sideMid(book, 'DOWN');
  if (upMid == null || downMid == null || upMid + downMid <= 0) return 0.5;
  return Math.min(0.999, Math.max(0.001, upMid / (upMid + downMid)));
}

function sideSpread(book, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const bid = book?.[prefix]?.bestBid;
  const ask = book?.[prefix]?.bestAsk;
  return Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null;
}

function sideAsk(book, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  return book?.[prefix]?.bestAsk ?? null;
}

function sideBid(book, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  return book?.[prefix]?.bestBid ?? null;
}

/**
 * Probabilidade direcional UP (paridade model.directionProbability).
 */
export function directionProbability(snapshot, history, params = {}) {
  const btc = snapshot.btc;
  const ptb = snapshot.priceToBeat;
  const secsLeft = snapshot.secsLeft;
  if (!Number.isFinite(btc) || !Number.isFinite(ptb) || !Number.isFinite(secsLeft)) return 0.5;

  const distance = btc - ptb;
  const fastSample = sampleAgo(history, params.momentumSec ?? 6, snapshot.nowMs);
  const slowSample = sampleAgo(history, params.slowMomentumSec ?? 18, snapshot.nowMs) || fastSample;
  const fastMove = btc - (fastSample?.btc ?? btc);
  const slowMove = btc - (slowSample?.btc ?? btc);
  const recentVol = recentVolatility(history, params.volLookbackSec ?? 45, snapshot.nowMs);
  const minSigma = Number(params.minSigma ?? 10);
  const sigmaMultiplier = Number(params.sigmaMultiplier ?? 1);
  const obiLevels = Number(params.obiLevels ?? 5);
  const obiUp = orderBookImbalance('UP', snapshot.book, obiLevels);
  const obiDown = orderBookImbalance('DOWN', snapshot.book, obiLevels);
  const obiNet = obiUp - obiDown;

  const sigma = Math.max(minSigma, recentVol * Math.sqrt(Math.max(1, secsLeft)) * sigmaMultiplier);
  const distanceZ = distance / sigma;
  const momentumZ = (fastMove + Number(params.slowMomentumWeight ?? 0.35) * slowMove) / sigma;
  const marketProbability = marketProbUpFromBook(snapshot.book);
  const marketLag = Math.min(0.5, Math.max(-0.5, (distance > 0 ? 1 - marketProbability : marketProbability) - 0.5));
  const distanceWeight = Number(params.distanceWeight ?? 2);
  const momentumWeight = Number(params.momentumWeight ?? 0.65);
  const lagWeight = Number(params.lagWeight ?? 0.45);

  let score = distanceWeight * distanceZ + momentumWeight * momentumZ + lagWeight * marketLag;
  const useObiInScore =
    params.useObiInScore === true || params.useObiInScore === 1 || params.useObiInScore === 'true';
  if (useObiInScore) {
    score += obiNet * Number(params.obiScoreWeight ?? 0.35);
  }
  return Math.min(0.999, Math.max(0.001, logistic(score)));
}

/**
 * @returns {{ best: object|null, probUp: number }}
 */
export function scoreSides(snapshot, history, params = {}) {
  const probUp = directionProbability(snapshot, history, params);
  const book = snapshot.book;
  const candidates = ['UP', 'DOWN']
    .map((side) => {
      const ask = sideAsk(book, side);
      const bid = sideBid(book, side);
      const spread = sideSpread(book, side);
      const probability = side === 'UP' ? probUp : 1 - probUp;
      const edge = Number.isFinite(ask) ? probability - ask : Number.NEGATIVE_INFINITY;
      return { side, ask, bid, probability, edge, spread };
    })
    .filter((candidate) => {
      if (!Number.isFinite(candidate.ask)) return false;
      if (candidate.ask < Number(params.edgeMinAsk ?? params.minAsk ?? 0.08)) return false;
      if (candidate.ask > Number(params.edgeMaxAsk ?? params.maxAsk ?? 0.65)) return false;
      if (candidate.probability < Number(params.edgeMinDirectionalProb ?? params.minDirectionalProb ?? 0.54)) {
        return false;
      }
      if (candidate.edge < Number(params.edgeMinEdge ?? params.minEdge ?? 0.04)) return false;
      if (Number.isFinite(candidate.spread) && candidate.spread > Number(params.edgeMaxSpread ?? params.maxSpread ?? 0.06)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.edge - left.edge);
  return { best: candidates[0] ?? null, probUp };
}
