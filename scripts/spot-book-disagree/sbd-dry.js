#!/usr/bin/env node
/**
 * Spot×book disagreement — dry/shadow WS.
 *
 * Default: DRY (WS book + RTDS spot + fill simulado, ZERO ordens CLOB).
 * Recusa --live.
 *
 * Campeã: follow-spot-cheap (entryMode=3). Holdout GLS 7d negativo → só observação.
 *
 *   node scripts/spot-book-disagree/sbd-dry.js
 *   node scripts/spot-book-disagree/sbd-dry.js --max-events=10 --mode=3 --fill=cruel
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
  tryEntry,
  applyDryFill,
  settle,
  summarize,
} from './sbd-engine.js';

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
    throw new Error('sbd-dry recusa --live (só dry/shadow WS).');
  }
  const fill = String(valueOf('--fill') ?? 'honest').toLowerCase();
  if (!['honest', 'cruel'].includes(fill)) throw new Error('--fill deve ser honest|cruel');
  const mode = Math.max(1, Math.min(3, parseInt(valueOf('--mode') ?? '3', 10) || 3));
  return {
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '20', 10) || 20),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '45', 10) || 0),
    waitTimeoutSec: Math.max(30, parseInt(valueOf('--wait-timeout') ?? '600', 10) || 600),
    entryBudget: Math.max(1, parseFloat(valueOf('--budget') ?? String(CHAMPION.entryBudget)) || 10),
    entryMode: mode,
    fill,
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

async function runOneEvent({ opts, feedCtx }) {
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
    entryMode: opts.entryMode,
  });
  const decisionLatency = [];
  const deadline = Date.now() + Math.min(opts.timeoutSec, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let loops = 0;
  let lastStaleRefresh = 0;
  let lastPtbRetry = 0;
  let pendingIntent = null;
  let pendingAt = 0;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s mode=${opts.entryMode} fill=${opts.fill}` +
      ` budget=$${opts.entryBudget} pollMs=${opts.pollMs}`,
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
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} btc=${state.btc} ptb=${state.priceToBeat}` +
          ` mode=${sum.mode} ageMs=${Number.isFinite(lag) ? Math.round(lag) : null}` +
          ` fresh=${bookFresh} loops=${loops}`,
      );
    }

    if (!bookFresh) {
      await sleep(opts.pollMs);
      continue;
    }

    if (pendingIntent && now - pendingAt >= opts.cruelLatencyMs) {
      const res = applyDryFill(st, pendingIntent, opts.fill);
      console.log(
        `ENTER fill ${pendingIntent.side} @${res.px?.toFixed?.(3) ?? res.px}` +
          ` sh=${res.sh?.toFixed?.(2)} edge=${pendingIntent.bookEdge?.toFixed?.(3)}` +
          ` τ=${pendingIntent.tau}`,
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
      });
      decisionLatency.push(Math.round(performance.now() - t0));
      if (intent?.action === 'enter') {
        console.log(
          `ENTER intent ${intent.side} ask=${intent.ask}` +
            ` spot=${intent.spotLeader} bookFav=${intent.bookFavorite}` +
            ` edge=${intent.bookEdge.toFixed(3)} dist=${intent.dist.toFixed(1)} τ=${intent.tau}`,
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

  let winner = null;
  if (state.btc != null && state.priceToBeat != null) {
    winner = state.btc >= state.priceToBeat ? 'UP' : 'DOWN';
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
    event: event.slug,
    winner,
    summary: summarize(st),
    decisionLatencyMs: { n: latSorted.length, p95 },
    priceToBeat: state.priceToBeat,
    btc: state.btc,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== SBD dry (spot×book disagreement) ===');
  console.log(
    `maxEvents=${opts.maxEvents} entryMode=${opts.entryMode} fill=${opts.fill} budget=$${opts.entryBudget}`,
  );
  console.log('⚠ GLS holdout-week negativo — dry = observação/shadow, não GO micro.');

  const state = createMarketState();
  const clobFeed = createClobFeed(state);
  await clobFeed.start();
  const stopRtds = startRtdsFeed(state, { symbol: 'btc/usd' });

  const feedCtx = { state, clobFeed };
  const results = [];
  const outDir = path.join(process.cwd(), 'runs', 'spot-book-disagree-dry');
  fs.mkdirSync(outDir, { recursive: true });

  let seen = 0;
  const overallDeadline = Date.now() + opts.waitTimeoutSec * 1000;

  while (seen < opts.maxEvents && Date.now() < overallDeadline) {
    try {
      const res = await runOneEvent({ opts, feedCtx });
      if (res.skipped) {
        console.log(`skip ${res.reason} tau=${res.tau} event=${res.event}`);
        await sleep(2000);
        continue;
      }
      seen += 1;
      results.push(res);
      const s = res.summary;
      console.log(
        `#${seen} ${res.event} mode=${s.mode} side=${s.side} winner=${res.winner}` +
          ` pnl=${s.pnl} spotL=${s.spotLeader} bookF=${s.bookFavorite}`,
      );
      fs.writeFileSync(
        path.join(outDir, `event-${seen}-${Date.now()}.json`),
        JSON.stringify(res, null, 2),
      );
    } catch (err) {
      console.error('event error:', err?.message || err);
      await sleep(3000);
    }
  }

  const enters = results.filter((r) => r.summary?.mode === 'settled' || r.summary?.mode === 'entered');
  const pnls = enters.map((r) => r.summary?.pnl).filter(Number.isFinite);
  const summary = {
    generatedAt: nowIso(),
    eventsSeen: seen,
    enters: enters.length,
    pnlSum: pnls.reduce((a, b) => a + b, 0),
    results,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(
    `done events=${seen} enters=${enters.length} pnlSum=${summary.pnlSum.toFixed?.(2) ?? summary.pnlSum}`,
  );
  console.log(`reports → ${outDir}`);

  stopRtds?.();
  await clobFeed.stop?.();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
