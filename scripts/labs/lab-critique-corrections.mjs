/**
 * Revisão crítica: o que realmente sustenta as correções.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'runs/labs-audit';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

function load(f) {
  return fs
    .readFileSync(path.join(dir, f), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const reverseOutcomes = [];
for (const file of files) {
  const rows = load(file);
  for (const s of rows.filter((r) => r.type === 'order_submit' && r.kind === 'REVERSE')) {
    const term = rows.find((t) => t.type === 'order_terminal' && t.intentId === s.intentId);
    const settle = rows.find((t) => t.type === 'position_settled' && t.marketId === s.marketId);
    reverseOutcomes.push({
      file,
      market: s.marketId,
      secsLeft: s.secsLeft,
      term: term
        ? {
            eventType: term.eventType,
            filled: term.filled,
            reason: String(term.reason ?? '').slice(0, 90),
            qty: term.qty,
          }
        : null,
      settle: settle
        ? { pnl: settle.pnlDelta, winner: settle.winner, side: settle.side }
        : null,
    });
  }
}

const reverseByOutcome = {};
for (const r of reverseOutcomes) {
  let k = 'no_terminal';
  if (r.term?.filled) k = 'FILL';
  else if (/REVERSE_EXIT_INCOMPLETE/i.test(r.term?.reason ?? '')) k = 'EXIT_INCOMPLETE';
  else if (/REVERSE_ENTER_FAILED/i.test(r.term?.reason ?? '')) k = 'ENTER_FAILED';
  else if (r.term) k = r.term.eventType || 'OTHER';
  reverseByOutcome[k] = (reverseByOutcome[k] ?? 0) + 1;
}

const partials = [];
for (const file of files) {
  const rows = load(file);
  for (const s of rows.filter(
    (r) => r.type === 'order_submit' && String(r.reason ?? '').includes('odds_shock_partial'),
  )) {
    const term = rows.find((t) => t.type === 'order_terminal' && t.intentId === s.intentId);
    const reason = String(term?.reason ?? '');
    let outcome = 'other';
    if (term?.filled || term?.eventType === 'FILL') outcome = 'FILL';
    else if (/minimum/i.test(reason)) outcome = 'REJECT_MIN5';
    else if (/balance|allowance/i.test(reason)) outcome = 'REJECT_BALANCE';
    else if (term?.eventType === 'REJECT') outcome = 'REJECT_OTHER';
    partials.push({ file, market: s.marketId, qty: s.quantity, outcome, reason: reason.slice(0, 60) });
  }
}

const partialByQtyOutcome = {};
for (const p of partials) {
  const key = `qty=${p.qty}|${p.outcome}`;
  partialByQtyOutcome[key] = (partialByQtyOutcome[key] ?? 0) + 1;
}

const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
const tax = {
  holdOnlyNoProtect: 0,
  deniedReverseOnly: 0,
  partialOrExitReject: 0,
  reverseAcceptedThenFailed: 0,
  exitFilledStillLost: 0,
};
const holdLoss = [];
const protectableLoss = [];
for (const l of report.losers) {
  const deny = l.deny || l.deniedReverseReasons || {};
  const hasDeny = Object.keys(deny).length > 0;
  const hasExitReject = (l.rejects || []).some((r) => r.kind === 'EXIT');
  const hasRevReject = (l.rejects || []).some((r) => r.kind === 'REVERSE');
  const hasRevSubmit = (l.submits || []).some((s) => s.kind === 'REVERSE');
  const hasExitFill = (l.terminals || []).some((t) => t.kind === 'EXIT' && t.filled);
  const hasPartialSubmit = (l.submits || []).some((s) =>
    String(s.reason ?? '').includes('odds_shock'),
  );

  if (!hasDeny && !hasExitReject && !hasRevSubmit && !hasPartialSubmit) {
    tax.holdOnlyNoProtect += 1;
    holdLoss.push(l.pnlDelta);
  } else {
    protectableLoss.push(l.pnlDelta);
  }
  if (hasDeny) tax.deniedReverseOnly += 1;
  if (hasExitReject) tax.partialOrExitReject += 1;
  if (hasRevSubmit || hasRevReject) tax.reverseAcceptedThenFailed += 1;
  if (hasExitFill) tax.exitFilledStillLost += 1;
}

let marketsWithBoth = 0;
let marketsMaxThenCircuit = 0;
let marketsCircuitOnly = 0;
let marketsMaxOnly = 0;
for (const file of files) {
  const rows = load(file);
  const byM = new Map();
  for (const d of rows.filter((r) => r.action === 'denied:REVERSE')) {
    if (!byM.has(d.marketId)) byM.set(d.marketId, { max: [], circ: [] });
    for (const x of d.denied ?? []) {
      if (x.reasonCode === 'MAX_NOTIONAL_EVENT') byM.get(d.marketId).max.push(d.tsMs);
      if (x.reasonCode === 'CIRCUIT_OPEN') byM.get(d.marketId).circ.push(d.tsMs);
    }
  }
  for (const [, v] of byM) {
    if (v.max.length && v.circ.length) {
      marketsWithBoth += 1;
      if (Math.min(...v.max) <= Math.min(...v.circ)) marketsMaxThenCircuit += 1;
    } else if (v.max.length) marketsMaxOnly += 1;
    else if (v.circ.length) marketsCircuitOnly += 1;
  }
}

const firstDenyOnLosers = [];
for (const file of files) {
  const rows = load(file);
  const settles = new Map(
    rows.filter((r) => r.type === 'position_settled').map((r) => [r.marketId, r]),
  );
  const seen = new Set();
  for (const d of rows.filter((r) => r.action === 'denied:REVERSE')) {
    if (seen.has(d.marketId)) continue;
    seen.add(d.marketId);
    const settle = settles.get(d.marketId);
    if (!settle || !(Number(settle.pnlDelta) < 0)) continue;
    const lf = d.diagnostics?.lateFlip;
    if (!lf) continue;
    const exitBid = Number(lf.exitBid);
    const oppAsk = Number(lf.oppAsk);
    const qty = Number(settle.qty);
    const avg = Number(settle.avgPrice);
    const settleOpp = 1 - Number(settle.settlementPrice);
    const ideal = (exitBid - avg) * qty + (settleOpp - oppAsk) * qty;
    // pessimistic: sell 2c worse, buy 2c worse
    const pessimistic =
      (exitBid - 0.02 - avg) * qty + (settleOpp - (oppAsk + 0.02)) * qty;
    firstDenyOnLosers.push({
      market: d.marketId,
      reason: d.denied?.[0]?.reasonCode,
      exitBid,
      oppAsk,
      roundTrip: exitBid + oppAsk,
      hold: settle.pnlDelta,
      idealReverse: ideal,
      pessimisticReverse: pessimistic,
      idealImprovement: ideal - settle.pnlDelta,
      pessImprovement: pessimistic - settle.pnlDelta,
    });
  }
}

console.log(
  JSON.stringify(
    {
      reverseAccepted: {
        count: reverseOutcomes.length,
        byOutcome: reverseByOutcome,
        note: 'REVERSE que passou no risk — se maioria falha na saga, liberar cap sozinho não basta',
      },
      partialExits: {
        count: partials.length,
        byQtyOutcome: partialByQtyOutcome,
        note: 'qty<5 às vezes FILL — minSize não é regra absoluta em todos os paths',
      },
      lossTaxonomy: {
        totalLosers: report.losers.length,
        ...tax,
        holdOnlyPnL: holdLoss.reduce((a, b) => a + b, 0),
        protectablePnL: protectableLoss.reduce((a, b) => a + b, 0),
        holdOnlyShare: holdLoss.length / report.losers.length,
      },
      circuitCascade: {
        marketsWithBoth,
        marketsMaxThenCircuit,
        marketsMaxOnly,
        marketsCircuitOnly,
        maxNotionalInExpectedPolicyDenials: false,
        implication: 'MAX_NOTIONAL ainda chama recordFailure → abre circuit',
      },
      reverseCfSensitivity: {
        loserMarketsWithFirstDeny: firstDenyOnLosers.length,
        sumIdealImprovement: firstDenyOnLosers.reduce((a, x) => a + x.idealImprovement, 0),
        sumPessImprovement: firstDenyOnLosers.reduce((a, x) => a + x.pessImprovement, 0),
        stillPositiveIdeal: firstDenyOnLosers.filter((x) => x.idealImprovement > 0.1).length,
        stillPositivePess: firstDenyOnLosers.filter((x) => x.pessImprovement > 0.1).length,
        samples: firstDenyOnLosers,
      },
    },
    null,
    2,
  ),
);
