/**
 * Lab: mitigações de falha de envio (ENTER / EXIT / proteção).
 *
 * Contrafactual sobre execution-audit JSONL + simulação do circuit.
 *
 *   node scripts/labs/lab-order-failure-mitigations.mjs runs/labs-audit-falhas
 *   node scripts/labs/lab-order-failure-mitigations.mjs runs/labs-audit-falhas --json
 *
 * Cenários:
 *   A) allow_reverse_on_circuit_open — REVERSE negado por CIRCUIT_OPEN passa
 *   B) partial_min5_full_exit — odds_shock_partial com qty<5 vira EXIT full
 *   C) partial_min5_skip — não posta (segura até settlement)
 *   D) exit_cap_conditional — EXIT size = min(oms, bal CONDITIONAL parseado do erro)
 *   E) no_circuit_on_expected_reject — simulação: FAK miss não abre circuit
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCircuitBreaker } from '../../src/risk/circuitBreaker.js';

const MARKET_MIN_SIZE = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

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

function listAuditFiles(root) {
  const files = [];
  function walk(dir, assetHint) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const hint =
          /btc/i.test(name) ? 'BTC' : /eth/i.test(name) ? 'ETH' : /sol/i.test(name)
            ? 'SOL'
            : /xrp/i.test(name)
              ? 'XRP'
              : /doge/i.test(name)
                ? 'DOGE'
                : assetHint;
        walk(p, hint);
      } else if (name.endsWith('.jsonl')) {
        files.push({ file: p, asset: assetHint ?? guessAsset(p) });
      }
    }
  }
  walk(root, null);
  return files;
}

function guessAsset(p) {
  const s = p.replace(/\\/g, '/');
  if (/\/btc\b|_btc|btc5m/i.test(s)) return 'BTC';
  if (/\/sol\b|_sol|sol5m/i.test(s)) return 'SOL';
  if (/\/eth\b|_eth|eth5m/i.test(s)) return 'ETH';
  if (/\/xrp\b|_xrp|xrp5m/i.test(s)) return 'XRP';
  if (/\/doge\b|_doge|doge5m/i.test(s)) return 'DOGE';
  return '?';
}

function isExpectedClobReject(reason) {
  const r = String(reason ?? '').toLowerCase();
  return (
    /no orders found to match with fak/.test(r) ||
    /lower than the minimum|minimum:\s*\d/.test(r) ||
    /couldn't be fully filled|fok orders are/.test(r) ||
    /post-only mode/.test(r) ||
    /invalid post-only/.test(r)
  );
}

function parseBalanceReject(reason) {
  const r = String(reason ?? '');
  // "balance: 2142856, order amount: 4000000" (micro-units, /1e6)
  const m = r.match(/balance:\s*(\d+).*?order amount(?:[^0-9]*)(\d+)/i);
  if (!m) return null;
  return {
    balanceShares: Number(m[1]) / 1e6,
    orderShares: Number(m[2]) / 1e6,
  };
}

function extractLateFlip(decision) {
  const lf = decision?.diagnostics?.lateFlip;
  if (!lf || lf.active !== true) return null;
  const exitBid = safeNum(lf.exitBid ?? lf.bid);
  const oppAsk = safeNum(lf.oppAsk);
  if (exitBid == null || oppAsk == null) return null;
  return {
    oppSide: lf.oppSide ?? null,
    oppAsk,
    exitBid,
    secsLeft: safeNum(lf.secsLeft),
    reason: lf.reason ?? null,
  };
}

function reverseCounterfactualDelta({ settlementPrice, qty, oldAvgPrice, exitPrice, buyAvgPrice }) {
  const closePnl = (exitPrice - oldAvgPrice) * qty;
  const settlementPnl = (settlementPrice - buyAvgPrice) * qty;
  return closePnl + settlementPnl;
}

function pickLast(items) {
  if (!items.length) return null;
  return items.reduce((a, b) => (Number(a.tsMs) >= Number(b.tsMs) ? a : b), items[0]);
}

function analyzeAsset(files) {
  const settlements = new Map();
  const deniedReverse = new Map();
  const deniedExit = new Map();
  const rejects = [];
  const submits = [];
  const terminals = [];
  const decisions = [];
  const fakMissThenCircuit = [];

  for (const { file } of files) {
    const rows = readJsonl(file);
    for (const r of rows) {
      if (r.type === 'position_settled' && r.marketId) {
        settlements.set(r.marketId, {
          marketId: r.marketId,
          qty: safeNum(r.qty),
          settlementPrice: safeNum(r.settlementPrice),
          pnlDelta: safeNum(r.pnlDelta),
          side: r.side ?? null,
          winner: r.winner ?? null,
          avgPrice: safeNum(r.avgPrice ?? r.entryAvgPrice),
          tsMs: r.tsMs ?? null,
        });
      }
      if (r.type === 'order_submit') submits.push({ ...r, _file: path.basename(file) });
      if (r.type === 'order_terminal') terminals.push({ ...r, _file: path.basename(file) });
      if (r.type === 'decision') decisions.push({ ...r, _file: path.basename(file) });

      if (r.type === 'decision' && r.action === 'denied:REVERSE' && r.marketId) {
        const position = r.position ?? null;
        const qty = safeNum(position?.qty);
        const oldAvgPrice = safeNum(position?.avgPrice);
        const lateFlip = extractLateFlip(r);
        for (const entry of r.denied ?? []) {
          if (entry?.kind !== 'REVERSE') continue;
          const reasonCode = entry.reasonCode ?? null;
          if (!reasonCode) continue;
          if (!deniedReverse.has(r.marketId)) deniedReverse.set(r.marketId, []);
          deniedReverse.get(r.marketId).push({
            tsMs: r.tsMs ?? null,
            reasonCode,
            lateFlip,
            position: qty != null && oldAvgPrice != null ? { qty, oldAvgPrice } : null,
          });
        }
      }

      if (r.type === 'decision' && r.action === 'denied:EXIT' && r.marketId) {
        for (const entry of r.denied ?? []) {
          if (!deniedExit.has(r.marketId)) deniedExit.set(r.marketId, []);
          deniedExit.get(r.marketId).push({
            tsMs: r.tsMs ?? null,
            reasonCode: entry?.reasonCode ?? null,
          });
        }
      }

      if (r.type === 'order_terminal') {
        const et = r.eventType;
        const filled = r.filled;
        if (et === 'FILL' || filled === true || et === 'ACK') continue;
        if (et === 'REJECT' || filled === false || et === 'CANCEL' || et === 'CANCELED') {
          rejects.push({
            kind: r.kind,
            reason: String(r.reason ?? ''),
            qty: safeNum(r.qty ?? r.quantity),
            price: safeNum(r.price ?? r.minPrice ?? r.maxPrice),
            marketId: r.marketId,
            intentId: r.intentId,
            orderType: r.orderType,
            tsMs: r.tsMs ?? null,
            file: path.basename(file),
          });
        }
      }
    }
  }

  // --- A) circuit open → allow reverse ---
  const baselinePnl = [...settlements.values()].reduce((a, s) => a + (s.pnlDelta ?? 0), 0);
  let cfCircuit = baselinePnl;
  let cfCircuitMarkets = 0;
  const cfCircuitSamples = [];
  let reverseDeniedCircuit = 0;
  let reverseDeniedCircuitWithLateFlip = 0;

  for (const [marketId, base] of settlements.entries()) {
    const cands = (deniedReverse.get(marketId) ?? []).filter((c) => c.reasonCode === 'CIRCUIT_OPEN');
    reverseDeniedCircuit += cands.length;
    const usable = cands.filter((c) => c.lateFlip && c.position);
    reverseDeniedCircuitWithLateFlip += usable.length;
    if (!usable.length) continue;
    if (base.settlementPrice == null || base.pnlDelta == null) continue;
    const chosen = pickLast(usable);
    const delta =
      reverseCounterfactualDelta({
        settlementPrice: 1 - base.settlementPrice,
        qty: chosen.position.qty,
        oldAvgPrice: chosen.position.oldAvgPrice,
        exitPrice: chosen.lateFlip.exitBid,
        buyAvgPrice: chosen.lateFlip.oppAsk,
      }) - base.pnlDelta;
    if (Math.abs(delta) < 1e-9) continue;
    cfCircuit += delta;
    cfCircuitMarkets += 1;
    if (cfCircuitSamples.length < 12) {
      cfCircuitSamples.push({
        marketId,
        delta: round4(delta),
        baseline: round4(base.pnlDelta),
        cf: round4(base.pnlDelta + delta),
        exitBid: chosen.lateFlip.exitBid,
        oppAsk: chosen.lateFlip.oppAsk,
        secsLeft: chosen.lateFlip.secsLeft,
      });
    }
  }

  // --- cascade: FAK miss ENTER → CIRCUIT deny REVERSE within cooldown ---
  const enterFakMiss = rejects.filter(
    (r) => r.kind === 'ENTER' && /no orders found|fak/i.test(r.reason),
  );
  for (const miss of enterFakMiss) {
    if (!miss.marketId || miss.tsMs == null) continue;
    const denies = (deniedReverse.get(miss.marketId) ?? []).filter(
      (d) =>
        d.reasonCode === 'CIRCUIT_OPEN' &&
        d.tsMs != null &&
        d.tsMs >= miss.tsMs &&
        d.tsMs - miss.tsMs <= CIRCUIT_COOLDOWN_MS * 3,
    );
    if (denies.length) {
      fakMissThenCircuit.push({
        marketId: miss.marketId,
        missTs: miss.tsMs,
        denyCount: denies.length,
        firstDenyLagMs: denies[0].tsMs - miss.tsMs,
      });
    }
  }

  // posição no momento do EXIT (decision.position antes/ao redor do submit)
  function positionNear(marketId, tsMs) {
    const cands = decisions.filter(
      (d) =>
        d.marketId === marketId &&
        d.position &&
        safeNum(d.position.qty) != null &&
        (tsMs == null || d.tsMs == null || d.tsMs <= tsMs + 50),
    );
    if (!cands.length) return null;
    const chosen = pickLast(cands);
    return {
      qty: safeNum(chosen.position.qty),
      avgPrice: safeNum(chosen.position.avgPrice),
      side: chosen.position.side ?? null,
    };
  }

  // --- B/C) partial minSize ---
  const partialSubmits = submits.filter((s) =>
    String(s.reason ?? '').includes('odds_shock_partial'),
  );
  const partialLab = {
    submits: partialSubmits.length,
    belowMin: 0,
    rejectMin5: 0,
    fill: 0,
    fillBelowMin: 0,
    otherReject: 0,
    fullAlsoBelowMin: 0,
    fullExitWouldPostGeMin: 0,
    fullExitEstPnlVsHold: 0,
    fullExitSamples: [],
    skipKeepsHold: 0,
    // política: se full < min, tentar post full mesmo assim (CLOB às vezes aceita)
    tryFullAnywayEstPnlVsHold: 0,
    tryFullAnywaySamples: [],
  };

  for (const s of partialSubmits) {
    const qty = safeNum(s.quantity ?? s.qty);
    const price = safeNum(s.minPrice ?? s.price ?? s.maxPrice);
    const term = terminals.find((t) => t.intentId === s.intentId);
    const reason = String(term?.reason ?? '');
    const filled = term?.filled === true || term?.eventType === 'FILL';
    const below = qty != null && qty < MARKET_MIN_SIZE;
    if (below) partialLab.belowMin += 1;

    if (filled) {
      partialLab.fill += 1;
      if (below) partialLab.fillBelowMin += 1;
      continue;
    }
    if (/minimum|lower than the minimum/i.test(reason)) {
      partialLab.rejectMin5 += 1;
      const settle = settlements.get(s.marketId);
      const pos = positionNear(s.marketId, s.tsMs);
      const posQty = pos?.qty ?? (qty != null ? qty / 0.5 : null);
      const avg = pos?.avgPrice ?? settle?.avgPrice ?? null;
      const settlePx = settle?.settlementPrice ?? null;
      if (posQty != null && posQty < MARKET_MIN_SIZE) {
        partialLab.fullAlsoBelowMin += 1;
      }
      if (posQty != null && posQty >= MARKET_MIN_SIZE) {
        partialLab.fullExitWouldPostGeMin += 1;
      }
      if (posQty != null && price != null && avg != null && settlePx != null) {
        const holdPnl = (settlePx - avg) * posQty;
        const exitPnl = (price - avg) * posQty;
        const delta = exitPnl - holdPnl;
        partialLab.tryFullAnywayEstPnlVsHold += delta;
        if (posQty >= MARKET_MIN_SIZE) {
          partialLab.fullExitEstPnlVsHold += delta;
        }
        const sample = {
          marketId: s.marketId,
          partialQty: qty,
          fullQty: posQty,
          exitPrice: price,
          settlePx,
          holdPnl: round4(holdPnl),
          exitPnl: round4(exitPnl),
          deltaVsHold: round4(delta),
          fullBelowMin: posQty < MARKET_MIN_SIZE,
        };
        if (partialLab.tryFullAnywaySamples.length < 10) {
          partialLab.tryFullAnywaySamples.push(sample);
        }
        if (posQty >= MARKET_MIN_SIZE && partialLab.fullExitSamples.length < 10) {
          partialLab.fullExitSamples.push(sample);
        }
      }
      partialLab.skipKeepsHold += 1;
    } else if (term?.eventType === 'REJECT') {
      partialLab.otherReject += 1;
    }
  }

  // --- F) depth/slip retry ENTER ---
  // FAK miss seguido de ENTER fill no mesmo market com maxPrice >= miss → slip/retry ajuda
  const slipLab = {
    fakMissEnters: 0,
    laterFillSameMarket: 0,
    laterFillHigherSlip: 0,
    exhaustedNoFill: 0,
    samples: [],
  };
  for (const miss of rejects.filter(
    (r) => r.kind === 'ENTER' && /no orders found|fak/i.test(r.reason),
  )) {
    slipLab.fakMissEnters += 1;
    const missSubmit = submits.find((s) => s.intentId === miss.intentId);
    const missMax = safeNum(missSubmit?.maxPrice ?? miss.price);
    const laterFills = terminals.filter(
      (t) =>
        t.kind === 'ENTER' &&
        t.marketId === miss.marketId &&
        (t.filled === true || t.eventType === 'FILL') &&
        miss.tsMs != null &&
        t.tsMs != null &&
        t.tsMs > miss.tsMs &&
        t.tsMs - miss.tsMs <= 120_000,
    );
    if (laterFills.length) {
      slipLab.laterFillSameMarket += 1;
      const fill = laterFills[0];
      const fillSubmit = submits.find((s) => s.intentId === fill.intentId);
      const fillMax = safeNum(fillSubmit?.maxPrice ?? fill.price);
      if (missMax != null && fillMax != null && fillMax > missMax + 1e-9) {
        slipLab.laterFillHigherSlip += 1;
      }
      if (slipLab.samples.length < 8) {
        slipLab.samples.push({
          marketId: miss.marketId,
          missMax,
          fillMax,
          fillPrice: safeNum(fill.price),
          lagMs: fill.tsMs - miss.tsMs,
        });
      }
    } else {
      // retries no mesmo market sem fill
      const laterMiss = rejects.filter(
        (r) =>
          r.kind === 'ENTER' &&
          r.marketId === miss.marketId &&
          r.tsMs != null &&
          miss.tsMs != null &&
          r.tsMs > miss.tsMs,
      );
      if (laterMiss.length >= 1) slipLab.exhaustedNoFill += 1;
    }
  }

  // --- D) exit cap conditional ---
  const balanceRejects = rejects.filter(
    (r) => r.kind === 'EXIT' && /not enough balance|allowance/i.test(r.reason),
  );
  const balanceLab = {
    rejects: balanceRejects.length,
    parseable: 0,
    wouldAcceptResized: 0,
    stillBelowMin: 0,
    samples: [],
    cascadeCircuitAfter: 0,
  };

  for (const r of balanceRejects) {
    const parsed = parseBalanceReject(r.reason);
    if (!parsed) continue;
    balanceLab.parseable += 1;
    const resized = Math.floor(parsed.balanceShares * 1e6) / 1e6;
    // min5 não é absoluto (há FILL EXIT qty=2 no BTC); resized>0 e < order é candidato
    if (resized >= MARKET_MIN_SIZE) {
      balanceLab.wouldAcceptResized += 1;
    } else if (resized > 0) {
      balanceLab.stillBelowMin += 1;
    }
    if (balanceLab.samples.length < 8) {
      balanceLab.samples.push({
        marketId: r.marketId,
        ...parsed,
        resized,
        wouldAcceptAtMin5: resized >= MARKET_MIN_SIZE,
        tryPostResidual: resized > 0,
        price: r.price,
      });
    }
    // circuit cascade after this reject
    if (r.tsMs != null && r.marketId) {
      const later = rejects.filter(
        (x) =>
          x.marketId === r.marketId &&
          x.tsMs != null &&
          x.tsMs > r.tsMs &&
          x.tsMs - r.tsMs <= CIRCUIT_COOLDOWN_MS &&
          /CIRCUIT_OPEN/i.test(x.reason),
      );
      balanceLab.cascadeCircuitAfter += later.length;
    }
  }

  // EXIT minSize rejects (non-partial counted too)
  const exitMinRejects = rejects.filter(
    (r) => r.kind === 'EXIT' && /lower than the minimum|minimum:\s*\d/i.test(r.reason),
  );

  // bucket rejects
  const rejectBuckets = {};
  for (const r of rejects) {
    let b = 'other';
    if (/no orders found|fak/i.test(r.reason)) b = 'fak_miss';
    else if (/lower than the minimum|minimum:/i.test(r.reason)) b = 'min_size';
    else if (/not enough balance|allowance/i.test(r.reason)) b = 'balance';
    else if (/CIRCUIT_OPEN/i.test(r.reason)) b = 'circuit_open';
    else if (/REVERSE_EXIT_INCOMPLETE/i.test(r.reason)) b = 'reverse_exit_incomplete';
    else if (/REVERSE_ENTER_FAILED/i.test(r.reason)) b = 'reverse_enter_failed';
    else if (/CANCEL_FAILED/i.test(r.reason)) b = 'cancel_failed';
    rejectBuckets[b] = (rejectBuckets[b] ?? 0) + 1;
  }

  return {
    files: files.map((f) => path.basename(f.file)),
    settlements: settlements.size,
    baselinePnl: round4(baselinePnl),
    rejects: rejects.length,
    rejectBuckets,
    scenarioA_circuitBypassReverse: {
      deniedReverseCircuitEvents: reverseDeniedCircuit,
      withLateFlipUsable: reverseDeniedCircuitWithLateFlip,
      changedMarkets: cfCircuitMarkets,
      baselinePnl: round4(baselinePnl),
      counterfactualPnl: round4(cfCircuit),
      deltaPnl: round4(cfCircuit - baselinePnl),
      helps: cfCircuit > baselinePnl,
      samples: cfCircuitSamples.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
      fakMissThenCircuitMarkets: new Set(fakMissThenCircuit.map((x) => x.marketId)).size,
      fakMissThenCircuitEvents: fakMissThenCircuit.length,
      deniedExitCircuit: [...deniedExit.values()]
        .flat()
        .filter((d) => d.reasonCode === 'CIRCUIT_OPEN').length,
    },
    scenarioB_partialFullExit: {
      ...partialLab,
      fullExitEstPnlVsHold: round4(partialLab.fullExitEstPnlVsHold),
      tryFullAnywayEstPnlVsHold: round4(partialLab.tryFullAnywayEstPnlVsHold),
      helps:
        partialLab.rejectMin5 > 0 &&
        (partialLab.fillBelowMin > 0 || partialLab.fullAlsoBelowMin > 0),
      note:
        'Com entry~$2.5 a posição full (3–4) já é < min5. Partial piora. Preferir: skip partial se qty<min; danger/full exit pode postar mesmo <5 (4/9 filled). Evitar partial que só gera reject.',
    },
    scenarioC_partialSkip: {
      rejectMin5Avoided: partialLab.rejectMin5,
      helps: partialLab.rejectMin5 > 0,
      note: 'Skip partial < min evita reject + circuit; PnL = hold até expiry/danger',
    },
    scenarioD_exitCapConditional: {
      ...balanceLab,
      exitMinSizeRejects: exitMinRejects.length,
      helps: balanceLab.rejects > 0,
      note:
        balanceLab.wouldAcceptResized > 0
          ? 'Resize ≥ min5 teria passado'
          : balanceLab.stillBelowMin > 0
            ? 'Bal residual < min5 — sync+try residual OU skip; NÃO retry qty OMS (abre circuit)'
            : 'Sem amostra parseável ou sem rejects balance',
    },
    scenarioF_slipRetryEnter: {
      ...slipLab,
      helps: slipLab.laterFillSameMarket > 0,
      retryHitRate:
        slipLab.fakMissEnters > 0
          ? round4(slipLab.laterFillSameMarket / slipLab.fakMissEnters)
          : null,
      higherSlipShareOfHits:
        slipLab.laterFillSameMarket > 0
          ? round4(slipLab.laterFillHigherSlip / slipLab.laterFillSameMarket)
          : null,
      note: 'Já existe retry até 5; lab mede se miss → fill posterior (liquidez/tempo) e se maxPrice subiu',
    },
  };
}

function round4(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e4) / 1e4;
}

/**
 * E) Simulação in-process: sequência de FAK miss + pedido de REVERSE.
 * baseline: recordFailure em todo reject → circuit abre → REVERSE negado
 * proposed: expected rejects não contam → REVERSE permitido
 */
