/**
 * Lab: análise agregada de losses / rejects / denied:reverse
 * para decidir se as correções propostas ainda valem.
 *
 *   node scripts/labs/lab-portfolio-loss-audit.mjs runs/labs-audit
 */
import fs from 'node:fs';
import path from 'node:path';

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function assetFromFile(name) {
  const m = String(name).match(/^(btc|eth|sol|xrp|doge)-/i);
  return m ? m[1].toUpperCase() : name;
}

function analyzeFile(file) {
  const rows = readJsonl(file);
  const asset = assetFromFile(path.basename(file));
  const day = path.basename(file).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '?';

  const settlements = rows.filter((r) => r.type === 'position_settled');
  const submits = rows.filter((r) => r.type === 'order_submit');
  const terminals = rows.filter((r) => r.type === 'order_terminal');
  const decisions = rows.filter((r) => r.type === 'decision');

  const rejects = terminals.filter(
    (r) =>
      r.eventType === 'REJECT' ||
      r.filled === false ||
      (Number(r.qty) === 0 && r.eventType !== 'FILL'),
  );
  const fills = terminals.filter((r) => r.filled === true || r.eventType === 'FILL');

  const denyReverse = decisions.filter((d) => d.action === 'denied:REVERSE');
  const denyReasons = {};
  for (const d of denyReverse) {
    for (const x of d.denied ?? []) {
      const k = x.reasonCode ?? '?';
      denyReasons[k] = (denyReasons[k] ?? 0) + 1;
    }
  }

  const rejectBuckets = {
    minSize5: 0,
    fakMiss: 0,
    cancelFailed: 0,
    other: 0,
  };
  const rejectSamples = [];
  for (const r of rejects) {
    const reason = String(r.reason ?? '');
    let bucket = 'other';
    if (/minimum:\s*5|lower than the minimum/i.test(reason)) bucket = 'minSize5';
    else if (/FAK|no orders found/i.test(reason)) bucket = 'fakMiss';
    else if (/CANCEL_FAILED/i.test(reason)) bucket = 'cancelFailed';
    rejectBuckets[bucket] += 1;
    if (rejectSamples.length < 12) {
      rejectSamples.push({
        marketId: r.marketId,
        kind: r.kind,
        qty: r.quantity ?? r.qty,
        price: r.price ?? r.minPrice,
        reason: reason.slice(0, 120),
        tsMs: r.tsMs,
      });
    }
  }

  const submitByKind = {};
  for (const s of submits) {
    const k = `${s.kind}:${s.reason ?? '?'}`;
    submitByKind[k] = (submitByKind[k] ?? 0) + 1;
  }

  const decisionActions = {};
  for (const d of decisions) {
    decisionActions[d.action ?? '?'] = (decisionActions[d.action ?? '?'] ?? 0) + 1;
  }

  const winners = settlements.filter((s) => Number(s.pnlDelta) > 0);
  const losers = settlements.filter((s) => Number(s.pnlDelta) < 0);
  const flats = settlements.filter((s) => Number(s.pnlDelta) === 0);
  const pnlSum = settlements.reduce((a, s) => a + (safeNum(s.pnlDelta) ?? 0), 0);

  const loserDetails = losers.map((s) => {
    const m = s.marketId;
    const mRows = rows.filter((r) => r.marketId === m || r.fromMarketId === m);
    const mSubmits = mRows.filter((r) => r.type === 'order_submit');
    const mTerms = mRows.filter((r) => r.type === 'order_terminal');
    const mDenied = mRows.filter((r) => r.action === 'denied:REVERSE');
    const mDenyReasons = {};
    for (const d of mDenied) {
      for (const x of d.denied ?? []) {
        const k = x.reasonCode ?? '?';
        mDenyReasons[k] = (mDenyReasons[k] ?? 0) + 1;
      }
    }
    const mRejects = mTerms.filter(
      (r) => r.eventType === 'REJECT' || r.filled === false || Number(r.qty) === 0,
    );

    const firstDeny = mDenied[0];
    const lf = firstDeny?.diagnostics?.lateFlip;
    let reverseCf = null;
    if (lf && lf.exitBid != null && lf.oppAsk != null && s.qty != null && s.avgPrice != null) {
      const settleOpp = 1 - Number(s.settlementPrice);
      const closePnl = (Number(lf.exitBid) - Number(s.avgPrice)) * Number(s.qty);
      const revPnl = closePnl + (settleOpp - Number(lf.oppAsk)) * Number(s.qty);
      const hold = Number(s.pnlDelta);
      reverseCf = {
        secsLeft: lf.secsLeft,
        exitBid: lf.exitBid,
        oppAsk: lf.oppAsk,
        reversePnL: revPnl,
        holdPnL: hold,
        improvement: revPnl - hold,
        firstDenyReason: firstDeny?.denied?.[0]?.reasonCode ?? null,
      };
    }

    // odds-shock exit attempt?
    const shockExit = mSubmits.find((x) => String(x.reason ?? '').includes('odds_shock'));
    let exitCf = null;
    if (shockExit && s.qty != null && s.avgPrice != null) {
      const bid = safeNum(shockExit.book?.bid) ?? safeNum(shockExit.minPrice);
      if (bid != null) {
        const fullExit = (bid - Number(s.avgPrice)) * Number(s.qty);
        exitCf = {
          secsLeft: shockExit.secsLeft,
          bid,
          qtyRequested: shockExit.quantity,
          fullExitPnL: fullExit,
          holdPnL: Number(s.pnlDelta),
          improvement: fullExit - Number(s.pnlDelta),
        };
      }
    }

    return {
      marketId: m,
      side: s.side,
      qty: s.qty,
      avgPrice: s.avgPrice,
      winner: s.winner,
      settlementPrice: s.settlementPrice,
      pnlDelta: s.pnlDelta,
      submits: mSubmits.map((x) => ({
        kind: x.kind,
        reason: x.reason,
        qty: x.quantity,
        minPrice: x.minPrice,
        secsLeft: x.secsLeft,
      })),
      terminals: mTerms.map((x) => ({
        kind: x.kind,
        eventType: x.eventType,
        filled: x.filled,
        qty: x.qty,
        reason: String(x.reason ?? '').slice(0, 100),
      })),
      deniedReverseCount: mDenied.length,
      deniedReverseReasons: mDenyReasons,
      rejects: mRejects.map((x) => ({
        kind: x.kind,
        reason: String(x.reason ?? '').slice(0, 100),
        qty: x.qty,
      })),
      reverseCf,
      exitCf,
    };
  });

  // Patterns that support each fix
  const evidence = {
    minSizeRejects: rejectBuckets.minSize5,
    partialExitSubmits: submits.filter(
      (s) => s.kind === 'EXIT' && String(s.reason ?? '').includes('odds_shock_partial'),
    ).length,
    partialExitWithQtyLt5: submits.filter(
      (s) =>
        s.kind === 'EXIT' &&
        String(s.reason ?? '').includes('odds_shock_partial') &&
        Number(s.quantity) > 0 &&
        Number(s.quantity) < 5,
    ).length,
    deniedReverseMaxNotional: denyReasons.MAX_NOTIONAL_EVENT ?? 0,
    deniedReverseCircuitOpen: denyReasons.CIRCUIT_OPEN ?? 0,
    deniedReverseOther: Object.entries(denyReasons)
      .filter(([k]) => k !== 'MAX_NOTIONAL_EVENT' && k !== 'CIRCUIT_OPEN')
      .reduce((a, [, v]) => a + v, 0),
    losersWhereReverseWouldHelp: loserDetails.filter(
      (l) => l.reverseCf && l.reverseCf.improvement > 0.1,
    ).length,
    losersWhereExitWouldHelp: loserDetails.filter(
      (l) => l.exitCf && l.exitCf.improvement > 0.1,
    ).length,
    losersWithMinSizeReject: loserDetails.filter((l) =>
      l.rejects.some((r) => /minimum:\s*5|lower than the minimum/i.test(r.reason)),
    ).length,
  };

  return {
    file: path.basename(file),
    asset,
    day,
    lines: rows.length,
    settlements: settlements.length,
    wins: winners.length,
    losses: losers.length,
    flats: flats.length,
    pnlSum,
    fills: fills.length,
    rejects: rejects.length,
    rejectBuckets,
    denyReverse: denyReverse.length,
    denyReasons,
    decisionActions,
    submitByKind,
    evidence,
    loserDetails,
    rejectSamples,
  };
}

