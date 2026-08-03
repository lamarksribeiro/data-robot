#!/usr/bin/env node
/**
 * Late Surprise SPRINT — validação acelerada na Giovanna.
 *
 * EV estatístico = lab (Fase 0). Aqui: plumbing + latência + N enters rápido.
 *
 * Aceleradores:
 *   - 4 ativos em paralelo na mesma janela de 5m
 *   - sleep até τ≈22
 *   - --target sai cedo
 *   - --probe relaxa envelope (só plumbing)
 *
 *   node scripts/late-surprise/late-surprise-sprint.js --probe --target=15 --timeout=7200
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import {
  findActiveCrypto5mEvent,
  resolveCrypto5mAsset,
} from '../../src/markets/crypto5m.js';
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

const PROBE_RELAX = {
  maxAsk: 0.50,
  minEdge: 0.05,
  minDistAbs: 3,
  maxDistAbs: 120,
  volStepSecs: 15,
  maxSecondsLeft: 20,
  minSecondsLeft: 2,
  maxSpotAgeMs: 4000,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  if (args.includes('--live') || args.includes('--live=1')) {
    throw new Error('late-surprise-sprint recusa --live');
  }
  const assets = String(valueOf('--assets') ?? 'btc,eth,sol,xrp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const a of assets) resolveCrypto5mAsset(a);
  const probe = args.includes('--probe') || args.includes('--probe=1');
  return {
    target: Math.max(1, parseInt(valueOf('--target') ?? '15', 10) || 15),
    /** Sai cedo após N janelas terminais observadas (plumbing), mesmo sem ENTER. */
    targetWindows: Math.max(
      0,
      parseInt(valueOf('--target-windows') ?? (probe ? '24' : '0'), 10) || 0,
    ),
    timeoutSec: Math.max(60, parseInt(valueOf('--timeout') ?? '14400', 10) || 14400),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '3000', 10) || 3000),
    wakeTau: Math.max(18, parseInt(valueOf('--wake-tau') ?? '25', 10) || 25),
    entryBudget: Math.max(1, parseFloat(valueOf('--budget') ?? '10') || 10),
    assets,
    probe,
    fill: String(valueOf('--fill') ?? 'honest').toLowerCase(),
  };
}

function engineParams(opts) {
  const base = { entryBudget: opts.entryBudget, antiFlipEnabled: false };
  return opts.probe ? { ...base, ...PROBE_RELAX } : base;
}

function createAssetCtx(assetKey) {
  const meta = resolveCrypto5mAsset(assetKey);
  const state = createMarketState();
  return {
    assetKey,
    meta,
    state,
    stopRtds: startRtdsFeed(state, { symbol: meta.rtdsSymbol }),
    clobFeed: createClobFeed(state),
    ring: createSampleRing(120),
    midRing: createMidRing(30),
    event: null,
    lastEventFetchMs: 0,
    lastPtbRetryMs: 0,
    enteredSlugs: new Set(),
    st: null,
  };
}

function eventTau(ev) {
  if (!ev?.eventEnd) return null;
  const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
  return Math.floor((endMs - Date.now()) / 1000);
}

async function refreshEvent(ctx) {
  const now = Date.now();
  if (now - ctx.lastEventFetchMs < 1000 && ctx.event) return ctx.event;
  ctx.lastEventFetchMs = now;
  const ev = await findActiveCrypto5mEvent(ctx.assetKey);
  if (!ev?.upTokenId) {
    ctx.event = null;
    ctx.st = null;
    return null;
  }
  if (!ctx.event || ctx.event.slug !== ev.slug) {
    ctx.event = ev;
    ctx.st = null;
    ctx.clobFeed.subscribe(ev.upTokenId, ev.downTokenId);
    await ctx.clobFeed.refreshBooks();
    ctx.state.priceToBeat = await fetchPriceToBeat(ev.eventStart, ev.eventEnd, {
      symbol: ctx.meta.ptbSymbol,
    });
    ctx.lastPtbRetryMs = now;
    console.log(`[${ctx.assetKey}] event=${ev.slug} ptb=${ctx.state.priceToBeat ?? 'pendente'}`);
  }
  return ctx.event;
}

