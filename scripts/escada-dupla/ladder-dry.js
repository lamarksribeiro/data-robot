#!/usr/bin/env node
/**
 * Escada Dupla — dry harness (WS alta frequência, SEM ordens CLOB).
 *
 * Roda optimistic + honest em paralelo no mesmo book ao vivo, para ver se
 * o edge da escada sobrevive ao fill realista (tese da invalidação no lab).
 *
 * NÃO altera Pair-Path / Clip-Path (micro-live.js intacto).
 *
 *   node scripts/escada-dupla/ladder-dry.js
 *   node scripts/escada-dupla/ladder-dry.js --max-events=3 --poll-ms=50
 *   node scripts/escada-dupla/ladder-dry.js --shares=5 --max-viradas=2 --sub-cap-cents=1
 *
 * Docker (Giovanna, container pair-path-micro ou data-robot):
 *   docker exec pair-path-micro node scripts/escada-dupla/ladder-dry.js --max-events=3
 *
 * Live (--live) é RECUSADO neste script — só dry.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  createLadderState,
  onTick,
  summarize,
  DEFAULT_LADDER,
} from './ladder-engine.js';

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
    throw new Error(
      'ladder-dry NÃO aceita --live. Este harness é só shadow/dry. ' +
        'Para live futuro, outro script (ainda não criado).',
    );
  }
  const shares = Math.max(5, parseInt(valueOf('--shares') ?? '5', 10) || 5);
  const subRaw = valueOf('--sub');
  const descRaw = valueOf('--desc');
  const subLevels = subRaw
    ? subRaw.split(',').map((x) => parseInt(x.trim(), 10))
    : [...DEFAULT_LADDER.subLevels];
  const descLevels = descRaw
    ? descRaw.split(',').map((x) => parseInt(x.trim(), 10))
    : [...DEFAULT_LADDER.descLevels];
  return {
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '1', 10) || 1),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '0', 10) || 0),
    waitTimeoutSec: Math.max(30, parseInt(valueOf('--wait-timeout') ?? '360', 10) || 360),
    shares,
    subLevels,
    descLevels,
    subCapCents: Math.max(0, parseInt(valueOf('--sub-cap-cents') ?? '1', 10) || 0),
    maxViradas: Math.max(1, parseInt(valueOf('--max-viradas') ?? '2', 10) || 2),
    maxNotional: parseFloat(valueOf('--max-notional') ?? '12'),
    eqAskMax: parseFloat(valueOf('--eq-ask-max') ?? '0.05'),
    eqAvgSumMax: parseFloat(valueOf('--eq-avg-sum-max') ?? '0.98'),
    /** only | both — default both (A/B optimistic vs honest) */
    modes: String(valueOf('--modes') ?? 'both'),
    json: args.includes('--json'),
  };
}

function baseParams(opts) {
  return {
    subLevels: opts.subLevels,
    descLevels: opts.descLevels,
    sharesSub: opts.subLevels.map(() => opts.shares),
    sharesDesc: opts.descLevels.map(() => opts.shares),
    subCapCents: opts.subCapCents,
    maxViradas: opts.maxViradas,
    maxEventNotional: opts.maxNotional,
    eqAskMax: opts.eqAskMax,
    eqAvgSumMax: opts.eqAvgSumMax,
    eqEnabled: true,
    feeRate: 0.07,
  };
}

