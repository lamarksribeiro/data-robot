#!/usr/bin/env node
/**
 * Hyperion V4 Terminal (btc-hyperion-terminal-v4) — dry/shadow WS na Giovanna.
 *
 * Spot entrada: Binance · Settle: Chainlink RTDS vs PTB (fonte oficial Poly).
 * Book CLOB · Fill simulado · ZERO ordens.
 * Recusa --live.
 *
 *   node scripts/hyperion/hyperion-dry.js
 *   node scripts/hyperion/hyperion-dry.js --max-events=20 --fill=cruel --poll-ms=50
 *
 * Docker (Giovanna):
 *   docker exec pair-path-micro node scripts/hyperion/hyperion-dry.js --max-events=20 --poll-ms=50
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { startBinanceSpotFeed } from '../../src/feeds/binanceSpotFeed.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import {
  CHAMPION,
  createState,
  createSampleRing,
  pushSample,
  tryEntry,
  applyDryFill,
  settle,
  summarize,
} from './hyperion-engine.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
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
    throw new Error('hyperion-dry recusa --live (só dry/shadow WS).');
  }
  const fill = String(valueOf('--fill') ?? 'honest').toLowerCase();
  if (!['honest', 'cruel'].includes(fill)) {
    throw new Error('--fill deve ser honest|cruel');
  }
  return {
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '20', 10) || 20),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '90', 10) || 0),
    waitTimeoutSec: Math.max(
      30,
      parseInt(valueOf('--wait-timeout') ?? String(Math.max(600, 20 * 400)), 10) || 600,
    ),
    budget: Math.max(
      1,
      parseFloat(valueOf('--budget') ?? String(CHAMPION.maxOrderValue)) || CHAMPION.maxOrderValue,
    ),
    fill,
    cruelLatencyMs: Math.max(0, parseInt(valueOf('--cruel-latency-ms') ?? '80', 10) || 0),
    warmSec: Math.max(5, parseInt(valueOf('--warm-sec') ?? '40', 10) || 40),
    json: args.includes('--json'),
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

async function runOneEvent({ opts, feedCtx, ring }) {
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
  if (tau0 < CHAMPION.entryWindowEnd) {
    return { skipped: true, reason: 'tau_past_window', tau: tau0, event: event.slug };
  }

  const { state, clobFeed } = feedCtx;
  clobFeed.subscribe(event.upTokenId, event.downTokenId);
  await clobFeed.refreshBooks();
  if (!(await waitFreshBook(clobFeed, state, opts.maxBookAgeMs))) {
    return { skipped: true, reason: 'book_stale', event: event.slug };
  }

  const eventStart = event.eventStart instanceof Date ? event.eventStart : new Date(startMs);
  const eventEnd = event.eventEnd instanceof Date ? event.eventEnd : new Date(endMs);
  state.priceToBeat = await fetchPriceToBeat(eventStart, eventEnd);
  if (state.priceToBeat == null) {
    console.log('⚠ PTB unavailable — retrying during loop');
  } else {
    console.log(`priceToBeat=${state.priceToBeat}`);
  }

  const st = createState({
    maxOrderValue: opts.budget,
  });
  const decisionLatency = [];
  const deadline = Date.now() + Math.min(opts.timeoutSec, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let loops = 0;
  let staleBlocks = 0;
  let lastStaleRefresh = 0;
  let lastPtbRetry = 0;
  let pendingIntent = null;
  let pendingAt = 0;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s fill=${opts.fill} budget=$${opts.budget}` +
      ` pollMs=${opts.pollMs} window=${CHAMPION.entryWindowEnd}–${CHAMPION.entryWindowStart}s`,
  );

  while (Date.now() < deadline) {
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
      pushSample(ring, now, state.binance);
    }

    if (state.priceToBeat == null && now - lastPtbRetry > 2000) {
      lastPtbRetry = now;
      const ptb = await fetchPriceToBeat(eventStart, eventEnd);
      if (ptb != null) {
        state.priceToBeat = ptb;
        console.log(`[ptb] ${ptb}`);
      }
    }

    const upAsk = state.up.bestAsk;
    const dnAsk = state.down.bestAsk;
    loops += 1;

    if (now - lastHb >= 5_000) {
      lastHb = now;
      const sum = summarize(st);
      const spotAge =
        state.binanceReceivedAt != null ? Math.round(now - state.binanceReceivedAt) : null;
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} bn=${state.binance} cl=${state.btc}` +
          ` ptb=${state.priceToBeat} mode=${sum.mode}` +
          ` bookLag=${Number.isFinite(lag) ? Math.round(lag) : null}` +
          ` spotAge=${spotAge} fresh=${bookFresh} loops=${loops} samples=${ring.pts.length}` +
          ` skip=${sum.lastNoEntryReason || '-'}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(opts.pollMs);
      continue;
    }

    if (pendingIntent && now - pendingAt >= opts.cruelLatencyMs) {
      const res = applyDryFill(st, pendingIntent, opts.fill);
      console.log(
        `ENTER fill ${pendingIntent.side} @${res.px?.toFixed?.(3) ?? res.px}` +
          ` sh=${res.sh?.toFixed?.(2)} netEdge=${pendingIntent.netEdge.toFixed(3)}` +
          ` pJump=${pendingIntent.pJump.toFixed(3)} τ=${pendingIntent.tau}`,
      );
      pendingIntent = null;
    }

    if (st.mode === 'idle' && !pendingIntent) {
      const t0 = performance.now();
      const spotAgeMs =
        state.binanceReceivedAt != null ? now - state.binanceReceivedAt : null;
      const intent = tryEntry(st, {
        spot: state.binance,
        ptb: state.priceToBeat,
        tau,
        book: { UP: state.up, DOWN: state.down },
        spotAgeMs,
        ring,
        nowMs: now,
      });
      decisionLatency.push(Math.round(performance.now() - t0));
      if (intent?.action === 'enter') {
        console.log(
          `ENTER intent ${intent.side} ask=${intent.ask} netEdge=${intent.netEdge.toFixed(3)}` +
            ` pJump=${intent.pJump.toFixed(3)} σ=${intent.sigma.toFixed(2)}` +
            ` dist=${intent.dist.toFixed(1)} τ=${intent.tau} liq=${intent.liq.toFixed(2)}`,
        );
        if (opts.fill === 'cruel' && opts.cruelLatencyMs > 0) {
          pendingIntent = intent;
          pendingAt = now;
        } else {
          const res = applyDryFill(st, intent, opts.fill);
          console.log(
            `ENTER fill ${intent.side} @${res.px?.toFixed?.(3)} sh=${res.sh?.toFixed?.(2)}`,
          );
        }
      }
    }

    await sleep(opts.pollMs);
  }

  // Resolução oficial Poly = Chainlink BTC/USD vs PTB (≥ → UP). NÃO usar Binance no settle.
  const binanceWinner =
    state.binance != null && state.priceToBeat != null
      ? state.binance >= state.priceToBeat
        ? 'UP'
        : 'DOWN'
      : null;
  const bookWinner =
    state.up.bestAsk != null && state.down.bestAsk != null
      ? state.up.bestAsk >= state.down.bestAsk
        ? 'UP'
        : 'DOWN'
      : null;

  let winner = null;
  let settleSource = null;
  let settleSpot = null;
  if (state.btc != null && state.priceToBeat != null) {
    winner = state.btc >= state.priceToBeat ? 'UP' : 'DOWN';
    settleSource = 'chainlink_rtds';
    settleSpot = state.btc;
  } else if (bookWinner != null) {
    winner = bookWinner;
    settleSource = 'book_proxy';
  }
  if (st.mode === 'entered') settle(st, winner);

  if (binanceWinner != null && winner != null && binanceWinner !== winner) {
    console.log(
      `⚠ settle divergence binance=${binanceWinner} chainlink/book=${winner}` +
        ` bn=${state.binance} cl=${state.btc} ptb=${state.priceToBeat} source=${settleSource}`,
    );
  }
  console.log(
    `settle source=${settleSource} winner=${winner} cl=${state.btc} bn=${state.binance}` +
      ` ptb=${state.priceToBeat} bookWinner=${bookWinner} binanceWinner=${binanceWinner}`,
  );

  const latSorted = [...decisionLatency].sort((a, b) => a - b);
  const p95 =
    latSorted.length > 0
      ? latSorted[Math.min(latSorted.length - 1, Math.floor(latSorted.length * 0.95))]
      : null;

  return {
    skipped: false,
    generatedAt: nowIso(),
    dry: true,
    strategy: 'hyperion-v1',
    variant: 'btc-hyperion-terminal-v4',
    spotSource: 'binance',
    settleSource,
    settleSpot,
    binanceWinner,
    bookWinner,
    fillMode: opts.fill,
    event: {
      slug: event.slug,
      title: event.title,
      upTokenId: event.upTokenId,
      downTokenId: event.downTokenId,
      priceToBeat: state.priceToBeat,
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
    blocks: st.blocks.slice(-30),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Hyperion V4 Terminal dry (Binance entry · Chainlink settle · zero ordens) ===');
  console.log(
    `maxEvents=${opts.maxEvents} fill=${opts.fill} budget=$${opts.budget}` +
      ` pollMs=${opts.pollMs} minTauStart=${opts.minTauStart} warmSec=${opts.warmSec}`,
  );
  console.log(
    `envelope τ=${CHAMPION.entryWindowEnd}–${CHAMPION.entryWindowStart}s` +
      ` ask∈[${CHAMPION.minAsk},${CHAMPION.maxAsk}] edge≥${CHAMPION.minEdge}` +
      ` spread≤${CHAMPION.maxSpread} liq≥${CHAMPION.minLiquidityRatio}`,
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
  // Chainlink via RTDS — só para settle (fonte oficial Polymarket BTC 5m).
  const stopRtds = startRtdsFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(
        `⚠ rtds force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`,
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
  const ring = createSampleRing(120);

  console.log(`warming Binance samples for vol (~${opts.warmSec}s)…`);
  const warmDeadline = Date.now() + opts.warmSec * 1000;
  while (Date.now() < warmDeadline) {
    if (state.binance != null) pushSample(ring, Date.now(), state.binance);
    if (ring.pts.length >= 2) {
      const span = (ring.pts.at(-1).ts - ring.pts[0].ts) / 1000;
      if (span >= Math.max(30, opts.warmSec - 5)) break;
    }
    await sleep(200);
  }
  console.log(
    `warm samples=${ring.pts.length} span≈${
      ring.pts.length ? ((ring.pts.at(-1).ts - ring.pts[0].ts) / 1000).toFixed(0) : 0
    }s bn=${state.binance} ws=${state.wsBinanceConnected}`,
  );
  if (state.binance == null) {
    throw new Error('Binance spot feed não entregou ticks no warm-up');
  }

  const outDir = path.resolve('runs/hyperion-dry');
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
        ring,
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
        `result mode=${r.mode} side=${r.side} ask=${r.ask} fill=${r.fillPx}` +
          ` netEdge=${r.netEdge} pnl≈${r.pnl} winner=${r.winner} blocks=${JSON.stringify(r.blockCounts)}`,
      );
      console.log(
        `decisionLatency p50=${rep.decisionLatencyMs.p50}ms p95=${rep.decisionLatencyMs.p95}ms`,
      );
      const fname = `hy_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
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
    try {
      stopRtds?.();
    } catch {
      /* ignore */
    }
  }

  const traded = reports.filter((r) => !r.skipped && r.result?.mode === 'settled');
  const entered = reports.filter((r) => !r.skipped && r.result?.side);
  const pnls = traded.map((r) => r.result.pnl).filter((x) => x != null);
  const wins = pnls.filter((x) => x > 0).length;
  const sumPnl = pnls.reduce((a, b) => a + b, 0);
  const p95s = reports
    .filter((r) => !r.skipped && r.decisionLatencyMs?.p95 != null)
    .map((r) => r.decisionLatencyMs.p95);
  const maxP95 = p95s.length ? Math.max(...p95s) : null;
  const summary = {
    generatedAt: nowIso(),
    dry: true,
    strategy: 'hyperion-v1',
    variant: 'btc-hyperion-terminal-v4',
    spotSource: 'binance',
    fillMode: opts.fill,
    staleReconnects,
    eventsSeen: reports.length,
    entries: entered.length,
    settled: traded.length,
    wins,
    losses: pnls.length - wins,
    winRate: pnls.length ? Math.round((wins / pnls.length) * 1000) / 10 : null,
    totalPnl: Math.round(sumPnl * 100) / 100,
    decisionLatencyP95MaxMs: maxP95,
    okPlumbing: maxP95 != null && maxP95 < 300,
    reports: reports.map((r) =>
      r.skipped
        ? r
        : {
            slug: r.event?.slug,
            mode: r.result?.mode,
            side: r.result?.side,
            ask: r.result?.ask,
            netEdge: r.result?.netEdge,
            pnl: r.result?.pnl,
            winner: r.result?.winner,
            p95Ms: r.decisionLatencyMs?.p95,
            blockCounts: r.result?.blockCounts,
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
