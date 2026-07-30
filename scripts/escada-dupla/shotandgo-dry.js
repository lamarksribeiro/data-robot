#!/usr/bin/env node
/**
 * Shotandgo / Phil — dry harness (WS alta frequência, zero ordens).
 *
 * Mecânica alinhada a Phil_Hopper_Real_1.0.py, afinada por profile:
 *   tuned (default) — grade Phil · MULT=1 · maxVir=3 · EQ gate 0.98
 *   hybrid          — Clip gates (avgSum 0.94, DESC 40/36/32, open-ready, escape τ20)
 *   phil            — MULT/contagio/maxVir como no Python
 *   clip            — grade curta 3+3
 *
 * Roda optimistic + honest em paralelo no mesmo book.
 * NÃO altera Pair-Path / Clip-Path.
 *
 *   node scripts/escada-dupla/shotandgo-dry.js
 *   node scripts/escada-dupla/shotandgo-dry.js --profile=hybrid --cruel --max-events=3
 *   node scripts/escada-dupla/shotandgo-dry.js --modes=cruel --profile=hybrid
 *
 * Docker:
 *   docker exec pair-path-micro node scripts/escada-dupla/shotandgo-dry.js --profile=hybrid --cruel --max-events=3 --min-tau-start=180
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  createShotandgoState,
  onTick,
  summarize,
  profileParams,
} from './shotandgo-engine.js';

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
    throw new Error('shotandgo-dry recusa --live (só dry/shadow WS).');
  }
  const profile = String(valueOf('--profile') ?? 'hybrid').toLowerCase();
  if (!['tuned', 'phil', 'clip', 'hybrid'].includes(profile)) {
    throw new Error(`--profile inválido (${profile}); use tuned|phil|clip|hybrid`);
  }
  const X = Math.max(1, parseFloat(valueOf('--X') ?? valueOf('--shares') ?? '5') || 5);
  const maxEvents = Math.max(1, parseInt(valueOf('--max-events') ?? '1', 10) || 1);
  const cruel = args.includes('--cruel') || args.includes('--cruel=1');
  return {
    profile,
    X,
    maxEvents,
    cruel,
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '0', 10) || 0),
    waitTimeoutSec: Math.max(
      30,
      parseInt(valueOf('--wait-timeout') ?? String(Math.max(360, maxEvents * 400)), 10) || 360,
    ),
    subCapCents: Math.max(0, parseInt(valueOf('--sub-cap-cents') ?? (profile === 'hybrid' ? '2' : '1'), 10) || 0),
    maxViradas: valueOf('--max-viradas') != null ? parseInt(valueOf('--max-viradas'), 10) : null,
    maxNotional: valueOf('--max-notional') != null ? parseFloat(valueOf('--max-notional')) : null,
    modes: String(valueOf('--modes') ?? (cruel ? 'cruel' : 'both')),
    json: args.includes('--json'),
  };
}

function pickModes(modesArg, cruel) {
  if (modesArg === 'honest') return ['honest'];
  if (modesArg === 'optimistic') return ['optimistic'];
  if (modesArg === 'cruel') return ['cruel'];
  if (modesArg === 'compare' || modesArg === 'honest,cruel') return ['honest', 'cruel'];
  if (modesArg === 'all') return ['optimistic', 'honest', 'cruel'];
  if (cruel) return ['cruel'];
  return ['optimistic', 'honest'];
}

function bestAskSize(bookSide) {
  const lvl = bookSide?.asks?.[0];
  if (!lvl) return null;
  const s = Number(lvl.size);
  return Number.isFinite(s) && s > 0 ? s : null;
}

function buildParams(opts, fillMode) {
  const o = {
    profile: opts.profile,
    X: opts.X,
    fillMode,
    subCapCents: opts.subCapCents,
  };
  if (opts.maxViradas != null) o.maxViradas = opts.maxViradas;
  if (opts.maxNotional != null) o.maxEventNotional = opts.maxNotional;
  return profileParams(opts.profile, o);
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

async function runOneEvent({ opts, feedCtx, modeList }) {
  const event = await findActiveBtc5mEvent();
  if (!event?.upTokenId || !event?.downTokenId) throw new Error('no active BTC 5m event');

  const endMs =
    event.eventEnd instanceof Date
      ? event.eventEnd.getTime()
      : Number(event.eventEndMs ?? Date.now() + 300_000);
  const tau0 = Math.floor((endMs - Date.now()) / 1000);
  if (tau0 < 40) {
    return { skipped: true, reason: 'tau_low', tau: tau0, event: event.slug };
  }

  const { state, clobFeed } = feedCtx;
  clobFeed.subscribe(event.upTokenId, event.downTokenId);
  await clobFeed.refreshBooks();
  if (!(await waitFreshBook(clobFeed, state, opts.maxBookAgeMs))) {
    return { skipped: true, reason: 'book_stale', event: event.slug };
  }

  const engines = {};
  for (const mode of modeList) {
    engines[mode] = createShotandgoState(buildParams(opts, mode));
  }
  const sample = engines[modeList[0]].params;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s profile=${opts.profile} X=${opts.X} ` +
      `modes=${modeList.join('+')} sub=${sample.subLevels.length} desc=${sample.descLevels.length} ` +
      `mult=${sample.mult[0]}${sample.mult.length > 1 ? '…' : ''} maxVir=${sample.maxViradas} ` +
      `notional≤${sample.maxEventNotional} pollMs=${opts.pollMs}`,
  );

  const deadline = Date.now() + Math.min(opts.timeoutSec, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let loops = 0;
  let staleBlocks = 0;
  let lastStaleRefresh = 0;

  while (Date.now() < deadline) {
    const tau = Math.floor((endMs - Date.now()) / 1000);
    if (tau <= 0) break;
    const now = Date.now();
    const lag = clobFeed.lagMs();
    const bookFresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;

    if (!bookFresh && now - lastStaleRefresh >= 1000) {
      lastStaleRefresh = now;
      await clobFeed.refreshBooks();
    }

    const upAsk = state.up.bestAsk;
    const dnAsk = state.down.bestAsk;
    loops += 1;

    if (now - lastHb >= 5_000) {
      lastHb = now;
      const bits = modeList.map((m) => {
        const s = summarize(engines[m]);
        return `${m}:v${s.viradas} g${s.geracao} f${s.counts.subFills}/${s.counts.descFills} miss${s.counts.subMisses} avg=${s.avgSum ?? '-'}`;
      });
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} ageMs=${Number.isFinite(lag) ? Math.round(lag) : null} ` +
          `fresh=${bookFresh} loops=${loops} | ${bits.join(' | ')}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(opts.pollMs);
      continue;
    }

    const asks = { UP: upAsk, DOWN: dnAsk };
    const depths = {
      UP: bestAskSize(state.up),
      DOWN: bestAskSize(state.down),
    };
    for (const mode of modeList) onTick(engines[mode], asks, tau, now, depths);
    if (modeList.every((m) => engines[m].mode === 'done')) break;
    await sleep(opts.pollMs);
  }

  const upAsk = state.up.bestAsk;
  const dnAsk = state.down.bestAsk;
  const winner = upAsk != null && dnAsk != null ? (upAsk >= dnAsk ? 'UP' : 'DOWN') : null;

  const byMode = {};
  for (const mode of modeList) {
    const st = engines[mode];
    const sum = summarize(st);
    const cost = sum.invested;
    const fees = sum.fees;
    const pnl =
      winner != null ? Math.round((st.inv[winner].shares - cost - fees) * 100) / 100 : null;
    byMode[mode] = {
      ...sum,
      winner,
      pnl,
      fills: st.fills,
      misses: st.misses.slice(0, 50),
      eventsTail: st.events.slice(-40),
    };
  }

  let comparison = null;
  if (byMode.optimistic && byMode.honest) {
    comparison = {
      optimisticPnl: byMode.optimistic.pnl,
      honestPnl: byMode.honest.pnl,
      optimisticAvgSum: byMode.optimistic.avgSum,
      honestAvgSum: byMode.honest.avgSum,
      optimisticViradas: byMode.optimistic.viradas,
      honestViradas: byMode.honest.viradas,
      subMissesHonest: byMode.honest.counts.subMisses,
      avgGapHonest: byMode.honest.avgGapCents,
      hint:
        byMode.optimistic.pnl != null &&
        byMode.honest.pnl != null &&
        byMode.optimistic.pnl > 0 &&
        byMode.honest.pnl <= 0
          ? 'OPTIMISTIC_EDGE_DIES_IN_HONEST'
          : byMode.honest.verdictHint,
    };
  }

  return {
    skipped: false,
    generatedAt: nowIso(),
    dry: true,
    strategy: 'shotandgo',
    event: {
      slug: event.slug,
      title: event.title,
      upTokenId: event.upTokenId,
      downTokenId: event.downTokenId,
    },
    params: buildParams(opts, 'honest'),
    loops,
    staleBlocks,
    byMode,
    comparison,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const modeList = pickModes(opts.modes, opts.cruel);
  const preview = buildParams(opts, 'honest');

  console.log('=== Shotandgo dry (Phil mechanics · WS · zero ordens) ===');
  console.log(
    `profile=${opts.profile} X=${opts.X} modes=${modeList.join('+')} cruel=${opts.cruel} maxEvents=${opts.maxEvents}`,
  );
  console.log(
    `grade SUB[${preview.subLevels.join(',')}] DESC[${preview.descLevels.join(',')}]`,
  );
  console.log(
    `mult=${JSON.stringify(preview.mult.slice(0, 8))}${preview.mult.length > 8 ? '…' : ''} ` +
      `contagio=${preview.contagio} geracao=${preview.geracaoAtiva} maxVir=${preview.maxViradas} ` +
      `notional≤${preview.maxEventNotional} eqAsk≤${preview.eqAskMax} eqAvgMax=${preview.eqAvgSumMax} ` +
      `eqRefuse=${preview.eqRefuseIfAvgSumAbove}`,
  );
  console.log(`feed pollMs=${opts.pollMs} maxBookAgeMs=${opts.maxBookAgeMs}`);

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
  const clobFeed = createClobFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(`⚠ feed force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`);
    },
  });

  const outDir = path.resolve('runs/shotandgo-dry');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  let lastSlug = null;

  async function waitNextWindow(afterSlug) {
    if (opts.minTauStart <= 0) return;
    const waitDeadline = Date.now() + opts.waitTimeoutSec * 1000;
    while (Date.now() < waitDeadline) {
      const ev = await findActiveBtc5mEvent();
      if (ev?.eventEnd) {
        const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
        const tau = Math.floor((endMs - Date.now()) / 1000);
        const slug = ev.slug || null;
        if (slug && slug !== afterSlug && tau >= opts.minTauStart) {
          console.log(`next window ok slug=${slug} tau=${tau}`);
          return;
        }
        console.log(
          `waiting next… slug=${slug || '?'} tau=${tau} after=${afterSlug || '-'} need>=${opts.minTauStart}`,
        );
      } else console.log('waiting next… no active event');
      await sleep(2000);
    }
  }

  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      if (i > 0) await waitNextWindow(lastSlug);
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runOneEvent({ opts, feedCtx: { state, clobFeed }, modeList });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip: ${rep.reason}`);
        await sleep(2000);
        continue;
      }
      lastSlug = rep.event?.slug || lastSlug;
      for (const mode of modeList) {
        const m = rep.byMode[mode];
        console.log(
          `[${mode}] eq=${m.equalizou} avgSum=${m.avgSum} vir=${m.viradas} g=${m.geracao} ` +
            `inv=$${m.invested} sub=${m.counts.subFills} desc=${m.counts.descFills} ` +
            `miss=${m.counts.subMisses} pnl≈${m.pnl} hint=${m.verdictHint}`,
        );
      }
      if (rep.comparison) {
        console.log(
          `COMPARE optPnL=${rep.comparison.optimisticPnl} vs honPnL=${rep.comparison.honestPnl} → ${rep.comparison.hint}`,
        );
      }
      const fname = `sg_${opts.profile}_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);
    }
  } finally {
    clobFeed.stop?.();
  }

  const summary = {
    generatedAt: nowIso(),
    dry: true,
    strategy: 'shotandgo',
    profile: opts.profile,
    staleReconnects,
    events: reports.length,
    traded: reports.filter((r) => !r.skipped).length,
    comparisons: reports.filter((r) => r.comparison).map((r) => ({
      slug: r.event?.slug,
      ...r.comparison,
    })),
  };
  const sumPath = path.join(outDir, `summary_${opts.profile}_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`summary → ${sumPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