function pickModes(modesArg) {
  if (modesArg === 'honest') return ['honest'];
  if (modesArg === 'optimistic') return ['optimistic'];
  return ['optimistic', 'honest'];
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
  const fresh = await waitFreshBook(clobFeed, state, opts.maxBookAgeMs);
  if (!fresh) {
    return { skipped: true, reason: 'book_stale', event: event.slug };
  }

  const engines = {};
  for (const mode of modeList) {
    engines[mode] = createLadderState({ ...baseParams(opts), fillMode: mode });
  }

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s modes=${modeList.join('+')} ` +
      `shares=${opts.shares} sub=[${opts.subLevels}] desc=[${opts.descLevels}] ` +
      `cap=+${opts.subCapCents}¢ maxVir=${opts.maxViradas} pollMs=${opts.pollMs}`,
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
        return `${m}:f${s.counts.subFills}/${s.counts.descFills} miss${s.counts.subMisses} avg=${s.avgSum ?? '-'}`;
      });
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} ws=${state.wsClobConnected} ` +
          `ageMs=${Number.isFinite(lag) ? Math.round(lag) : null} fresh=${bookFresh} loops=${loops} | ${bits.join(' | ')}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(opts.pollMs);
      continue;
    }

    const asks = { UP: upAsk, DOWN: dnAsk };
    for (const mode of modeList) {
      onTick(engines[mode], asks, tau, now);
    }

    const allDone = modeList.every((m) => engines[m].mode === 'done');
    if (allDone) break;

    await sleep(opts.pollMs);
  }

  // winner proxy
  const upAsk = state.up.bestAsk;
  const dnAsk = state.down.bestAsk;
  let winner = null;
  if (upAsk != null && dnAsk != null) winner = upAsk >= dnAsk ? 'UP' : 'DOWN';

  const byMode = {};
  for (const mode of modeList) {
    const st = engines[mode];
    const sum = summarize(st);
    const cost = sum.invested;
    const fees = sum.fees;
    const pnl =
      winner != null && st.inv[winner]
        ? Math.round((st.inv[winner].shares - cost - fees) * 100) / 100
        : null;
    byMode[mode] = {
      ...sum,
      winner,
      pnl,
      fills: st.fills,
      misses: st.misses.slice(0, 40),
      eventsTail: st.events.slice(-30),
    };
  }

  // Comparação central: optimistic vs honest
  let comparison = null;
  if (byMode.optimistic && byMode.honest) {
    comparison = {
      optimisticPnl: byMode.optimistic.pnl,
      honestPnl: byMode.honest.pnl,
      optimisticAvgSum: byMode.optimistic.avgSum,
      honestAvgSum: byMode.honest.avgSum,
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
    event: {
      slug: event.slug,
      title: event.title,
      upTokenId: event.upTokenId,
      downTokenId: event.downTokenId,
    },
    params: baseParams(opts),
    loops,
    staleBlocks,
    byMode,
    comparison,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const modeList = pickModes(opts.modes);

  console.log('=== Escada Dupla ladder-dry (shadow WS, zero ordens) ===');
  console.log(
    `modes=${modeList.join('+')} maxEvents=${opts.maxEvents} shares=${opts.shares} ` +
      `sub=[${opts.subLevels}] desc=[${opts.descLevels}] cap=+${opts.subCapCents}¢ ` +
      `maxVir=${opts.maxViradas} notional≤${opts.maxNotional}`,
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
      } else {
        console.log('waiting… no active event');
      }
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

  const outDir = path.resolve('runs/escada-dupla-dry');
  fs.mkdirSync(outDir, { recursive: true });

  const reports = [];
  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runOneEvent({
        opts,
        feedCtx: { state, clobFeed },
        modeList,
      });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip: ${rep.reason} tau=${rep.tau ?? '?'}`);
        await sleep(2000);
        continue;
      }
      for (const mode of modeList) {
        const m = rep.byMode[mode];
        console.log(
          `[${mode}] eq=${m.equalizou} avgSum=${m.avgSum} inv=$${m.invested} ` +
            `sub=${m.counts.subFills} desc=${m.counts.descFills} miss=${m.counts.subMisses} ` +
            `gap≈${m.avgGapCents ?? '-'}¢ pnl≈${m.pnl} hint=${m.verdictHint}`,
        );
      }
      if (rep.comparison) {
        console.log(
          `COMPARE optimisticPnL=${rep.comparison.optimisticPnl} vs honestPnL=${rep.comparison.honestPnl} ` +
            `→ ${rep.comparison.hint}`,
        );
      }
      const fname = `${(rep.event.slug || 'event').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);
    }
  } finally {
    clobFeed.stop?.();
  }

  const summary = {
    generatedAt: nowIso(),
    dry: true,
    staleReconnects,
    events: reports.length,
    traded: reports.filter((r) => !r.skipped).length,
    comparisons: reports.filter((r) => r.comparison).map((r) => ({
      slug: r.event?.slug,
      ...r.comparison,
    })),
  };
  const sumPath = path.join(outDir, `summary_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`summary → ${sumPath}`);
  if (opts.json) process.stdout.write(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