function simulateCircuitPolicy() {
  const threshold = 5;
  const cooldownMs = 60_000;
  let now = 1_000_000;

  function run(policy) {
    const circuit = createCircuitBreaker({
      failureThreshold: threshold,
      cooldownMs,
      clock: () => now,
    });
    const log = [];
    const events = [
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: 'ENTER',
        reason: 'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
        t: now + i * 100,
      })),
      {
        kind: 'REVERSE',
        reason: null,
        t: now + 600,
        checkOnly: true,
      },
      {
        kind: 'EXIT',
        reason: 'order x is invalid. Size (2) lower than the minimum: 5',
        t: now + 700,
      },
      {
        kind: 'REVERSE',
        reason: null,
        t: now + 800,
        checkOnly: true,
      },
      {
        kind: 'EXIT',
        reason: 'not enough balance / allowance: the balance is not enough -> balance: 2142856, order amount: 4000000',
        t: now + 900,
      },
      {
        kind: 'EXIT',
        reason: null,
        t: now + 1000,
        checkOnly: true,
      },
    ];

    for (const ev of events) {
      now = ev.t;
      const evalr = circuit.evaluate();
      if (ev.checkOnly) {
        log.push({
          t: now,
          kind: ev.kind,
          action: 'evaluate',
          allow: evalr.allow,
          circuit: circuit.state,
          reasonCode: evalr.reasonCode ?? null,
        });
        continue;
      }
      // submit rejected
      const expected = isExpectedClobReject(ev.reason);
      const balanceDust = /not enough balance/i.test(ev.reason ?? '');
      let record = true;
      if (policy === 'proposed') {
        if (expected) record = false;
        // balance: still a real issue, but EXIT should bypass circuit check — modeled as checkOnly ignore
        if (ev.kind === 'EXIT' || ev.kind === 'REVERSE') {
          // protective: evaluate as allowed even if circuit open
          log.push({
            t: now,
            kind: ev.kind,
            action: 'reject_protective',
            allowSubmit: true,
            wouldRecordFailure: !expected && !balanceDust ? true : false,
            expected,
            circuit: circuit.state,
          });
          if (!expected && !balanceDust) circuit.recordFailure();
          else if (balanceDust) {
            /* proposed: don't record balance dust for EXIT either when we will resize */
          }
          continue;
        }
        if (expected) record = false;
      }
      if (record) circuit.recordFailure();
      log.push({
        t: now,
        kind: ev.kind,
        action: 'reject',
        recorded: record,
        circuit: circuit.state,
        consecutive: circuit.consecutiveFailures,
      });
    }

    const reverseEvals = log.filter((l) => l.kind === 'REVERSE' && l.action === 'evaluate');
    const exitEvals = log.filter((l) => l.kind === 'EXIT' && l.action === 'evaluate');
    return {
      policy,
      reverseAllowed: reverseEvals.filter((l) => l.allow).length,
      reverseBlocked: reverseEvals.filter((l) => !l.allow).length,
      exitAllowed: exitEvals.filter((l) => l.allow).length,
      exitBlocked: exitEvals.filter((l) => !l.allow).length,
      finalCircuit: circuit.state,
      log,
    };
  }

  const baseline = run('baseline');
  const proposed = run('proposed');
  return {
    threshold,
    cooldownMs,
    baseline: {
      reverseBlocked: baseline.reverseBlocked,
      reverseAllowed: baseline.reverseAllowed,
      exitBlocked: baseline.exitBlocked,
      finalCircuit: baseline.finalCircuit,
      log: baseline.log,
    },
    proposed: {
      reverseBlocked: proposed.reverseBlocked,
      reverseAllowed: proposed.reverseAllowed,
      exitBlocked: proposed.exitBlocked,
      finalCircuit: proposed.finalCircuit,
      protectiveBypass: proposed.log.filter((l) => l.action === 'reject_protective').length,
      log: proposed.log,
    },
    helps:
      proposed.reverseAllowed > baseline.reverseAllowed ||
      proposed.reverseBlocked < baseline.reverseBlocked,
  };
}

