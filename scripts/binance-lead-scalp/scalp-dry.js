#!/usr/bin/env node
/**
 * Binance-lead scalp — dry/shadow WS na Giovanna.
 *
 * Default e-golden: adapt + sharesCap@0.50 + rescueStop 0.15 + pre-dump.
 * ZERO ordens CLOB. Recusa --live.
 *
 *   node scripts/binance-lead-scalp/scalp-dry.js --variant=e-golden --max-events=12 --fill=honest
 *   docker exec pair-path-micro node scripts/binance-lead-scalp/scalp-dry.js --max-events=12 --poll-ms=50
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { startBinanceSpotFeed } from '../../src/feeds/binanceSpotFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  VARIANT_E,
  VARIANT_E_FREQ,
  VARIANT_E_ADAPT,
  VARIANT_E_GOLDEN,
  SIZING_MODES,
  createEventState,
  createSpotRing,
  createMidRing,
  spotRingSecsFor,
  impulseThreshold,
  pushSpot,
  pushMid,
  tryEntry,
  applyEntryFill,
  managePosition,
  forceCloseEod,
  summarize,
} from './scalp-engine.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}

function resolveVariant(name) {
  const n = String(name || 'e-golden').toLowerCase();
  if (n === 'e') return { name: 'e', base: VARIANT_E };
  if (n === 'e-freq') return { name: 'e-freq', base: VARIANT_E_FREQ };
  if (n === 'e-adapt') return { name: 'e-adapt', base: VARIANT_E_ADAPT };
  if (n === 'e-golden' || n === 'golden') return { name: 'e-golden', base: VARIANT_E_GOLDEN };
  return { name: 'e-golden', base: VARIANT_E_GOLDEN };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  if (args.includes('--live') || args.includes('--live=1')) {
    throw new Error('scalp-dry recusa --live (só dry/shadow WS).');
  }
  const fill = String(valueOf('--fill') ?? 'honest').toLowerCase();
  if (!['honest', 'cruel'].includes(fill)) {
    throw new Error('--fill deve ser honest|cruel');
  }
  const { name: variantName, base } = resolveVariant(valueOf('--variant') ?? 'e-golden');
  const impulseUsd = Number(valueOf('--impulse-usd') ?? base.impulseUsd);
  const staleMid = Number(valueOf('--stale-mid') ?? base.staleMidMoveMax);
  const impulseVolMult = Number(valueOf('--impulse-vol-mult') ?? base.impulseVolMult);
  const impulseFloor = Number(valueOf('--impulse-floor') ?? base.impulseFloor);
  const impulseCap = Number(valueOf('--impulse-cap') ?? base.impulseCap);
  const volWindowSec = Number(valueOf('--vol-window') ?? base.volWindowSec);
  const rescue = args.includes('--no-rescue')
    ? false
    : args.includes('--rescue')
      ? true
      : base.rescue;
  const rescueOffset = Number(valueOf('--rescue-offset') ?? base.rescueOffset);
  const rescueStop = Number(valueOf('--rescue-stop') ?? base.rescueStop);
  const minTau = Number(valueOf('--min-tau') ?? base.minTau);
  const maxTau = Number(valueOf('--max-tau') ?? base.maxTau);
  const sizingRaw = valueOf('--sizing') ?? base.sizingMode ?? 'none';
  const sizingMode = SIZING_MODES.includes(sizingRaw) ? sizingRaw : base.sizingMode ?? 'none';
  const sharesCapAsk = Number(valueOf('--shares-cap-ask') ?? base.sharesCapAsk ?? 0.5);
  const immediateDisasterDump = args.includes('--no-immediate-disaster-dump')
    ? false
    : args.includes('--immediate-disaster-dump')
      ? true
      : base.immediateDisasterDump !== false;
  const budget = Math.max(1, parseFloat(valueOf('--budget') ?? String(base.budget)) || 10);
  return {
    variantName,
    params: {
      ...base,
      impulseUsd: Number.isFinite(impulseUsd) ? impulseUsd : base.impulseUsd,
      staleMidMoveMax: Number.isFinite(staleMid) ? staleMid : base.staleMidMoveMax,
      impulseVolMult: Number.isFinite(impulseVolMult) ? impulseVolMult : base.impulseVolMult,
      impulseFloor: Number.isFinite(impulseFloor) ? impulseFloor : base.impulseFloor,
      impulseCap: Number.isFinite(impulseCap) ? impulseCap : base.impulseCap,
      volWindowSec: Number.isFinite(volWindowSec) ? volWindowSec : base.volWindowSec,
      rescue,
      rescueOffset: Number.isFinite(rescueOffset) ? rescueOffset : base.rescueOffset,
      rescueStop: Number.isFinite(rescueStop) ? rescueStop : base.rescueStop,
      minTau: Number.isFinite(minTau) && minTau >= 0 ? minTau : base.minTau,
      maxTau: Number.isFinite(maxTau) && maxTau > 0 ? maxTau : base.maxTau,
      sizingMode,
      sharesCapAsk:
        Number.isFinite(sharesCapAsk) && sharesCapAsk > 0 ? sharesCapAsk : base.sharesCapAsk ?? 0.5,
      immediateDisasterDump,
      budget,
    },
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '24', 10) || 24),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(60, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '60', 10) || 0),
    waitTimeoutSec: Math.max(
      30,
      parseInt(valueOf('--wait-timeout') ?? String(Math.max(600, 12 * 400)), 10) || 600,
    ),
    budget,
    fill,
    cruelLatencyMs: Math.max(0, parseInt(valueOf('--cruel-latency-ms') ?? '80', 10) || 0),
    warmSec: Math.max(3, parseInt(valueOf('--warm-sec') ?? '6', 10) || 6),
  };
}

async function waitFreshBook(clobFeed, state, maxBookAgeMs) {
  for (let i = 0; i < 80; i++) {
    const lag = clobFeed.lagMs();
    if (
      state.up.bestAsk != null &&
      state.down.bestAsk != null &&
      Number.isFinite(lag) &&
      lag < maxBookAgeMs
    ) {
      return true;
    }
    if (i > 0 && i % 20 === 0) await clobFeed.refreshBooks();
    await sleep(50);
  }
  return false;
}

function bookSnap(state) {
  return {
    UP: state.up,
    DOWN: state.down,
  };
}

function pushMids(midRing, state, now) {
  for (const side of ['UP', 'DOWN']) {
    const b = state[side === 'UP' ? 'up' : 'down'];
    if (Number.isFinite(b?.bestAsk) && Number.isFinite(b?.bestBid)) {
      pushMid(midRing, now, side, (b.bestAsk + b.bestBid) / 2);
    }
  }
}

async function runOneEvent({ opts, feedCtx, spotRing, midRing }) {
  const event = await findActiveBtc5mEvent();
  if (!event?.upTokenId || !event?.downTokenId) throw new Error('no active BTC 5m event');

  const startMs =
    event.eventStart instanceof Date
      ? event.eventStart.getTime()
      : Number(event.eventStartMs ?? event.eventStart) || Date.now();
  const endMs =
    event.eventEnd instanceof Date
      ? event.eventEnd.getTime()
      : Number(event.eventEndMs ?? startMs + 300_000);
  const tau0 = Math.floor((endMs - Date.now()) / 1000);

  if (tau0 < opts.minTauStart && opts.minTauStart > 0) {
    return { skipped: true, reason: 'tau_low', tau: tau0, event: event.slug };
  }
  if (tau0 < opts.params.minTau) {
    return { skipped: true, reason: 'tau_past_window', tau: tau0, event: event.slug };
  }

  const { state, clobFeed } = feedCtx;
  clobFeed.subscribe(event.upTokenId, event.downTokenId);
  await clobFeed.refreshBooks();
  if (!(await waitFreshBook(clobFeed, state, opts.maxBookAgeMs))) {
    return { skipped: true, reason: 'book_stale', event: event.slug };
  }

  const st = createEventState({
    ...opts.params,
    budget: opts.budget,
  });

  const decisionLatency = [];
  const eventDeadline = Date.now() + Math.min(opts.timeoutSec, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let loops = 0;
  let staleBlocks = 0;
  let lastStaleRefresh = 0;
  let pendingIntent = null;
  let pendingAt = 0;
  const P = opts.params;
  const thrDesc =
    P.impulseVolMult > 0
      ? `impulse=adapt(${P.impulseVolMult}σ∈$${P.impulseFloor}–$${P.impulseCap}, win=${P.volWindowSec}s, fb=$${P.impulseUsd})`
      : `impulse≥$${P.impulseUsd}/${P.leadSec}s`;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s fill=${opts.fill} budget=$${opts.budget}` +
      ` variant=${opts.variantName} ${thrDesc} stale≤${P.staleMidMoveMax}` +
      ` ladder=+${P.ladderOffsets.join('/+')} timeout=${P.timeoutSec}s`,
  );

  while (Date.now() < eventDeadline) {
    const now = Date.now();
    const tau = Math.floor((endMs - now) / 1000);
    if (tau <= 0) break;

    const lag = clobFeed.lagMs();
    const bookFresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;
    if (!bookFresh && now - lastStaleRefresh >= 1000) {
      lastStaleRefresh = now;
      await clobFeed.refreshBooks();
    }

    if (state.binance != null) {
      pushSpot(spotRing, now, state.binance);
    }
    pushMids(midRing, state, now);
    loops += 1;

    if (now - lastHb >= 5_000) {
      lastHb = now;
      const sum = summarize(st);
      const spotAge =
        state.binanceReceivedAt != null ? Math.round(now - state.binanceReceivedAt) : null;
      const thr = impulseThreshold(spotRing, now, P);
      const openStr = sum.openPos
        ? `${sum.openPos.side}@${sum.openPos.entryAsk}${sum.openPos.rescue ? '/R' : ''}`
        : '-';
      const topSkips = Object.entries(sum.blockCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(',') || '-';
      console.log(
        `… hb tau=${tau} up=${state.up.bestAsk}/${state.up.bestBid}` +
          ` dn=${state.down.bestAsk}/${state.down.bestBid}` +
          ` bn=${state.binance} thr=${thr.toFixed(2)} trades=${sum.trades} pnl=${sum.lucroLiquido}` +
          ` open=${openStr}` +
          ` bookLag=${Number.isFinite(lag) ? Math.round(lag) : null}` +
          ` spotAge=${spotAge} fresh=${bookFresh} skip=${sum.lastNoEntryReason || '-'}` +
          ` blocks=${topSkips}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(opts.pollMs);
      continue;
    }

    const book = bookSnap(state);

    // 1) gerir posição aberta
    if (st.pos) {
      const closed = managePosition(st, { book, nowMs: now, fillMode: opts.fill });
      if (closed?.action === 'rescue') {
        console.log(
          `RESCUE enter ${closed.side} trigger=${closed.trigger}` +
            ` entry=${closed.entryAsk} ask=${closed.limitPx}` +
            ` rem=${closed.remaining} sh=${closed.shares}`,
        );
      } else if (closed) {
        console.log(
          `EXIT ${closed.reason} ${closed.side} entry=${closed.entryAsk} exit≈${closed.exitPx}` +
            ` pnl=${closed.pnl} hold=${closed.holdSec}s makerSh=${closed.makerExitShares}` +
            ` takerSh=${closed.takerExitShares} fees=${roundFee(closed.entryFee + closed.exitFee)}`,
        );
      }
      await sleep(opts.pollMs);
      continue;
    }

    // 2) fill pendente (cruel latency)
    if (pendingIntent && now - pendingAt >= opts.cruelLatencyMs) {
      const sideKey = pendingIntent.side === 'UP' ? 'up' : 'down';
      const fillAsk = state[sideKey]?.bestAsk;
      const res = applyEntryFill(st, pendingIntent, {
        fillMode: opts.fill,
        fillAsk,
        nowMs: now,
      });
      if (res.ok) {
        console.log(
          `ENTER fill ${pendingIntent.side} @${res.ask} sh=${res.shares.toFixed(2)}` +
            ` fee=${res.entryFee.toFixed(3)} binRet=${pendingIntent.binRet}` +
            ` thr=${pendingIntent.impulseMin}` +
            ` ladder=${res.ladder.map((l) => l.limitPx).join(',')}`,
        );
      } else {
        console.log(`ENTER aborted ${res.reason}`);
      }
      pendingIntent = null;
      await sleep(opts.pollMs);
      continue;
    }

    // 3) sinal de entrada
    if (!pendingIntent && tau >= opts.params.minTau && tau <= opts.params.maxTau) {
      const t0 = performance.now();
      const spotAgeMs =
        state.binanceReceivedAt != null ? now - state.binanceReceivedAt : null;
      const intent = tryEntry(st, {
        spotRing,
        midRing,
        book,
        tau,
        nowMs: now,
        spotAgeMs,
        bookAgeMs: lag,
      });
      decisionLatency.push(Math.round(performance.now() - t0));
      if (intent?.action === 'enter') {
        console.log(
          `ENTER intent ${intent.side} ask=${intent.ask} binRet=${intent.binRet}` +
            ` thr=${intent.impulseMin} τ=${intent.tau}` +
            ` spot=${intent.spotPrev?.toFixed?.(1)}→${intent.spotNow?.toFixed?.(1)}`,
        );
        if (opts.fill === 'cruel' && opts.cruelLatencyMs > 0) {
          pendingIntent = intent;
          pendingAt = now;
        } else {
          const res = applyEntryFill(st, intent, { fillMode: 'honest', nowMs: now });
          if (res.ok) {
            console.log(
              `ENTER fill ${intent.side} @${res.ask} sh=${res.shares.toFixed(2)}` +
                ` fee=${res.entryFee.toFixed(3)} binRet=${intent.binRet}` +
                ` thr=${intent.impulseMin}` +
                ` ladder=${res.ladder.map((l) => l.limitPx).join(',')}`,
            );
          }
        }
      }
    }

    await sleep(opts.pollMs);
  }

  // fim do evento / deadline
  if (st.pos) {
    const closed = forceCloseEod(st, bookSnap(state), Date.now());
    if (closed) {
      console.log(
        `EXIT ${closed.reason} ${closed.side} pnl=${closed.pnl} hold=${closed.holdSec}s`,
      );
    }
  }

  const latSorted = [...decisionLatency].sort((a, b) => a - b);
  const p95 =
    latSorted.length > 0
      ? latSorted[Math.min(latSorted.length - 1, Math.floor(latSorted.length * 0.95))]
      : null;

  return {
    skipped: false,
    generatedAt: nowIso(),
    dry: true,
    strategy: 'binance-lead-scalp',
    variant: opts.params.id,
    setup: opts.variantName,
    fillMode: opts.fill,
    event: {
      slug: event.slug,
      title: event.title,
      upTokenId: event.upTokenId,
      downTokenId: event.downTokenId,
      endMs,
    },
    loops,
    staleBlocks,
    decisionLatencyMs: {
      n: latSorted.length,
      p50: latSorted[Math.floor(latSorted.length / 2)] ?? null,
      p95,
    },
    result: summarize(st),
    trades: st.trades,
    blocks: st.blocks.slice(-40),
  };
}

function roundFee(x) {
  return Math.round(x * 1000) / 1000;
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Binance-lead scalp dry (WS · zero ordens) ===');
  console.log(
    `variant=${opts.variantName} maxEvents=${opts.maxEvents} fill=${opts.fill} budget=$${opts.budget} pollMs=${opts.pollMs}`,
  );
  const P = opts.params;
  const thrDesc =
    P.impulseVolMult > 0
      ? `impulse=adapt(${P.impulseVolMult}σ ∈$${P.impulseFloor}–$${P.impulseCap} win=${P.volWindowSec}s fb=$${P.impulseUsd})`
      : `impulse≥$${P.impulseUsd}/${P.leadSec}s`;
  const rescueDesc = P.rescue
    ? ` rescue=+${P.rescueOffset}${P.rescueStop > 0 ? `/ds-${P.rescueStop}` : '/hold'}`
    : '';
  const sizeDesc =
    P.sizingMode && P.sizingMode !== 'none'
      ? ` sizing=${P.sizingMode}${P.sizingMode === 'sharesCap' || P.sizingMode === 'dynamicBudget' ? `@${P.sharesCapAsk}` : ''}`
      : ' sizing=none';
  console.log(
    `${opts.variantName}: ${thrDesc} staleMid≤${P.staleMidMoveMax}` +
      ` ladder=+${P.ladderOffsets.join('/+')}` +
      ` stop=-${P.stopLoss} timeout=${P.timeoutSec}s${rescueDesc}${sizeDesc}` +
      ` dump=${P.immediateDisasterDump !== false ? 'immed' : 'soft'}` +
      ` maxTrades=${P.maxTradesPerEvent} τ=${P.minTau}–${P.maxTau}`,
  );

  if (opts.minTauStart > 0) {
    const waitDeadline = Date.now() + opts.waitTimeoutSec * 1000;
    while (Date.now() < waitDeadline) {
      const ev = await findActiveBtc5mEvent();
      if (ev?.eventEnd) {
        const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
        const tau = Math.floor((endMs - Date.now()) / 1000);
        if (tau >= opts.minTauStart) {
          console.log(`window ok slug=${ev.slug} tau=${tau}`);
          break;
        }
        console.log(`waiting… slug=${ev.slug || '?'} tau=${tau} need>=${opts.minTauStart}`);
      } else console.log('waiting… no active event');
      await sleep(2000);
    }
  }

  const state = createMarketState();
  let staleReconnects = 0;
  const stopBinance = startBinanceSpotFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(
        `⚠ binance force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`,
      );
    },
  });
  const clobFeed = createClobFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(
        `⚠ clob force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`,
      );
    },
  });
  const spotRing = createSpotRing(spotRingSecsFor(opts.params));
  const midRing = createMidRing(12);

  const warmNeed =
    opts.params.impulseVolMult > 0
      ? Math.min(opts.warmSec, 6) // ring enche durante o run; warm mínimo só garante feed
      : opts.warmSec;
  console.log(`warming Binance (~${warmNeed}s; spotRing=${spotRing.maxSecs}s)…`);
  const warmDeadline = Date.now() + warmNeed * 1000;
  while (Date.now() < warmDeadline) {
    if (state.binance != null) pushSpot(spotRing, Date.now(), state.binance);
    await sleep(100);
  }
  console.log(
    `warm samples=${spotRing.pts.length} bn=${state.binance} ws=${state.wsBinanceConnected}`,
  );
  if (state.binance == null || spotRing.pts.length < 5) {
    throw new Error('Binance spot feed não entregou ticks no warm-up');
  }

  const outDir = path.resolve('runs/binance-lead-scalp-dry');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  let lastSlug = null;

  async function waitNextWindow(afterSlug) {
    const waitDeadline = Date.now() + opts.waitTimeoutSec * 1000;
    while (Date.now() < waitDeadline) {
      const ev = await findActiveBtc5mEvent();
      if (ev?.eventEnd) {
        const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
        const tau = Math.floor((endMs - Date.now()) / 1000);
        const slug = ev.slug || null;
        if (slug && slug !== afterSlug && tau >= Math.max(opts.minTauStart, 60)) {
          console.log(`next window ok slug=${slug} tau=${tau}`);
          return;
        }
        console.log(`waiting next… slug=${slug || '?'} tau=${tau} after=${afterSlug || '-'}`);
      } else console.log('waiting next… no active event');
      await sleep(2000);
    }
  }

  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      if (i > 0) await waitNextWindow(lastSlug);
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runOneEvent({
        opts,
        feedCtx: { state, clobFeed },
        spotRing,
        midRing,
      });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip: ${rep.reason} tau=${rep.tau ?? '-'}`);
        await sleep(2000);
        if (rep.reason === 'tau_low' || rep.reason === 'tau_past_window') {
          i -= 1;
          await waitNextWindow(rep.event || lastSlug);
        }
        continue;
      }
      lastSlug = rep.event?.slug || lastSlug;
      const r = rep.result;
      console.log(
        `result trades=${r.trades} wr=${r.winRate}% bruto=${r.lucroBruto}` +
          ` fees=${r.fees} liquido=${r.lucroLiquido} pf=${r.profitFactor}` +
          ` maker%=${r.makerExitSharePct} reasons=${JSON.stringify(r.exitReasons)}`,
      );
      console.log(
        `decisionLatency p50=${rep.decisionLatencyMs.p50}ms p95=${rep.decisionLatencyMs.p95}ms`,
      );
      const fname = `scE_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);
    }
  } finally {
    try {
      clobFeed.stop?.();
    } catch {
      /* ignore */
    }
    try {
      stopBinance?.();
    } catch {
      /* ignore */
    }
  }

  const traded = reports.filter((r) => !r.skipped);
  const allTrades = traded.flatMap((r) => r.trades || []);
  const wins = allTrades.filter((t) => t.pnl > 0);
  const losses = allTrades.filter((t) => t.pnl <= 0);
  const totalPnl = allTrades.reduce((a, t) => a + t.pnl, 0);
  const fees = allTrades.reduce((a, t) => a + t.entryFee + t.exitFee, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const p95s = traded.map((r) => r.decisionLatencyMs?.p95).filter((x) => x != null);
  const maxP95 = p95s.length ? Math.max(...p95s) : null;
  const byReason = {};
  for (const t of allTrades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const summary = {
    generatedAt: nowIso(),
    dry: true,
    strategy: 'binance-lead-scalp',
    variant: opts.params.id,
    setup: opts.variantName,
    fillMode: opts.fill,
    params: { ...opts.params, budget: opts.budget },
    staleReconnects,
    eventsSeen: reports.length,
    eventsTraded: traded.length,
    trades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: allTrades.length
      ? Math.round((1000 * wins.length) / allTrades.length) / 10
      : null,
    lucroBruto: Math.round((totalPnl + fees) * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    lucroLiquido: Math.round(totalPnl * 100) / 100,
    profitFactor: grossLossAbs > 0 ? Math.round((grossProfit / grossLossAbs) * 100) / 100 : null,
    feeDrag:
      Math.abs(grossProfit) + grossLossAbs > 0
        ? Math.round((fees / (Math.abs(grossProfit) + grossLossAbs)) * 1000) / 1000
        : null,
    exitReasons: byReason,
    decisionLatencyP95MaxMs: maxP95,
    okPlumbing: maxP95 != null && maxP95 < 300,
    goHint:
      allTrades.length >= 10 &&
      grossLossAbs > 0 &&
      grossProfit / grossLossAbs >= 1.15 &&
      fees / (Math.abs(grossProfit) + grossLossAbs + 1e-9) < 0.6,
    reports: reports.map((r) =>
      r.skipped
        ? r
        : {
            slug: r.event?.slug,
            trades: r.result?.trades,
            pnl: r.result?.lucroLiquido,
            fees: r.result?.fees,
            wr: r.result?.winRate,
            p95Ms: r.decisionLatencyMs?.p95,
            exitReasons: r.result?.exitReasons,
          },
    ),
  };
  const sumPath = path.join(outDir, `summary_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`summary → ${sumPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
