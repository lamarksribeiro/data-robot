#!/usr/bin/env node
/**
 * Adaptive + Accumulate micro harness (WS max speed).
 *
 * Default DRY. --live = ordens reais (liveGate).
 *
 *   node scripts/escada-dupla/adaptive-micro.js --max-events=3 --min-tau-start=180
 *   node scripts/escada-dupla/adaptive-micro.js --live --max-events=1
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { hasLiveFlag, requireLiveFlag } from '../../src/cli/liveGate.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  ACCUMULATE,
  MIN_SHARES,
  createAdaptiveState,
  proposeAction,
  recordBuy,
  summarize,
  invested,
  residual,
  avgSum,
  pairedShares,
} from './adaptive-engine.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}
function roundPx(p) {
  return Math.min(0.99, Math.max(0.01, Math.round(Number(p) * 100) / 100));
}
function roundSh(s) {
  return Math.max(MIN_SHARES, Math.round(Number(s) * 100) / 100);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const live = hasLiveFlag(argv);
  if (live) {
    requireLiveFlag('escada:adaptive-micro', {
      argv,
      hint: 'npm run escada:adaptive-micro -- --live --max-events=1',
    });
  }
  return {
    live,
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '3', 10) || 3),
    maxNotional: Math.max(5, parseFloat(valueOf('--max-notional') ?? String(ACCUMULATE.maxNotional)) || ACCUMULATE.maxNotional),
    maxSideShares: Math.max(MIN_SHARES, parseInt(valueOf('--max-side') ?? String(ACCUMULATE.maxSideShares), 10) || ACCUMULATE.maxSideShares),
    pollMs: Math.max(0, parseInt(valueOf('--poll-ms') ?? '10', 10) || 0),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '180', 10) || 0),
    waitTimeoutSec: Math.max(30, parseInt(valueOf('--wait-timeout') ?? String(Math.max(600, 400 * 3)), 10) || 600),
    openAskMax: parseFloat(valueOf('--open-ask-max') ?? String(ACCUMULATE.openAskMax)),
    hedgeAvgSumMax: parseFloat(valueOf('--hedge-avg-sum-max') ?? String(ACCUMULATE.hedgeAvgSumMax)),
  };
}

async function waitMatched(client, orderId, settleMs = 450, settlePollMs = 40) {
  const deadline = Date.now() + settleMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await client.getOrder(orderId);
    } catch {
      await sleep(settlePollMs);
      continue;
    }
    const matched = Number(last?.size_matched ?? 0) || 0;
    const original = Number(last?.original_size ?? 0) || 0;
    const status = String(last?.status ?? '').toLowerCase();
    if (original > 0 && matched + 1e-9 >= original) return { matched, terminal: true, order: last };
    if (['canceled', 'cancelled', 'expired', 'matched', 'filled'].some((s) => status.includes(s))) {
      return { matched, terminal: true, order: last };
    }
    await sleep(settlePollMs);
  }
  return { matched: Number(last?.size_matched ?? 0) || 0, terminal: false, order: last };
}

async function takerBuy(client, live, tokenId, price, size, label) {
  const t0 = performance.now();
  const px = roundPx(price);
  const sh = roundSh(size);
  if (!live) {
    return { ok: true, dry: true, filledSize: sh, price: px, ms: 0, orderId: null, label };
  }
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: px, side: Side.BUY, size: sh },
      undefined,
      OrderType.GTC,
      false,
      false,
    );
    const orderId = resp?.orderID ?? null;
    if (!resp?.success || !orderId) {
      return { ok: false, filledSize: 0, price: px, ms: Math.round(performance.now() - t0), orderId, label, err: resp?.errorMsg };
    }
    let matched = Number(resp?.takingAmount ?? 0) || 0;
    let settle = await waitMatched(client, orderId);
    matched = Math.max(matched, settle.matched || 0);
    if (matched + 1e-9 < sh) {
      try {
        await client.cancelOrder({ orderID: orderId });
      } catch {
        /* */
      }
      settle = await waitMatched(client, orderId, 300, 40);
      matched = Math.max(matched, settle.matched || 0);
    }
    return {
      ok: true,
      filledSize: matched,
      price: px,
      matchPrice: px,
      ms: Math.round(performance.now() - t0),
      orderId,
      label,
    };
  } catch (err) {
    return { ok: false, filledSize: 0, price: px, ms: Math.round(performance.now() - t0), label, err: err.message };
  }
}

