import fs from 'node:fs';

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readJsonl(path) {
  const text = fs.readFileSync(path, 'utf8');
  const out = [];
  for (const line of text.split(/\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function extractLateFlip(decision) {
  const lf = decision?.diagnostics?.lateFlip;
  if (!lf || lf.active !== true) return null;
  return {
    oppSide: lf.oppSide ?? null,
    oppAsk: safeNum(lf.oppAsk),
    // exit bid (SELL leg close price)
    exitBid: safeNum(lf.exitBid ?? lf.bid),
    bid: safeNum(lf.bid ?? lf.exitBid),
    hedgeStopWindow: lf.hedgeStopWindow ?? null,
    secsLeft: safeNum(lf.secsLeft),
    reason: lf.reason ?? null,
  };
}

function chooseLastByTsMs(items) {
  if (!items.length) return null;
  return items.reduce((a, b) => (Number(a.tsMs) >= Number(b.tsMs) ? a : b), items[0]);
}

function chooseFirstByTsMs(items) {
  if (!items.length) return null;
  return items.reduce((a, b) => (Number(a.tsMs) <= Number(b.tsMs) ? a : b), items[0]);
}

function computeCounterfactual({
  settlementPrice,
  qty,
  oldAvgPrice,
  exitPrice,
  buyAvgPrice,
}) {
  // Apenas delta incremental a partir do momento do reverse:
  // - closePnl acontece na perna SELL do REVERSE
  // - settlementPnl muda porque avgPrice passa a ser o preço de BUY do REVERSE
  const closePnl = (exitPrice - oldAvgPrice) * qty;
  const settlementPnl = (settlementPrice - buyAvgPrice) * qty;
  return closePnl + settlementPnl;
}

function lab({ auditPath, scenarios, pick = 'last' }) {
  const rows = readJsonl(auditPath);

  const baselineByMarket = new Map(); // marketId => baseline settle info
  for (const r of rows) {
    if (r.type !== 'position_settled') continue;
    if (!r.marketId) continue;
    const qty = safeNum(r.qty);
    const settlementPrice = safeNum(r.settlementPrice);
    const pnlDelta = safeNum(r.pnlDelta);
    if (qty == null || settlementPrice == null || pnlDelta == null) continue;
    baselineByMarket.set(r.marketId, {
      marketId: r.marketId,
      qty,
      settlementPrice,
      winner: r.winner ?? null,
      side: r.side ?? null,
      pnlDelta,
      tsMs: r.tsMs ?? null,
    });
  }

  // Denied reverse decisions can include multiple denied legs;
  // In logs we care about reasonCode for the REVERSE decision itself.
  const deniedReverseByMarket = new Map(); // marketId => [{...decision, reasonCode, lateFlip, position}]
  for (const r of rows) {
    if (r.type !== 'decision') continue;
    if (r.action !== 'denied:REVERSE') continue;
    if (!r.marketId) continue;

    const position = r.position ?? null;
    const qty = safeNum(position?.qty);
    const oldAvgPrice = safeNum(position?.avgPrice);
    const lateFlip = extractLateFlip(r);
    if (!lateFlip || lateFlip.oppAsk == null || lateFlip.exitBid == null) continue;
    if (qty == null || oldAvgPrice == null) continue;

    const deniedEntries = Array.isArray(r.denied) ? r.denied : [];
    for (const entry of deniedEntries) {
      if (!entry || entry.kind !== 'REVERSE') continue;
      const reasonCode = entry.reasonCode ?? null;
      if (!reasonCode) continue;

      if (!deniedReverseByMarket.has(r.marketId)) deniedReverseByMarket.set(r.marketId, []);
      deniedReverseByMarket.get(r.marketId).push({
        tsMs: r.tsMs ?? null,
        marketId: r.marketId,
        reasonCode,
        lateFlip,
        position: {
          qty,
          oldAvgPrice,
        },
      });
    }
  }

  const baselineTotalPnLDelta = [...baselineByMarket.values()].reduce((a, v) => a + (v.pnlDelta ?? 0), 0);

  const results = {};
  for (const [name, reasonCodesAllow] of Object.entries(scenarios)) {
    let total = baselineTotalPnLDelta;
    let changedMarkets = 0;
    const perMarket = [];

    for (const [marketId, base] of baselineByMarket.entries()) {
      const candidates = (deniedReverseByMarket.get(marketId) ?? []).filter((c) =>
        reasonCodesAllow.includes(c.reasonCode),
      );
      if (!candidates.length) continue;

      const chosen =
        pick === 'first' ? chooseFirstByTsMs(candidates) : chooseLastByTsMs(candidates);
      if (!chosen) continue;

      const closeAndSettlementDelta = computeCounterfactual({
        // Se o REVERSE é aplicado, o lado no settlement troca.
        // Em binários UP/DOWN (0/1), o preço do lado oposto fica ~1 - price.
        settlementPrice: 1 - base.settlementPrice,
        qty: chosen.position.qty,
        oldAvgPrice: chosen.position.oldAvgPrice,
        exitPrice: chosen.lateFlip.exitBid,
        buyAvgPrice: chosen.lateFlip.oppAsk,
      });

      // baseline pnlDelta é o incremento no settlement do market:
      // (settlementPrice - avgBaseline)*qty
      // No contrafactual, settlementPnl muda porque avgPrice passa a ser o preço de BUY do REVERSE.
      const delta = closeAndSettlementDelta - base.pnlDelta;
      if (Math.abs(delta) < 1e-9) continue;

      changedMarkets += 1;
      perMarket.push({
        marketId,
        reasonUsed: chosen.reasonCode,
        tsMs: chosen.tsMs,
        baselinePnLDelta: base.pnlDelta,
        counterfactualPnLDelta: base.pnlDelta + delta,
        delta,
        lateFlip: {
          exitBid: chosen.lateFlip.exitBid,
          oppAsk: chosen.lateFlip.oppAsk,
          secsLeft: chosen.lateFlip.secsLeft,
          reason: chosen.lateFlip.reason,
        },
      });
      total += delta;
    }

    results[name] = {
      baselineTotalPnLDelta: baselineTotalPnLDelta,
      counterfactualTotalPnLDelta: total,
      changedMarkets,
      perMarketSortedByDelta: perMarket.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 25),
    };
  }

  console.log(JSON.stringify(results, null, 2));
}

// CLI:
//   node scripts/labs/lab-eth-reverse-counterfactual.mjs runs/eth-audit.jsonl
const auditPath = process.argv[2];
if (!auditPath) {
  console.error('usage: node lab-eth-reverse-counterfactual.mjs <audit.jsonl>');
  process.exit(1);
}

lab({
  auditPath,
  scenarios: {
    // Supõe correção: circuit breaker não bloquear REVERSE quando o motivo é CIRCUIT_OPEN.
    allow_reverse_on_circuit_open: ['CIRCUIT_OPEN'],
    // Supõe correção: MAX_NOTIONAL_EVENT não bloquear REVERSE.
    allow_reverse_on_max_notional_event: ['MAX_NOTIONAL_EVENT'],
    // Supõe correção: ambos os motivos deixam de bloquear o reverse.
    allow_reverse_on_circuit_open_and_max_notional_event: ['CIRCUIT_OPEN', 'MAX_NOTIONAL_EVENT'],
  },
  pick: process.argv.includes('--pick=first') ? 'first' : 'last',
});