function verdict(assetReport, sim) {
  const a = assetReport.scenarioA_circuitBypassReverse;
  const b = assetReport.scenarioB_partialFullExit;
  const d = assetReport.scenarioD_exitCapConditional;
  const lines = [];
  if (a.deltaPnl > 0) {
    lines.push(`A circuit-bypass REVERSE: +${a.deltaPnl} PnL em ${a.changedMarkets} markets — AJUDA`);
  } else if (a.deniedReverseCircuitEvents > 0 && a.withLateFlipUsable === 0) {
    lines.push(
      `A circuit-bypass: ${a.deniedReverseCircuitEvents} denies CIRCUIT mas sem lateFlip/pos nos audits — contagem ajuda proteção, PnL não estimável`,
    );
  } else if (a.deltaPnl < 0) {
    lines.push(`A circuit-bypass REVERSE: ${a.deltaPnl} PnL — piora no contrafactual (fills teóricos ruins)`);
  } else {
    lines.push('A circuit-bypass: delta ~0 ou sem amostra');
  }
  if (b.rejectMin5 > 0) {
    lines.push(
      `B/C partial: rejectMin5=${b.rejectMin5} fullAlso<min=${b.fullAlsoBelowMin} fills<min=${b.fillBelowMin} tryFullAnyway Δ=${b.tryFullAnywayEstPnlVsHold} — skip partial AJUDA; full≥5 raro no canário $2.5`,
    );
  }
  if (d.rejects > 0) {
    lines.push(
      `D cap CONDITIONAL: resize≥5 ${d.wouldAcceptResized}/${d.rejects}; residual<5 ${d.stillBelowMin}; circuitCascade=${d.cascadeCircuitAfter} — parar de martelar AJUDA`,
    );
  }
  const f = assetReport.scenarioF_slipRetryEnter;
  if (f.fakMissEnters > 0) {
    lines.push(
      `F slip/retry ENTER: ${f.laterFillSameMarket}/${f.fakMissEnters} miss→fill posterior (hit=${f.retryHitRate}); higherSlip=${f.laterFillHigherSlip} — retry já ajuda; slip escalonado ${f.higherSlipShareOfHits > 0 ? 'às vezes' : 'raro no audit'}`,
    );
  }
  if (sim.helps) {
    lines.push(
      `E sim circuit: baseline bloqueia REVERSE=${sim.baseline.reverseBlocked}, proposed bloqueia=${sim.proposed.reverseBlocked} — AJUDA`,
    );
  }
  return lines;
}

