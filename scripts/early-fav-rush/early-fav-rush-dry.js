#!/usr/bin/env node
/**
 * Early Favorite Rush — dry/shadow multi-asset na Giovanna.
 *
 * ZERO ordens CLOB. Recusa --live.
 * Roda no sidecar pair-path-micro (não no engine live).
 *
 * Status: REJEITADA / HOLD no lab causal — dry só observação.
 * Stack: disaster bid≤0.15 + cross majority|quorum2.
 *
 *   node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=30 --cross=majority
 *   docker exec pair-path-micro node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=40
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
  ASSET_RULES,
  DISASTER_EXIT,
  CROSS_GATES,
  ruleFor,
  normalizeCrossGate,
  applyCrossGate,
  createEventState,
  tryEntry,
  tryDisasterExit,
  exitAtBid,
  settle,
  summarize,
} from './early-fav-rush-engine.js';

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
    throw new Error('early-fav-rush-dry recusa --live (só dry/shadow WS).');
  }
  const defaultAssets = Object.keys(ASSET_RULES).join(',');
  const assets = String(valueOf('--assets') ?? defaultAssets)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const a of assets) {
    resolveCrypto5mAsset(a);
    ruleFor(a);
  }
  const fill = String(valueOf('--fill') ?? 'honest').toLowerCase();
  if (!['honest', 'cruel'].includes(fill)) {
    throw new Error('--fill deve ser honest|cruel');
  }
  const disasterRaw = String(valueOf('--disaster') ?? '1').toLowerCase();
  const disasterOn = !['0', 'false', 'off', 'no'].includes(disasterRaw);
  return {
    assets,
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '40', 10) || 40),
    timeoutSec: Math.max(60, parseInt(valueOf('--timeout') ?? '14400', 10) || 14400),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    entryBudget: Math.max(1, parseFloat(valueOf('--budget') ?? '5') || 5),
    cruelLatencyMs: Math.max(0, parseInt(valueOf('--cruel-latency-ms') ?? '80', 10) || 0),
    fill,
    wakeTau: Math.max(50, parseInt(valueOf('--wake-tau') ?? '250', 10) || 250),
    crossGate: normalizeCrossGate(valueOf('--cross') ?? CROSS_GATES.majority),
    disasterOn,
    /** Resolve majority quando τ cai abaixo disso (ou todos decidiram). */
    crossCommitTau: Math.max(30, parseInt(valueOf('--cross-commit-tau') ?? '55', 10) || 55),
  };
}

function eventTau(ev) {
  if (!ev?.eventEnd) return null;
  const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
  return Math.floor((endMs - Date.now()) / 1000);
}

function eventEpochKey(ev) {
  if (!ev?.eventStart) return null;
  const s = ev.eventStart;
  const ms = s instanceof Date ? s.getTime() : Date.parse(String(s)) || Number(s);
  if (!Number.isFinite(ms)) return null;
  return String(Math.floor(ms / 1000));
}

function createAssetCtx(assetKey) {
  const meta = resolveCrypto5mAsset(assetKey);
  const rule = ruleFor(assetKey);
  const state = createMarketState();
  return {
    assetKey,
    meta,
    rule,
    state,
    stopRtds: startRtdsFeed(state, { symbol: meta.rtdsSymbol }),
    clobFeed: createClobFeed(state),
    event: null,
    lastEventFetchMs: 0,
    lastPtbRetryMs: 0,
    st: null,
    doneSlugs: new Set(),
  };
}

async function refreshEvent(ctx) {
  const now = Date.now();
  if (now - ctx.lastEventFetchMs < 800 && ctx.event) return ctx.event;
  ctx.lastEventFetchMs = now;
  const ev = await findActiveCrypto5mEvent(ctx.assetKey);
  if (!ev?.upTokenId) {
    ctx.event = null;
    ctx.st = null;
    return null;
  }
  if (!ctx.event || ctx.event.slug !== ev.slug) {
    ctx.event = ev;
    ctx.st = createEventState();
    ctx.clobFeed.subscribe(ev.upTokenId, ev.downTokenId);
    await ctx.clobFeed.refreshBooks();
    ctx.state.priceToBeat = await fetchPriceToBeat(ev.eventStart, ev.eventEnd, {
      symbol: ctx.meta.ptbSymbol,
    });
    ctx.lastPtbRetryMs = now;
    console.log(
      `[${ctx.assetKey}] event=${ev.slug} ptb=${ctx.state.priceToBeat ?? 'pendente'}` +
        ` rule=thr${ctx.rule.thr}@τ${ctx.rule.minTau}-${ctx.rule.maxTau}` +
        `${ctx.rule.requireSpot ? '+spot' : ''}`,
    );
  }
  return ctx.event;
}

