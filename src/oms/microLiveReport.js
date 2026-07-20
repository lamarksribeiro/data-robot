/**
 * Relatório de micro-live P7 — intenção vs execução vs fee.
 */

import { calculateTakerFee, summarizeTradeFees } from '../fees/polymarketFee.js';

/**
 * @param {object} parts
 * @param {object} [parts.intent]
 * @param {object[]} [parts.events]
 * @param {object} [parts.position]
 * @param {number|null} [parts.askAtSignal]
 * @param {object[]} [parts.trades] — trades CLOB opcionais
 * @param {number} [parts.feeRate]
 * @param {object} [parts.riskDecision]
 * @param {boolean} [parts.canceled]
 */
export function buildMicroLiveReport(parts = {}) {
  const intent = parts.intent ?? null;
  const events = parts.events ?? [];
  const fills = events.filter((e) => e.type === 'FILL' || e.type === 'PARTIAL');
  const rejects = events.filter((e) => e.type === 'REJECT');
  const cancels = events.filter((e) => e.type === 'CANCEL');
  const acks = events.filter((e) => e.type === 'ACK');

  const fillQty = fills.reduce((s, e) => s + (Number(e.qty) || 0), 0);
  const fillNotional = fills.reduce(
    (s, e) => s + (Number(e.qty) || 0) * (Number(e.price) || 0),
    0,
  );
  const avgFillPrice =
    fillQty > 0 ? fillNotional / fillQty : fills[0]?.price != null ? Number(fills[0].price) : null;

  const ask = parts.askAtSignal != null ? Number(parts.askAtSignal) : null;
  const slippage =
    ask != null && avgFillPrice != null ? avgFillPrice - ask : null;

  const feeRate = parts.feeRate ?? 0.07;
  let expectedFee = 0;
  for (const f of fills) {
    expectedFee += calculateTakerFee({
      shares: Number(f.qty) || 0,
      price: Number(f.price) || 0,
      feeRate,
    });
  }

  const tradeFees =
    Array.isArray(parts.trades) && parts.trades.length
      ? summarizeTradeFees(parts.trades, { feeRate })
      : null;

  const orphan =
    acks.length > 0 &&
    fills.length === 0 &&
    cancels.length === 0 &&
    rejects.length === 0 &&
    parts.canceled !== true;

  const timeline = events.map((e) => ({
    type: e.type,
    qty: e.qty ?? null,
    price: e.price ?? null,
    reason: e.reason ?? null,
    tsMs: e.tsMs ?? null,
  }));

  return {
    schemaVersion: 1,
    kind: 'micro-live-report',
    intentId: intent?.intentId ?? null,
    side: intent?.side ?? null,
    budget: intent?.budget ?? null,
    maxPrice: intent?.maxPrice ?? null,
    orderType: intent?.orderType ?? null,
    reason: intent?.reason ?? null,
    riskAllowed: parts.riskDecision?.allow ?? null,
    riskReason: parts.riskDecision?.reasonCode ?? null,
    accepted: rejects.length === 0 && (acks.length > 0 || fills.length > 0),
    filled: fillQty > 0,
    fillQty,
    avgFillPrice,
    askAtSignal: ask,
    slippage,
    expectedFeeUsd: expectedFee,
    tradeFees,
    canceled: parts.canceled === true || cancels.length > 0,
    orphan,
    position: parts.position
      ? {
          side: parts.position.side,
          qty: parts.position.qty,
          avgPrice: parts.position.avgPrice,
        }
      : null,
    timeline,
    reconciled: !orphan && rejects.length === 0,
    notes: [
      orphan ? 'ACK sem fill/cancel — possível resting órfã' : null,
      slippage != null && ask != null ? `slippage=${slippage.toFixed(4)} vs ask` : null,
      expectedFee > 0 ? `expectedTakerFee≈$${expectedFee.toFixed(5)}` : null,
    ].filter(Boolean),
  };
}

/**
 * Compara intenção do plugin em replay vs intenção live (mesmos campos-chave).
 */
export function compareIntentParity(liveIntent, replayIntent) {
  const keys = ['kind', 'side', 'reason', 'marketId'];
  const mismatches = [];
  for (const key of keys) {
    if (liveIntent?.[key] !== replayIntent?.[key]) {
      mismatches.push({ key, live: liveIntent?.[key], replay: replayIntent?.[key] });
    }
  }
  const budgetTol = 1e-9;
  if (
    liveIntent?.budget != null &&
    replayIntent?.budget != null &&
    Math.abs(Number(liveIntent.budget) - Number(replayIntent.budget)) > budgetTol
  ) {
    mismatches.push({
      key: 'budget',
      live: liveIntent.budget,
      replay: replayIntent.budget,
    });
  }
  return { ok: mismatches.length === 0, mismatches };
}
