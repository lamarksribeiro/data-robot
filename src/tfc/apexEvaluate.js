/**
 * Avaliação Apex Triad V1 (edge + terminal TFC).
 */

import {
  evaluateDangerExit,
  evaluateEntryGates,
  favoriteSide,
  oppositeSide,
  signedDistance,
  spotVolatility,
} from './evaluate.js';
import { scoreSides } from './edgeModels.js';

export function inWindow(secsLeft, start, end) {
  return Number(secsLeft) <= Number(start) && Number(secsLeft) > Number(end);
}

export function terminalRuntimeParams(params) {
  return {
    minSecondsLeft: params.terminalMinSecondsLeft,
    maxSecondsLeft: params.terminalMaxSecondsLeft,
    maxDistAbs: params.terminalMaxDistAbs,
    minAsk: params.terminalMinAsk,
    maxAsk: params.terminalMaxAsk,
    maxSpread: params.terminalMaxSpread,
    minOddsSum: params.terminalMinOddsSum,
    maxOddsSum: params.terminalMaxOddsSum,
    velocityLookbackSecs: params.terminalVelocityLookbackSecs,
    maxAdverseSpotChange: params.terminalMaxAdverseSpotChange,
    minObi: params.terminalMinObi,
    obiLevels: params.obiLevels,
    minFlips: params.terminalMinFlips,
    flipWindowSecs: params.terminalFlipWindowSecs,
    stopMinBid: params.stopMinBid ?? 0.05,
    minEntryZ: 0,
  };
}

export function evaluateEdgeEntry(snapshot, params, history) {
  const edgeOn = params.edgeEnabled === true || params.edgeEnabled === 1;
  if (!edgeOn) return { ok: false, reason: 'edge_disabled' };
  if (!inWindow(snapshot.secsLeft, params.edgeWindowStart, params.edgeWindowEnd)) {
    return { ok: false, reason: 'outside_edge_window' };
  }

  const momentumSec = Number(params.momentumSec ?? 6);
  const elapsed = history?.length ? (snapshot.nowMs - history[0].ts) / 1000 : 0;
  if (elapsed < Math.max(4, momentumSec)) {
    return { ok: false, reason: 'warmup' };
  }

  const distance =
    Number.isFinite(snapshot.btc) && Number.isFinite(snapshot.priceToBeat)
      ? Math.abs(snapshot.btc - snapshot.priceToBeat)
      : null;
  if (distance == null || distance < Number(params.edgeMinDistanceAbs)) {
    return { ok: false, reason: 'edge_distance' };
  }

  const scored = scoreSides(snapshot, history, params);
  const best = scored.best;
  if (!best) return { ok: false, reason: 'edge_score', scored };

  let budget = Number(params.baseBudget) * Number(params.edgeBudgetFactor);
  if (best.ask > Number(params.edgePriceAwareThreshold ?? 0.52)) {
    budget *= Number(params.edgePriceAwareFactor ?? 0.5);
  }

  return {
    ok: true,
    side: best.side,
    ask: best.ask,
    budget,
    edge: best.edge,
    scored,
    reason: 'apex_edge_entry',
  };
}

export function evaluateTerminalEntry(snapshot, params, history) {
  const terminalOn = params.terminalEnabled === true || params.terminalEnabled === 1;
  if (!terminalOn) return { ok: false, reason: 'terminal_disabled' };

  const secsLeft = snapshot.secsLeft;
  if (
    secsLeft == null ||
    secsLeft < Number(params.terminalMinSecondsLeft) ||
    secsLeft >= Number(params.terminalMaxSecondsLeft)
  ) {
    return { ok: false, reason: 'outside_terminal_window' };
  }

  const entry = evaluateEntryGates(snapshot, terminalRuntimeParams(params), history);
  const vol = spotVolatility(history, params.terminalVolLookbackSecs ?? 30, snapshot.nowMs);
  if (vol > Number(params.terminalMaxVol ?? 99999)) {
    return { ok: false, reason: 'terminal_vol', entry };
  }

  if (!entry.ok || !entry.fav || entry.ask == null) {
    return { ok: false, reason: 'terminal_gates', entry };
  }

  return {
    ok: true,
    side: entry.fav,
    ask: entry.ask,
    budget: Number(params.baseBudget),
    entry,
    reason: 'apex_terminal_entry',
  };
}

export function evaluateApexReverse(snapshot, params, positionSide, state) {
  const reverseOn = params.reverseEnabled === true || params.reverseEnabled === 1;
  if (!reverseOn || state.reversed || state.reverseCount >= Number(params.reverseMaxAttempts ?? 1)) {
    return { action: null };
  }

  const dist = signedDistance(positionSide, snapshot.btc, snapshot.priceToBeat);
  const secsLeft = snapshot.secsLeft;
  const edgeReverse =
    state.entryMode === 'edge' &&
    secsLeft <= Number(params.edgeReverseMaxSecondsLeft) &&
    secsLeft >= Number(params.edgeReverseMinSecondsLeft) &&
    dist != null &&
    dist <= -Number(params.edgeReverseMinDistanceAbs);
  const terminalReverse =
    state.entryMode === 'terminal' &&
    secsLeft <= Number(params.terminalReverseMaxSecondsLeft) &&
    secsLeft >= Number(params.terminalReverseMinSecondsLeft) &&
    dist != null &&
    dist <= Number(params.terminalReverseCrossDist ?? 0);

  if (!edgeReverse && !terminalReverse) return { action: null, signedDistance: dist };

  const oppSide = oppositeSide(positionSide);
  const oppAsk = oppSide ? snapshot.book?.[oppSide.toLowerCase()]?.bestAsk : null;
  const bid = snapshot.book?.[positionSide.toLowerCase()]?.bestBid;
  if (oppAsk == null || oppAsk <= 0 || oppAsk > Number(params.reverseMaxAsk ?? 0.95)) {
    return { action: null, signedDistance: dist, oppAsk };
  }

  return {
    action: 'REVERSE',
    oppSide,
    oppAsk,
    exitBid: bid,
    budget: (state.entryCost ?? Number(params.baseBudget)) * Number(params.reverseBudgetFactor ?? 1),
    signedDistance: dist,
    reason: 'apex_reverse',
  };
}

export function evaluateEdgeExits(snapshot, params, positionSide, state) {
  if (state.entryMode !== 'edge') return { action: null };
  const bid = snapshot.book?.[positionSide.toLowerCase()]?.bestBid;
  const secsLeft = snapshot.secsLeft;
  if (!Number.isFinite(bid)) return { action: null };

  if (bid <= Number(params.edgeStopBid) && secsLeft > Number(params.edgeStopMinSecondsLeft)) {
    return { action: 'EXIT', bid, reason: 'apex_edge_stop' };
  }
  if (
    state.maxBid >= Number(params.edgeTrailAfterBid) &&
    state.maxBid - bid >= Number(params.edgeTrailDrop)
  ) {
    return { action: 'EXIT', bid, reason: 'apex_edge_trail' };
  }
  if (secsLeft <= Number(params.edgeLateExitSec) && bid >= Number(params.edgeLateExitMinBid)) {
    return { action: 'EXIT', bid, reason: 'apex_edge_late_exit' };
  }
  return { action: null, bid };
}

export function evaluateApexDangerExit(snapshot, params, positionSide, history) {
  return evaluateDangerExit(snapshot, params, positionSide, history);
}

export function distanceFromPtb(btc, priceToBeat) {
  if (!Number.isFinite(btc) || !Number.isFinite(priceToBeat)) return null;
  return Math.abs(btc - priceToBeat);
}

export { favoriteSide, oppositeSide, signedDistance };