function bookTick(ctx) {
  const { state } = ctx;
  return {
    tau: eventTau(ctx.event),
    upAsk: state.up?.bestAsk ?? null,
    downAsk: state.down?.bestAsk ?? null,
    upBid: state.up?.bestBid ?? null,
    downBid: state.down?.bestBid ?? null,
    spot: state.btc ?? null,
    ptb: state.priceToBeat ?? null,
  };
}

function pushTrade(trades, ctx, ev, extra = {}) {
  const row = {
    asset: ctx.assetKey,
    slug: ev.slug,
    side: ctx.st.side,
    ask: ctx.st.ask,
    tauAtEntry: ctx.st.tauAtEntry,
    won: ctx.st.won,
    pnl: ctx.st.pnl,
    exitKind: ctx.st.exitKind || 'settle',
    exitBid: ctx.st.exitBid ?? null,
    exitTau: ctx.st.exitTau ?? null,
    winner: extra.winner ?? null,
    crossGate: extra.crossGate ?? null,
    ts: nowIso(),
    ...extra,
  };
  trades.push(row);
  ctx.doneSlugs.add(ev.slug);
  return row;
}

function abortPending(ctx, reason) {
  if (!ctx.st) return;
  ctx.st.entered = false;
  ctx.st.pendingCross = false;
  ctx.st.armed = false;
  ctx.st.skipReason = reason;
  ctx.st.settled = true;
  if (ctx.event?.slug) ctx.doneSlugs.add(ctx.event.slug);
}

/**
 * Resolve gate cross-asset para um epoch (eventStart compartilhado).
 * majority: espera todos decidirem ou τ≤commitTau.
 * quorum2: entra assim que ≥2 no mesmo lado.
 */