async function main() {
  const opts = parseArgs(process.argv);
  const params = engineParams(opts);
  const maxTauEntry = params.maxSecondsLeft ?? CHAMPION.maxSecondsLeft;

  console.log('=== Late Surprise SPRINT (dry · paralelo · zero ordens) ===');
  console.log(
    `targetEnters=${opts.target} targetWindows=${opts.targetWindows} timeout=${opts.timeoutSec}s` +
      ` assets=${opts.assets.join(',')} probe=${opts.probe} wakeTau=${opts.wakeTau}`,
  );
  if (opts.probe) {
    console.log(
      `⚠ PROBE ask≤${PROBE_RELAX.maxAsk} edge≥${PROBE_RELAX.minEdge} τ≤${PROBE_RELAX.maxSecondsLeft} — só plumbing`,
    );
  }

  const ctxs = opts.assets.map(createAssetCtx);
  const enters = [];
  const windowsSeen = new Set();
  const decisionLatency = [];
  const feedStats = { bookFresh: 0, bookStale: 0, spotOk: 0, spotStale: 0 };
  const outDir = path.resolve(
    opts.probe ? 'runs/late-surprise-sprint-probe' : 'runs/late-surprise-sprint',
  );
  fs.mkdirSync(outDir, { recursive: true });

  console.log('warming feeds ~50s (vol lookback)…');
  const warmUntil = Date.now() + 50_000;
  while (Date.now() < warmUntil) {
    for (const ctx of ctxs) {
      if (ctx.state.btc != null) pushSample(ctx.ring, Date.now(), ctx.state.btc);
      await refreshEvent(ctx);
    }
    await sleep(400);
  }
  console.log('warm:', ctxs.map((c) => `${c.assetKey}:n=${c.ring.pts.length}`).join(' '));

  const deadline = Date.now() + opts.timeoutSec * 1000;
  let lastHb = 0;
  let lastStaleRefresh = {};

  const done = () =>
    enters.length >= opts.target ||
    (opts.targetWindows > 0 && windowsSeen.size >= opts.targetWindows);

  try {
    while (!done() && Date.now() < deadline) {
      // Refresh todos
      await Promise.all(ctxs.map((c) => refreshEvent(c)));

      const live = ctxs
        .map((ctx) => ({ ctx, tau: eventTau(ctx.event) }))
        .filter((x) => x.ctx.event && x.tau != null && x.tau > 0);

      if (!live.length) {
        await sleep(1000);
        continue;
      }

      const minTau = Math.min(...live.map((x) => x.tau));

      // Longe da janela: dormir
      if (minTau > opts.wakeTau) {
        const sleepSec = Math.min(minTau - opts.wakeTau, 10);
        if (Date.now() - lastHb > 10_000) {
          lastHb = Date.now();
        console.log(
          `[hb] enters=${enters.length}/${opts.target} windows=${windowsSeen.size}/${opts.targetWindows || '∞'} minτ=${minTau} sleep ${sleepSec}s`,
        );
        }
        await sleep(sleepSec * 1000);
        continue;
      }

      // Janela terminal: avaliar TODOS os ativos no mesmo tick
      const now = Date.now();
      for (const { ctx, tau } of live) {
        if (done()) break;
        const { state, clobFeed, ring, midRing, event: ev } = ctx;
        if (!ev || ctx.enteredSlugs.has(ev.slug)) continue;
        if (tau > maxTauEntry + 2) continue; // ainda não na janela deste asset

        windowsSeen.add(`${ctx.assetKey}:${ev.slug}`);

        if (state.btc != null) pushSample(ring, now, state.btc);

        if (state.priceToBeat == null && now - ctx.lastPtbRetryMs > 1500) {
          ctx.lastPtbRetryMs = now;
          const ptb = await fetchPriceToBeat(ev.eventStart, ev.eventEnd, {
            symbol: ctx.meta.ptbSymbol,
          });
          if (ptb != null) {
            state.priceToBeat = ptb;
            console.log(`[${ctx.assetKey}] ptb=${ptb}`);
          }
        }

        const lag = clobFeed.lagMs();
        const bookFresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;
        if (!bookFresh) {
          feedStats.bookStale += 1;
          const last = lastStaleRefresh[ctx.assetKey] || 0;
          if (now - last >= 800) {
            lastStaleRefresh[ctx.assetKey] = now;
            await clobFeed.refreshBooks();
          }
          continue;
        }
        feedStats.bookFresh += 1;

        const spotAgeMs =
          state.rtdsReceivedAt != null ? now - state.rtdsReceivedAt : null;
        if (spotAgeMs != null && spotAgeMs <= 4000) feedStats.spotOk += 1;
        else feedStats.spotStale += 1;

        const upAsk = state.up.bestAsk;
        const dnAsk = state.down.bestAsk;
        const upBid = state.up.bestBid;
        const dnBid = state.down.bestBid;
        if (
          state.btc != null &&
          state.priceToBeat != null &&
          upAsk != null &&
          dnAsk != null
        ) {
          const fav = state.btc > state.priceToBeat ? 'UP' : 'DOWN';
          const ask = fav === 'UP' ? upAsk : dnAsk;
          const bid = fav === 'UP' ? upBid : dnBid;
          if (ask != null && bid != null) pushMid(midRing, now, (ask + bid) / 2);
        }

        if (!ctx.st) ctx.st = createState(params);
        if (ctx.st.mode !== 'idle') continue;

        const t0 = performance.now();
        const intent = tryEntry(ctx.st, {
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
          applyDryFill(ctx.st, intent, opts.fill);
          ctx.enteredSlugs.add(ev.slug);
          console.log(
            `[ENTER ${enters.length + 1}/${opts.target}] ${ctx.assetKey} ${intent.side}` +
              ` ask=${intent.ask} edge=${intent.edge.toFixed(3)} z=${intent.z.toFixed(2)}` +
              ` τ=${intent.tau} ageMs=${Math.round(lag)} slug=${ev.slug}`,
          );
          // Settle no fim do evento (curto)
          const waitMs = Math.max(500, tau * 1000 + 800);
          await sleep(waitMs);
          const winner =
            state.btc != null && state.priceToBeat != null
              ? state.btc > state.priceToBeat
                ? 'UP'
                : 'DOWN'
              : null;
          if (winner) settle(ctx.st, winner);
          const rec = {
            n: enters.length + 1,
            asset: ctx.assetKey,
            slug: ev.slug,
            probe: opts.probe,
            at: nowIso(),
            decisionMs: decisionLatency.at(-1),
            bookAgeMs: Math.round(lag),
            result: summarize(ctx.st),
            blockCounts: ctx.st.blockCounts,
          };
          enters.push(rec);
          fs.writeFileSync(
            path.join(outDir, `enter_${rec.n}_${ctx.assetKey}_${Date.now()}.json`),
            JSON.stringify(rec, null, 2),
          );
          ctx.st = null;
        }
      }

      // Fim de slot: marcar slugs sem entry
      for (const { ctx, tau } of live) {
        if (tau <= 1 && ctx.event?.slug) ctx.enteredSlugs.add(ctx.event.slug);
      }

      if (Date.now() - lastHb > 5_000) {
        lastHb = Date.now();
        const bits = live
          .map(({ ctx, tau }) => {
            const up = ctx.state.up.bestAsk;
            const dn = ctx.state.down.bestAsk;
            return `${ctx.assetKey}:τ${tau}/up${up ?? '-'}/dn${dn ?? '-'}`;
          })
          .join(' ');
        console.log(
          `[term] enters=${enters.length}/${opts.target} windows=${windowsSeen.size}/${opts.targetWindows || '∞'} | ${bits}`,
        );
      }

      await sleep(opts.pollMs);
    }
  } finally {
    for (const ctx of ctxs) {
      try {
        ctx.clobFeed.stop?.();
      } catch {
        /* ignore */
      }
      try {
        ctx.stopRtds?.();
      } catch {
        /* ignore */
      }
    }
  }

  const lat = [...decisionLatency].sort((a, b) => a - b);
  const p95 =
    lat.length > 0 ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null;
  const p50 = lat.length > 0 ? lat[Math.floor(lat.length / 2)] : null;
  const plumbingOk =
    opts.targetWindows > 0 &&
    windowsSeen.size >= opts.targetWindows &&
    p95 != null &&
    p95 < 300 &&
    feedStats.bookFresh > feedStats.bookStale;
  const report = {
    generatedAt: nowIso(),
    dry: true,
    mode: opts.probe ? 'sprint-probe' : 'sprint-champion',
    ok: enters.length >= opts.target || plumbingOk,
    okEnters: enters.length >= opts.target,
    okPlumbing: plumbingOk,
    timedOut: !done(),
    target: opts.target,
    targetWindows: opts.targetWindows,
    count: enters.length,
    windowsSeen: windowsSeen.size,
    assets: opts.assets,
    probe: opts.probe,
    decisionLatencyMs: { n: lat.length, p50, p95 },
    feedStats,
    enters,
  };
  const sumPath = path.join(outDir, `summary_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(report, null, 2));
  console.log('=== sprint result ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(`summary → ${sumPath}`);
  process.exitCode = report.ok ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
