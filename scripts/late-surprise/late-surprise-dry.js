#!/usr/bin/env node
/**
 * Late Surprise (m3-ask35) — dry/shadow WS na Giovanna.
 *
 * Default: DRY (WS book + RTDS spot + fill simulado, ZERO ordens CLOB).
 * Recusa --live. Para micro real, script separado futuro.
 *
 *   node scripts/late-surprise/late-surprise-dry.js
 *   node scripts/late-surprise/late-surprise-dry.js --max-events=20 --fill=cruel --anti-flip
 *
 * Docker (Giovanna):
 *   docker exec pair-path-micro node scripts/late-surprise/late-surprise-dry.js --max-events=20 --poll-ms=50
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import {
  CHAMPION,
  createState,
  createSampleRing,
  createMidRing,
  pushSample,
  pushMid,
  tryEntry,
  applyDryFill,
  settle,
  summarize,
} from './late-surprise-engine.js';

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
    throw new Error('late-surprise-dry recusa --live (só dry/shadow WS).');
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
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '20', 10) || 0),
    waitTimeoutSec: Math.max(
      30,
      parseInt(valueOf('--wait-timeout') ?? String(Math.max(600, 20 * 400)), 10) || 600,
    ),
    entryBudget: Math.max(1, parseFloat(valueOf('--budget') ?? String(CHAMPION.entryBudget)) || 10),
    fill,
    antiFlip: args.includes('--anti-flip') || args.includes('--anti-flip=1'),
    cruelLatencyMs: Math.max(0, parseInt(valueOf('--cruel-latency-ms') ?? '80', 10) || 0),
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

async function runOneEvent({ opts, feedCtx, ring, midRing }) {
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
  // Precisa de margem para entrar em τ≤15 — se já passou, pula.
  if (tau0 < CHAMPION.minSecondsLeft) {
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
    entryBudget: opts.entryBudget,
    antiFlipEnabled: opts.antiFlip,
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
    `event=${event.slug || event.title} tau≈${tau0}s fill=${opts.fill} budget=$${opts.entryBudget}` +
      ` antiFlip=${opts.antiFlip} pollMs=${opts.pollMs}`,
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

    if (state.btc != null) {
      pushSample(ring, now, state.btc);
    }

    if (
      state.priceToBeat == null &&
      now - lastPtbRetry > 2000
    ) {
      lastPtbRetry = now;
      const ptb = await fetchPriceToBeat(eventStart, eventEnd);
      if (ptb != null) {
        state.priceToBeat = ptb;
        console.log(`[ptb] ${ptb}`);
      }
    }

    const upAsk = state.up.bestAsk;
    const dnAsk = state.down.bestAsk;
    const upBid = state.up.bestBid;
    const dnBid = state.down.bestBid;
    loops += 1;

    // Mid do favorito físico (para anti-flip).
    if (state.btc != null && state.priceToBeat != null && upAsk != null && dnAsk != null) {
      const fav = state.btc > state.priceToBeat ? 'UP' : 'DOWN';
      const ask = fav === 'UP' ? upAsk : dnAsk;
      const bid = fav === 'UP' ? upBid : dnBid;
      if (ask != null && bid != null) pushMid(midRing, now, (ask + bid) / 2);
    }

    if (now - lastHb >= 5_000) {
      lastHb = now;
      const sum = summarize(st);
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} btc=${state.btc} ptb=${state.priceToBeat}` +
          ` mode=${sum.mode} ageMs=${Number.isFinite(lag) ? Math.round(lag) : null}` +
          ` fresh=${bookFresh} loops=${loops} samples=${ring.pts.length}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(opts.pollMs);
      continue;
    }

    // Cruel: aplica fill após latência artificial.
    if (pendingIntent && now - pendingAt >= opts.cruelLatencyMs) {
      const res = applyDryFill(st, pendingIntent, opts.fill);
      console.log(
        `ENTER fill ${pendingIntent.side} @${res.px?.toFixed?.(3) ?? res.px}` +
          ` sh=${res.sh?.toFixed?.(2)} edge=${pendingIntent.edge.toFixed(3)}` +
          ` z=${pendingIntent.z.toFixed(2)} τ=${pendingIntent.tau}`,
      );
      pendingIntent = null;
    }

    if (st.mode === 'idle' && !pendingIntent) {
      const t0 = performance.now();
      const spotAgeMs =
        state.rtdsReceivedAt != null ? now - state.rtdsReceivedAt : null;
      const intent = tryEntry(st, {
        btc: state.btc,
        ptb: state.priceToBeat,
        tau,
        book: { UP: state.up, DOWN: state.down },
        spotAgeMs,
        ring,
        midRing,
        nowMs: now,
      });
      decisionLatency.push(Math.round(performance.now() - t0));
      if (intent?.action === 'enter') {
        console.log(
          `ENTER intent ${intent.side} ask=${intent.ask} edge=${intent.edge.toFixed(3)}` +
            ` z=${intent.z.toFixed(2)} pPhys=${intent.pPhys.toFixed(3)} dist=${intent.dist.toFixed(1)} τ=${intent.tau}`,
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

  // Winner proxy: ask alto no fim ≈ favorito do book; preferir spot vs PTB.
  let winner = null;
  if (state.btc != null && state.priceToBeat != null) {
    winner = state.btc > state.priceToBeat ? 'UP' : 'DOWN';
  } else if (state.up.bestAsk != null && state.down.bestAsk != null) {
    winner = state.up.bestAsk >= state.down.bestAsk ? 'UP' : 'DOWN';
  }
  if (st.mode === 'entered') settle(st, winner);

  const latSorted = [...decisionLatency].sort((a, b) => a - b);
  const p95 =
    latSorted.length > 0
      ? latSorted[Math.min(latSorted.length - 1, Math.floor(latSorted.length * 0.95))]
      : null;

  return {
    skipped: false,
    generatedAt: nowIso(),
    dry: true,
    strategy: 'late-surprise',
    variant: 'm3-ask35',
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
    decisionLatencyMs: { n: latSorted.length, p50: latSorted[Math.floor(latSorted.length / 2)] ?? null, p95 },
    result: summarize(st),
    blocks: st.blocks.slice(-30),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Late Surprise dry (m3-ask35 · WS · zero ordens) ===');
  console.log(
    `maxEvents=${opts.maxEvents} fill=${opts.fill} budget=$${opts.entryBudget}` +
      ` antiFlip=${opts.antiFlip} pollMs=${opts.pollMs} minTauStart=${opts.minTauStart}`,
  );
  console.log(
    `envelope τ=${CHAMPION.minSecondsLeft}–${CHAMPION.maxSecondsLeft}s` +
      ` ask≤${CHAMPION.maxAsk} edge≥${CHAMPION.minEdge} dist≥${CHAMPION.minDistAbs}`,
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
  const stopRtds = startRtdsFeed(state);
  let staleReconnects = 0;
  const clobFeed = createClobFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(`⚠ feed force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`);
    },
  });
  const ring = createSampleRing(120);
  const midRing = createMidRing(30);

  // Aquece amostras de vol (~95s) antes da série — necessário para σ.
  console.log('warming RTDS samples for vol (~95s)…');
  const warmDeadline = Date.now() + 110_000;
  while (Date.now() < warmDeadline) {
    if (state.btc != null) pushSample(ring, Date.now(), state.btc);
    if (ring.pts.length >= 2) {
      const span = (ring.pts.at(-1).ts - ring.pts[0].ts) / 1000;
      if (span >= 95) break;
    }
    await sleep(500);
  }
  console.log(`warm samples=${ring.pts.length} span≈${ring.pts.length ? ((ring.pts.at(-1).ts - ring.pts[0].ts) / 1000).toFixed(0) : 0}s btc=${state.btc}`);

  const outDir = path.resolve('runs/late-surprise-dry');
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
        // Esperar janela com τ alto o bastante para aquecer e ainda pegar τ 3–15.
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
        midRing,
      });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip: ${rep.reason} tau=${rep.tau ?? '-'}`);
        await sleep(2000);
        // Não consome slot se pulou por τ baixo no meio do evento.
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
          ` edge=${r.edge} pnl≈${r.pnl} winner=${r.winner} blocks=${JSON.stringify(r.blockCounts)}`,
      );
      console.log(`decisionLatency p50=${rep.decisionLatencyMs.p50}ms p95=${rep.decisionLatencyMs.p95}ms`);
      const fname = `ls_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
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
  const summary = {
    generatedAt: nowIso(),
    dry: true,
    strategy: 'late-surprise',
    variant: 'm3-ask35',
    fillMode: opts.fill,
    staleReconnects,
    eventsSeen: reports.length,
    entries: entered.length,
    settled: traded.length,
    wins,
    losses: pnls.length - wins,
    winRate: pnls.length ? Math.round((wins / pnls.length) * 1000) / 10 : null,
    totalPnl: Math.round(sumPnl * 100) / 100,
    reports: reports.map((r) =>
      r.skipped
        ? r
        : {
            slug: r.event?.slug,
            mode: r.result?.mode,
            side: r.result?.side,
            ask: r.result?.ask,
            edge: r.result?.edge,
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