function resolveCrossEpoch(ctxs, epochKey, opts, log) {
  const cohort = ctxs.filter((c) => c.event && eventEpochKey(c.event) === epochKey);
  if (!cohort.length) return;

  const pending = cohort.filter((c) => c.st?.entered && c.st?.pendingCross && !c.st?.settled);
  if (!pending.length) return;

  const decided = cohort.filter(
    (c) =>
      (c.st?.entered && c.st?.pendingCross) ||
      c.doneSlugs.has(c.event?.slug) ||
      (c.st && !c.st.armed && !c.st.entered) ||
      c.st?.skipReason,
  );
  const taus = cohort.map((c) => eventTau(c.event)).filter((t) => t != null);
  const minTau = taus.length ? Math.min(...taus) : null;
  const allDecided = decided.length >= cohort.length;
  const timedOut = minTau != null && minTau <= opts.crossCommitTau;

  if (opts.crossGate === CROSS_GATES.quorum2) {
    const cands = pending.map((c) => ({ asset: c.assetKey, side: c.st.side, ctx: c }));
    const accepted = applyCrossGate(cands, CROSS_GATES.quorum2);
    if (!accepted.length) {
      if (allDecided || timedOut) {
        for (const c of pending) {
          abortPending(c, 'cross_quorum2_fail');
          log(`[CROSS-SKIP ${c.assetKey}] quorum2 slug=${c.event.slug}`);
        }
      }
      return;
    }
    const ok = new Set(accepted.map((a) => a.asset));
    for (const c of pending) {
      if (ok.has(c.assetKey)) {
        c.st.pendingCross = false;
        log(
          `[CROSS-ENTER ${c.assetKey}] ${c.st.side}@${c.st.ask.toFixed(3)} τ=${c.st.tauAtEntry} quorum2`,
        );
      } else if (allDecided || timedOut) {
        abortPending(c, 'cross_quorum2_side');
        log(`[CROSS-SKIP ${c.assetKey}] quorum2 side slug=${c.event.slug}`);
      }
    }
    return;
  }

  if (opts.crossGate === CROSS_GATES.majority) {
    if (!allDecided && !timedOut) return;
    const cands = pending.map((c) => ({ asset: c.assetKey, side: c.st.side, ctx: c }));
    const accepted = applyCrossGate(cands, CROSS_GATES.majority);
    const ok = new Set(accepted.map((a) => a.asset));
    for (const c of pending) {
      if (ok.has(c.assetKey)) {
        c.st.pendingCross = false;
        log(
          `[CROSS-ENTER ${c.assetKey}] ${c.st.side}@${c.st.ask.toFixed(3)} τ=${c.st.tauAtEntry} majority`,
        );
      } else {
        abortPending(c, accepted.length ? 'cross_majority_side' : 'cross_majority_tie');
        log(`[CROSS-SKIP ${c.assetKey}] majority slug=${c.event.slug}`);
      }
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Early Favorite Rush DRY (multi-asset · zero ordens) ===');
  console.log(
    `assets=${opts.assets.join(',')} budget=$${opts.entryBudget} maxEvents=${opts.maxEvents}` +
      ` fill=${opts.fill} timeout=${opts.timeoutSec}s`,
  );
  console.log(
    `disaster=${opts.disasterOn ? `bid≤${DISASTER_EXIT.bidMax}@τ≤${DISASTER_EXIT.tauMax}+flips` : 'off'}` +
      ` cross=${opts.crossGate} commitτ≤${opts.crossCommitTau}`,
  );
  console.log(
    '⚠ REJEITADA no lab causal — dry observação only; não dimensionar capital. Não mata scalp-dry.',
  );

  const ctxs = opts.assets.map(createAssetCtx);
  const trades = [];
  const outDir = path.resolve('runs/early-fav-rush-dry');
  fs.mkdirSync(outDir, { recursive: true });
  const runId = nowIso().replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `report-${runId}.json`);

  const deadline = Date.now() + opts.timeoutSec * 1000;
  let lastHb = 0;

  const shutdown = async (code = 0) => {
    for (const ctx of ctxs) {
      try {
        ctx.stopRtds?.();
        ctx.clobFeed?.stop?.();
      } catch {
        /* ignore */
      }
    }
    const byAsset = {};
    for (const a of opts.assets) {
      byAsset[a] = summarize(trades.filter((t) => t.asset === a));
    }
    const report = {
      generatedAt: nowIso(),
      status: 'REJECTED_HOLD_OBSERVATION',
      opts,
      disaster: opts.disasterOn ? DISASTER_EXIT : null,
      summary: summarize(trades),
      byAsset,
      trades,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('\n=== RESUMO ===');
    console.log(JSON.stringify(report.summary, null, 2));
    console.table(
      opts.assets.map((a) => ({
        asset: a,
        ...byAsset[a],
      })),
    );
    console.log(`report → ${reportPath}`);
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  try {
    while (trades.length < opts.maxEvents && Date.now() < deadline) {
      await Promise.all(ctxs.map((c) => refreshEvent(c)));

      const live = ctxs
        .map((ctx) => ({ ctx, tau: eventTau(ctx.event) }))
        .filter((x) => x.ctx.event && x.tau != null && x.tau > 0);

      if (!live.length) {
        await sleep(1000);
        continue;
      }

      const minTau = Math.min(...live.map((x) => x.tau));
      if (minTau > opts.wakeTau) {
        const sleepSec = Math.min(minTau - opts.wakeTau, 15);
        if (Date.now() - lastHb > 15_000) {
          lastHb = Date.now();
          console.log(
            `[hb] trades=${trades.length}/${opts.maxEvents} minτ=${minTau} sleep ${sleepSec}s`,
          );
        }
        await sleep(sleepSec * 1000);
        continue;
      }

      const now = Date.now();
      for (const { ctx, tau } of live) {
        const { state, event: ev, rule } = ctx;
        if (!ev || !ctx.st) continue;

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

        const lag = ctx.clobFeed.lagMs();
        const bookFresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;
        if (!bookFresh) {
          await ctx.clobFeed.refreshBooks();
        }

        const tick = bookTick(ctx);
        tick.tau = tau;

        // Posição aberta (já passou do cross-gate): disaster / settle
        if (ctx.st.entered && !ctx.st.pendingCross && !ctx.st.settled) {
          if (
            opts.disasterOn &&
            bookFresh &&
            tick.upAsk != null &&
            tick.downAsk != null
          ) {
            const d = tryDisasterExit(ctx.st, tick, DISASTER_EXIT);
            if (d.exit) {
              if (opts.fill === 'cruel') await sleep(opts.cruelLatencyMs);
              const tick2 = bookTick(ctx);
              const bid =
                ctx.st.side === 'UP'
                  ? (tick2.upBid ?? d.bid)
                  : (tick2.downBid ?? d.bid);
              const res = exitAtBid(ctx.st, bid, tau, opts.entryBudget, 'disaster');
              if (res) {
                const row = pushTrade(trades, ctx, ev, { crossGate: opts.crossGate });
                console.log(
                  `[DISASTER-EXIT ${ctx.assetKey}] ${row.side}@${row.ask} τEntry=${row.tauAtEntry}` +
                    ` exitBid=${res.exitBid.toFixed(3)} τ=${res.exitTau}` +
                    ` pnl=${row.pnl.toFixed(2)} (${trades.length}/${opts.maxEvents})`,
                );
              }
              continue;
            }
          }

          if (tau <= 2) {
            if (opts.fill === 'cruel') await sleep(opts.cruelLatencyMs);
            const spot = state.btc;
            const ptb = state.priceToBeat;
            if (Number.isFinite(spot) && Number.isFinite(ptb)) {
              const res = settle(ctx.st, spot, ptb, opts.entryBudget);
              if (res) {
                const row = pushTrade(trades, ctx, ev, {
                  winner: res.winner,
                  crossGate: opts.crossGate,
                });
                console.log(
                  `[ENTER-SETTLE ${ctx.assetKey}] ${row.side}@${row.ask} τ=${row.tauAtEntry}` +
                    ` won=${row.won} pnl=${row.pnl.toFixed(2)} (${trades.length}/${opts.maxEvents})`,
                );
              }
            }
          }
          continue;
        }

        // Pending cross: não reavalia entrada
        if (ctx.st.entered && ctx.st.pendingCross) continue;

        if (ctx.doneSlugs.has(ev.slug)) continue;
        if (!bookFresh) continue;
        if (tick.upAsk == null || tick.downAsk == null) continue;

        const decision = tryEntry(ctx.st, tick, rule, opts.entryBudget);
        if (decision.enter) {
          if (opts.fill === 'cruel') await sleep(opts.cruelLatencyMs);
          const tick2 = bookTick(ctx);
          if (
            opts.fill === 'cruel' &&
            Number.isFinite(tick2.upAsk) &&
            Number.isFinite(tick2.downAsk)
          ) {
            const sideAsk = decision.side === 'UP' ? tick2.upAsk : tick2.downAsk;
            if (Number.isFinite(sideAsk) && sideAsk > ctx.st.ask) {
              ctx.st.ask = sideAsk;
              ctx.st.shares = opts.entryBudget / sideAsk;
              ctx.st.fee =
                0.07 *
                Math.min(0.99, Math.max(0.01, sideAsk)) *
                (1 - Math.min(0.99, Math.max(0.01, sideAsk))) *
                ctx.st.shares;
            }
          }
          if (opts.crossGate === CROSS_GATES.none) {
            console.log(
              `[SIGNAL ${ctx.assetKey}] ${ctx.st.side}@${ctx.st.ask.toFixed(3)} τ=${ctx.st.tauAtEntry}`,
            );
          } else {
            ctx.st.pendingCross = true;
            console.log(
              `[SIGNAL-PEND ${ctx.assetKey}] ${ctx.st.side}@${ctx.st.ask.toFixed(3)} τ=${ctx.st.tauAtEntry}` +
                ` waiting ${opts.crossGate}`,
            );
          }
        } else if (ctx.st.skipReason && !ctx.st.entered) {
          if (!ctx.st._skipLogged) {
            ctx.st._skipLogged = true;
            console.log(`[SKIP ${ctx.assetKey}] ${ctx.st.skipReason} slug=${ev.slug}`);
            ctx.doneSlugs.add(ev.slug);
          }
        }
      }

      // Resolve cross gates por epoch
      if (opts.crossGate !== CROSS_GATES.none) {
        const epochs = new Set();
        for (const ctx of ctxs) {
          const k = ctx.event ? eventEpochKey(ctx.event) : null;
          if (k) epochs.add(k);
        }
        for (const epoch of epochs) {
          resolveCrossEpoch(ctxs, epoch, opts, console.log);
        }
      }

      if (Date.now() - lastHb > 20_000) {
        lastHb = Date.now();
        const open = ctxs.filter(
          (c) => c.st?.entered && !c.st?.pendingCross && !c.st?.settled,
        ).length;
        const pend = ctxs.filter((c) => c.st?.pendingCross).length;
        console.log(
          `[hb] trades=${trades.length}/${opts.maxEvents} open=${open} pendCross=${pend} minτ=${minTau}`,
        );
      }

      await sleep(opts.pollMs);
    }
  } catch (err) {
    console.error('fatal', err);
    await shutdown(1);
    return;
  }

  await shutdown(0);
}

main();