function main() {
  const dir = process.argv[2] ?? 'runs/labs-audit';
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort();

  if (!files.length) {
    console.error('nenhum jsonl em', dir);
    process.exit(1);
  }

  const reports = files.map(analyzeFile);

  const totals = {
    lines: 0,
    settlements: 0,
    wins: 0,
    losses: 0,
    pnlSum: 0,
    rejects: 0,
    denyReverse: 0,
    evidence: {
      minSizeRejects: 0,
      partialExitSubmits: 0,
      partialExitWithQtyLt5: 0,
      deniedReverseMaxNotional: 0,
      deniedReverseCircuitOpen: 0,
      deniedReverseOther: 0,
      losersWhereReverseWouldHelp: 0,
      losersWhereExitWouldHelp: 0,
      losersWithMinSizeReject: 0,
    },
    denyReasons: {},
    rejectBuckets: { minSize5: 0, fakMiss: 0, cancelFailed: 0, other: 0 },
  };

  for (const r of reports) {
    totals.lines += r.lines;
    totals.settlements += r.settlements;
    totals.wins += r.wins;
    totals.losses += r.losses;
    totals.pnlSum += r.pnlSum;
    totals.rejects += r.rejects;
    totals.denyReverse += r.denyReverse;
    for (const [k, v] of Object.entries(r.evidence)) totals.evidence[k] += v;
    for (const [k, v] of Object.entries(r.denyReasons)) {
      totals.denyReasons[k] = (totals.denyReasons[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(r.rejectBuckets)) {
      totals.rejectBuckets[k] += v;
    }
  }

  const allLosers = reports.flatMap((r) =>
    r.loserDetails.map((l) => ({ asset: r.asset, day: r.day, ...l })),
  );

  const verdict = {
    keep_minSize_fix:
      totals.evidence.minSizeRejects > 0 ||
      totals.evidence.partialExitWithQtyLt5 > 0 ||
      totals.evidence.losersWithMinSizeReject > 0,
    keep_oddsShock_noPartialBelow5:
      totals.evidence.partialExitWithQtyLt5 > 0 || totals.evidence.losersWithMinSizeReject > 0,
    keep_policy_denials_out_of_circuit:
      (totals.denyReasons.MAX_NOTIONAL_EVENT ?? 0) > 0 &&
      (totals.denyReasons.CIRCUIT_OPEN ?? 0) > (totals.denyReasons.MAX_NOTIONAL_EVENT ?? 0),
    keep_notional_headroom_for_reverse:
      (totals.denyReasons.MAX_NOTIONAL_EVENT ?? 0) > 0 &&
      totals.evidence.losersWhereReverseWouldHelp > 0,
    keep_oddsShock_retry_or_reverse:
      totals.evidence.losersWhereExitWouldHelp > 0 ||
      totals.evidence.losersWhereReverseWouldHelp > 0,
  };

  console.log(
    JSON.stringify(
      {
        totals,
        verdict,
        byFile: reports.map((r) => ({
          file: r.file,
          asset: r.asset,
          day: r.day,
          lines: r.lines,
          settlements: r.settlements,
          wins: r.wins,
          losses: r.losses,
          pnlSum: r.pnlSum,
          rejects: r.rejects,
          rejectBuckets: r.rejectBuckets,
          denyReverse: r.denyReverse,
          denyReasons: r.denyReasons,
          evidence: r.evidence,
          decisionActions: r.decisionActions,
        })),
        losers: allLosers,
      },
      null,
      2,
    ),
  );
}

main();