async function restBuy(client, live, tokenId, price, size, label) {
  const px = roundPx(price);
  const sh = roundSh(size);
  if (!live) {
    return { ok: true, dry: true, orderId: `dry-${label}-${Date.now()}`, price: px, size: sh, label };
  }
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: px, side: Side.BUY, size: sh },
      undefined,
      OrderType.GTC,
      false,
      false,
    );
    const orderId = resp?.orderID ?? null;
    if (!resp?.success || !orderId) return { ok: false, err: resp?.errorMsg, price: px, size: sh, label };
    return { ok: true, orderId, price: px, size: sh, label };
  } catch (err) {
    return { ok: false, err: err.message, price: px, size: sh, label };
  }
}

async function cancelAll(client, live, label = 'cancelAll') {
  if (!live || !client?.cancelAll) return;
  try {
    const resp = await client.cancelAll();
    console.log(`🛡 ${label}`, resp?.canceled?.length ?? '');
  } catch (err) {
    console.log(`⚠ ${label}: ${err.message}`);
  }
}

function tokenOf(event, side) {
  return side === 'UP' ? event.upTokenId : event.downTokenId;
}

async function pollRests(st, client, live) {
  if (!live || !client) return;
  for (const r of st.rests) {
    if (r.filled + 1e-9 >= r.sh || !r.orderId) continue;
    try {
      const o = await client.getOrder(r.orderId);
      const matched = Number(o?.size_matched ?? 0) || 0;
      const delta = matched - (r.filled || 0);
      if (delta > 1e-9) {
        // prefer match price from order if present
        const px = Number(o?.price ?? r.px) || r.px;
        recordBuy(st, r.side, px, delta, `REST@${r.px}`, { orderId: r.orderId });
        r.filled = matched;
        console.log(`↓ rest fill ${r.side} @${px} +${delta}`);
      }
    } catch {
      /* */
    }
  }
}

function dryCrossRests(st, asks, prev) {
  for (const r of st.rests) {
    if ((r.filled || 0) + 1e-9 >= r.sh) continue;
    const a0 = prev[r.side];
    const a1 = asks[r.side];
    if (a0 == null || a1 == null) continue;
    if (a0 > r.px + 1e-12 && a1 <= r.px + 1e-12) {
      const need = r.sh - (r.filled || 0);
      recordBuy(st, r.side, r.px, need, `REST@${r.px}`, { dry: true });
      r.filled = r.sh;
      console.log(`↓ rest dry ${r.side} @${r.px} +${need}`);
    }
  }
}

async function waitWindow(minTau, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const ev = await findActiveBtc5mEvent();
    if (ev?.eventEnd) {
      const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
      const tau = Math.floor((endMs - Date.now()) / 1000);
      if (tau >= minTau) {
        console.log(`window ok slug=${ev.slug} tau=${tau}`);
        return;
      }
      console.log(`waiting… slug=${ev.slug || '?'} tau=${tau}`);
    }
    await sleep(1500);
  }
  throw new Error('timeout waiting window');
}