// --- main ---
const root = process.argv[2] ?? 'runs/labs-audit-falhas';
const asJson = process.argv.includes('--json');

if (!fs.existsSync(root)) {
  console.error(`dir não encontrado: ${root}`);
  process.exit(1);
}

const allFiles = listAuditFiles(root);
const byAsset = new Map();
for (const f of allFiles) {
  if (!byAsset.has(f.asset)) byAsset.set(f.asset, []);
  byAsset.get(f.asset).push(f);
}

const sim = simulateCircuitPolicy();
const assets = {};
for (const [asset, files] of byAsset.entries()) {
  assets[asset] = analyzeAsset(files);
}

const summary = {
  root,
  generatedAt: new Date().toISOString(),
  assets,
  simulationE_circuitPolicy: sim,
  verdicts: Object.fromEntries(
    Object.entries(assets).map(([asset, rep]) => [asset, verdict(rep, sim)]),
  ),
};

const outDir = path.join(root, '_out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'mitigations-report.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('=== Lab mitigações falha de envio ===');
  console.log(`root: ${root}`);
  console.log(`report: ${outPath}`);
  console.log('');
  for (const [asset, rep] of Object.entries(assets)) {
    console.log(`--- ${asset} ---`);
    console.log(`settlements=${rep.settlements} baselinePnl=${rep.baselinePnl} rejects=${rep.rejects}`);
    console.log('buckets', rep.rejectBuckets);
    const a = rep.scenarioA_circuitBypassReverse;
    console.log(
      `A circuit-bypass REVERSE: denies=${a.deniedReverseCircuitEvents} usableLF=${a.withLateFlipUsable} marketsΔ=${a.changedMarkets} ΔPnL=${a.deltaPnl} (cf=${a.counterfactualPnl})`,
    );
    console.log(
      `  fakMiss→circuit cascade markets=${a.fakMissThenCircuitMarkets} events=${a.fakMissThenCircuitEvents}`,
    );
    const b = rep.scenarioB_partialFullExit;
    console.log(
      `B/C partial: submits=${b.submits} belowMin=${b.belowMin} rejectMin5=${b.rejectMin5} fill=${b.fill} fill<min=${b.fillBelowMin} fullAlso<min=${b.fullAlsoBelowMin} tryFullΔ=${b.tryFullAnywayEstPnlVsHold}`,
    );
    const d = rep.scenarioD_exitCapConditional;
    console.log(
      `D conditional cap: balanceRejects=${d.rejects} wouldAccept≥5=${d.wouldAcceptResized} still<min=${d.stillBelowMin} circuitCascade=${d.cascadeCircuitAfter}`,
    );
    const f = rep.scenarioF_slipRetryEnter;
    console.log(
      `F slip/retry: fakMiss=${f.fakMissEnters} laterFill=${f.laterFillSameMarket} higherSlip=${f.laterFillHigherSlip} hitRate=${f.retryHitRate}`,
    );
    console.log('verdict:');
    for (const line of summary.verdicts[asset]) console.log(`  • ${line}`);
    console.log('');
  }
  console.log('--- E simulação circuit ---');
  console.log(
    `baseline: reverse blocked=${sim.baseline.reverseBlocked} allowed=${sim.baseline.reverseAllowed} final=${sim.baseline.finalCircuit}`,
  );
  console.log(
    `proposed: reverse blocked=${sim.proposed.reverseBlocked} allowed=${sim.proposed.reverseAllowed} final=${sim.proposed.finalCircuit} helps=${sim.helps}`,
  );
}