async function runEvent({ opts, state, clobFeed, client, wake, kickRef }) {
  const event = await findActiveBtc5mEvent();
  if (!event?.upTokenId) throw new Error('no event');
  const endMs =
    event.eventEnd instanceof Date ? event.eventEnd.getTime() : Number(event.eventEndMs ?? Date.now() + 300_000);
  const tau0 = Math.floor((endMs - Date.now()) / 1000);
  if (tau0 < 20) return { skipped: true, reason: 'tau_low', tau: tau0 };

  clobFeed.subscribe(event.upTokenId, event.downTokenId);
  await clobFeed.refreshBooks();

  const st = createAdaptiveState({
    maxNotional: opts.maxNotional,
    maxSideShares: opts.maxSideShares,
    openAskMax: opts.openAskMax,
    hedgeAvgSumMax: opts.hedgeAvgSumMax,
  });
  let prevAsks = { UP: null, DOWN: null };
  let loops = 0;
  let lastHb = 0;
  let lastStale = 0;
  let inflight = false;
  let lastSlugWait = null;

  console.log(
    `event=${event.slug} tau≈${tau0}s live=${opts.live} notional≤$${opts.maxNotional} ` +
      `open≤${opts.openAskMax} hedgeAvg≤${opts.hedgeAvgSumMax} maxSide=${opts.maxSideShares}`,
  );

  const decide = async () => {
    const tau = Math.floor((endMs - Date.now()) / 1000);
    if (tau <= 0) return;
    if (inflight) return;
    const lag = clobFeed.lagMs();
    const fresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;
    const now = Date.now();
    if (!fresh) {
      if (now - lastStale >= 400) {
        lastStale = now;
        await clobFeed.refreshBooks();
      }
      return;
    }
    const asks = { UP: state.up.bestAsk, DOWN: state.down.bestAsk };
    loops += 1;

    await pollRests(st, client, opts.live);
    if (!opts.live) dryCrossRests(st, asks, prevAsks);

    // done?
    if (pairedShares(st) >= MIN_SHARES && residual(st).shares < 0.5) {
      const as = avgSum(st);
      if (as != null && as <= opts.hedgeAvgSumMax + 0.02) {
        st.mode = 'done';
        await cancelAll(client, opts.live, 'balanced');
        st.rests = [];
        prevAsks = asks;
        return;
      }
    }

    const action = proposeAction(st, asks, tau);
    if (action.type === 'HOLD') {
      if (now - lastHb >= 3000) {
        lastHb = now;
        const s = summarize(st, asks, tau);
        console.log(
          `… hb tau=${tau} mode=${st.mode} act=${action.reason} inv=$${s.invested} ` +
            `UP=${st.inv.UP.shares} DN=${st.inv.DOWN.shares} avg=${s.avgSum ?? '-'} edge=${s.edge} loops=${loops}`,
        );
      }
      prevAsks = asks;
      return;
    }

    inflight = true;
    try {
      if (action.type === 'BUY') {
        const r = await takerBuy(client, opts.live, tokenOf(event, action.side), action.px, action.sh, action.reason);
        console.log(
          `→ BUY ${action.side} @${action.px} sh=${action.sh} (${action.reason} score=${action.score.toFixed(3)}) ` +
            `filled=${r.filledSize} ${r.ms || 0}ms ${r.err || ''}`,
        );
        if (r.filledSize > 0) {
          recordBuy(st, action.side, r.price, r.filledSize, action.reason, { orderId: r.orderId, ms: r.ms });
        } else {
          st.blocks.push({ reason: 'BUY_MISS', ...action, err: r.err });
        }
      } else if (action.type === 'REST') {
        if (st.rests.some((x) => x.side === action.side && Math.abs(x.px - action.px) < 1e-9)) {
          /* already */
        } else {
          const r = await restBuy(client, opts.live, tokenOf(event, action.side), action.px, action.sh, action.reason);
          if (r.ok) {
            st.rests.push({ side: action.side, px: r.price, sh: r.size || action.sh, orderId: r.orderId, filled: 0 });
            console.log(`⤵ REST ${action.side} @${r.price} sh=${action.sh} (${action.reason})`);
          } else {
            st.blocks.push({ reason: 'REST_FAIL', err: r.err, ...action });
          }
        }
      }
    } finally {
      inflight = false;
    }

    if (now - lastHb >= 3000) {
      lastHb = now;
      const s = summarize(st, asks, tau);
      console.log(
        `… hb tau=${tau} mode=${st.mode} inv=$${s.invested} UP=${st.inv.UP.shares} DN=${st.inv.DOWN.shares} ` +
          `avg=${s.avgSum ?? '-'} edge=${s.edge} rests=${st.rests.length} loops=${loops}`,
      );
    }
    prevAsks = asks;
  };

  kickRef.current = decide;
  const deadline = Date.now() + Math.min(opts.timeoutSec, Math.max(25, tau0 + 3)) * 1000;
  while (Date.now() < deadline && st.mode !== 'done') {
    wake();
    if (st.mode === 'done') break;
    await sleep(opts.pollMs > 0 ? opts.pollMs : 5);
  }

  await cancelAll(client, opts.live, 'event-end');
  // última chance escape
  const asks = { UP: state.up.bestAsk, DOWN: state.down.bestAsk };
  const tau = Math.min(Math.floor((endMs - Date.now()) / 1000), ACCUMULATE.escapeTau);
  const lastAct = proposeAction(st, asks, tau);
  if (lastAct.type === 'BUY' && !inflight) {
    const r = await takerBuy(client, opts.live, tokenOf(event, lastAct.side), lastAct.px, lastAct.sh, lastAct.reason);
    if (r.filledSize > 0) recordBuy(st, lastAct.side, r.price, r.filledSize, lastAct.reason, { final: true });
  }

  const upAsk = state.up.bestAsk;
  const dnAsk = state.down.bestAsk;
  const winner = upAsk != null && dnAsk != null ? (upAsk >= dnAsk ? 'UP' : 'DOWN') : null;
  const cost = invested(st) + st.inv.UP.fees + st.inv.DOWN.fees;
  const pnl = winner != null ? Math.round((st.inv[winner].shares - cost) * 100) / 100 : null;
  const sum = summarize(st, asks, tau);
  kickRef.current = null;

  return {
    skipped: false,
    generatedAt: nowIso(),
    live: opts.live,
    dry: !opts.live,
    strategy: 'adaptive-accumulate',
    event: { slug: event.slug },
    ...sum,
    winner,
    pnl,
    fills: st.fills,
    blocksTail: st.blocks.slice(-30),
    loops,
    lastSlugWait,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Adaptive + Accumulate (WS) ===');
  console.log(
    `mode=${opts.live ? 'LIVE $$' : 'DRY'} events=${opts.maxEvents} notional≤$${opts.maxNotional} ` +
      `openAsk≤${opts.openAskMax} hedgeAvg≤${opts.hedgeAvgSumMax} maxSide=${opts.maxSideShares} pollMs=${opts.pollMs}`,
  );

  if (opts.minTauStart > 0) await waitWindow(opts.minTauStart, opts.waitTimeoutSec);

  let client = null;
  if (opts.live) {
    const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
    client = buildClobClient({ wallet, throwOnError: true });
    console.log(`signer=${wallet.address}`);
    await cancelAll(client, true, 'preflight');
  }

  const kickRef = { current: null };
  let busy = false;
  let queued = false;
  const wake = () => {
    queued = true;
    if (busy) return;
    busy = true;
    (async () => {
      try {
        while (queued) {
          queued = false;
          if (kickRef.current) await kickRef.current();
        }
      } catch (err) {
        console.log(`⚠ tick: ${err.message}`);
      } finally {
        busy = false;
        if (queued) wake();
      }
    })();
  };

  const state = createMarketState();
  const clobFeed = createClobFeed(state, {
    onUpdate: () => wake(),
    onStaleReconnect: ({ reason, lagMs }) => console.log(`⚠ WS reconnect ${reason} lag=${Math.round(lagMs)}`),
  });

  process.on('SIGINT', () => void (async () => {
    await cancelAll(client, opts.live, 'SIGINT');
    clobFeed.stop?.();
    process.exit(130);
  })());

  const outDir = path.resolve('runs/adaptive-micro');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  let lastSlug = null;

  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      if (i > 0 && opts.minTauStart > 0) {
        const deadline = Date.now() + opts.waitTimeoutSec * 1000;
        while (Date.now() < deadline) {
          const ev = await findActiveBtc5mEvent();
          const endMs = ev?.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev?.eventEnd);
          const tau = endMs ? Math.floor((endMs - Date.now()) / 1000) : 0;
          if (ev?.slug && ev.slug !== lastSlug && tau >= opts.minTauStart) {
            console.log(`next window ${ev.slug} tau=${tau}`);
            break;
          }
          console.log(`waiting next… ${ev?.slug || '?'} tau=${tau}`);
          await sleep(2000);
        }
      }
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runEvent({ opts, state, clobFeed, client, wake, kickRef });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip ${rep.reason}`);
        continue;
      }
      lastSlug = rep.event?.slug || lastSlug;
      console.log(
        `[result] avg=${rep.avgSum} inv=$${rep.invested} paired=${rep.paired} ` +
          `res=${rep.residual?.side || '-'}@${rep.residual?.shares} edge=${rep.edge} pnl≈${rep.pnl} fills=${rep.fills?.length}`,
      );
      const fname = `ad_${opts.live ? 'live' : 'dry'}_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);
    }
  } finally {
    await cancelAll(client, opts.live, 'shutdown');
    clobFeed.stop?.();
  }

  const summary = {
    generatedAt: nowIso(),
    live: opts.live,
    strategy: 'adaptive-accumulate',
    events: reports.filter((r) => !r.skipped).map((r) => ({
      slug: r.event?.slug,
      avgSum: r.avgSum,
      pnl: r.pnl,
      invested: r.invested,
      paired: r.paired,
      residual: r.residual,
      fills: r.fills?.length,
    })),
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
