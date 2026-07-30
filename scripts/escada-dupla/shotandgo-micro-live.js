#!/usr/bin/env node
/**
 * Shotandgo hybrid micro — máximo de velocidade (WS-driven).
 *
 * Mínimo operacional:
 *   open SUB (taker GTC settle+cancel) → DESC resting (GTC limit) → EQ/escape residual
 *   miss → reenvio no próximo tick · residual → balance/EQ agressivo
 *
 * Default: DRY (simula fills no book WS).
 * Live: --live (ordens reais). Exige flag explícita.
 *
 * Size CLOB mínimo = 5. Notional default $8 (cabe 1 par 5sh).
 * Velocidade: tick no onUpdate do WS + poll backup (default 10ms). Sem latência artificial.
 *
 *   node scripts/escada-dupla/shotandgo-micro-live.js --max-events=1
 *   node scripts/escada-dupla/shotandgo-micro-live.js --live --max-events=1
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

const MIN_SHARES = 5;

const CFG = {
  shares: MIN_SHARES,
  subLevels: [0.55, 0.6, 0.65],
  descPlan: [
    { askMax: 0.4, frac: 0.4 },
    { askMax: 0.36, frac: 0.3 },
    { askMax: 0.32, frac: 0.3 },
  ],
  openCap: 0.02,
  openOppMax: 0.42,
  bookSumMin: 0.95,
  bookSumMax: 1.05,
  avgSumMax: 0.94,
  eqAskMax: 0.05,
  escapeTau: 25,
  escapeAskMax: 0.45,
  escapeAvgSumMax: 0.98,
  maxNotional: 8,
  maxEvents: 1,
  /** Backup se WS quieto — quanto menor, mais rápido. 0 = só WS. */
  pollMs: 10,
  maxBookAgeMs: 2500,
  settleMs: 450,
  settlePollMs: 40,
  feeRate: 0.07,
  tauOpenMin: 25,
  tauOpenMax: 290,
};

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
function feeFor(px, sh) {
  const p = Math.min(0.99, Math.max(0.01, px));
  return CFG.feeRate * p * (1 - p) * sh;
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
    requireLiveFlag('escada:shotandgo-micro-live', {
      argv,
      hint: 'npm run escada:shotandgo-micro -- --live --max-events=1',
    });
  }
  const pollRaw = valueOf('--poll-ms');
  return {
    live,
    shares: Math.max(MIN_SHARES, parseInt(valueOf('--shares') ?? String(CFG.shares), 10) || CFG.shares),
    maxNotional: Math.max(3, parseFloat(valueOf('--max-notional') ?? String(CFG.maxNotional)) || CFG.maxNotional),
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? String(CFG.maxEvents), 10) || CFG.maxEvents),
    pollMs: pollRaw != null ? Math.max(0, parseInt(pollRaw, 10) || 0) : CFG.pollMs,
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? String(CFG.maxBookAgeMs), 10) || CFG.maxBookAgeMs),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '180', 10) || 0),
    waitTimeoutSec: Math.max(30, parseInt(valueOf('--wait-timeout') ?? '600', 10) || 600),
  };
}

async function waitMatched(client, orderId, settleMs, settlePollMs) {
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
    if (original > 0 && matched + 1e-9 >= original) return { matched, original, terminal: true, order: last };
    if (['canceled', 'cancelled', 'expired', 'matched', 'filled'].some((s) => status.includes(s))) {
      return { matched, original, terminal: true, order: last };
    }
    await sleep(settlePollMs);
  }
  return {
    matched: Number(last?.size_matched ?? 0) || 0,
    original: Number(last?.original_size ?? 0) || 0,
    terminal: false,
    order: last,
  };
}

/** Taker: GTC marketable + settle curto + cancel resto. */
async function takerBuy(client, live, tokenId, price, size, label) {
  const t0 = performance.now();
  const px = roundPx(price);
  const sh = roundSh(size);
  if (!live) {
    return { ok: true, dry: true, filled: true, filledSize: sh, price: px, ms: 0, orderId: null, label };
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
      return {
        ok: false,
        dry: false,
        filled: false,
        filledSize: 0,
        price: px,
        ms: Math.round(performance.now() - t0),
        orderId,
        label,
        err: resp?.errorMsg,
      };
    }
    let matched = Number(resp?.takingAmount ?? 0) || 0;
    let settle = await waitMatched(client, orderId, CFG.settleMs, CFG.settlePollMs);
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
      dry: false,
      filled: matched > 0,
      filledSize: matched,
      price: px,
      ms: Math.round(performance.now() - t0),
      orderId,
      label,
    };
  } catch (err) {
    return {
      ok: false,
      dry: false,
      filled: false,
      filledSize: 0,
      price: px,
      ms: Math.round(performance.now() - t0),
      orderId: null,
      label,
      err: err.message,
    };
  }
}

/** Maker DESC: posta GTC no nível e deixa resting. */
async function restBuy(client, live, tokenId, price, size, label) {
  const t0 = performance.now();
  const px = roundPx(price);
  const sh = roundSh(size);
  if (!live) {
    return { ok: true, dry: true, orderId: `dry-${label}-${Date.now()}`, price: px, size: sh, ms: 0, label };
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
      return { ok: false, orderId: null, price: px, size: sh, ms: Math.round(performance.now() - t0), label, err: resp?.errorMsg };
    }
    return { ok: true, orderId, price: px, size: sh, ms: Math.round(performance.now() - t0), label };
  } catch (err) {
    return { ok: false, orderId: null, price: px, size: sh, ms: Math.round(performance.now() - t0), label, err: err.message };
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

function invested(inv) {
  return inv.UP.cost + inv.DOWN.cost;
}
function avg(inv, side) {
  const x = inv[side];
  return x.shares > 0 ? x.cost / x.shares : null;
}
function avgSum(inv) {
  const a = avg(inv, 'UP');
  const b = avg(inv, 'DOWN');
  return a != null && b != null ? a + b : null;
}
function residual(inv) {
  const d = inv.UP.shares - inv.DOWN.shares;
  if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
  return d > 0 ? { side: 'DOWN', shares: d } : { side: 'UP', shares: -d };
}
function record(inv, side, px, sh, kind, meta = {}) {
  const fee = feeFor(px, sh);
  inv[side].shares += sh;
  inv[side].cost += sh * px;
  inv[side].fees += fee;
  inv.fills.push({ side, px, sh, kind, fee, ts: nowIso(), ...meta });
}

function createLiveState(opts) {
  return {
    mode: 'idle', // idle | opened | done
    sideOpen: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
      fills: [],
    },
    subDone: { UP: new Set(), DOWN: new Set() },
    descRests: [], // {side, askMax, targetSh, filled, orderId, price}
    openInflight: false,
    eqInflight: false,
    descPosted: false,
    events: [],
    blocks: [],
    shares: opts.shares,
    maxNotional: opts.maxNotional,
  };
}

function tokenOf(event, side) {
  return side === 'UP' ? event.upTokenId : event.downTokenId;
}

async function pollDescFills(st, client, live) {
  for (const r of st.descRests) {
    if (r.filled + 1e-9 >= r.targetSh) continue;
    if (!live) {
      // dry: fill quando bestAsk cruza o nível (feito no decide)
      continue;
    }
    if (!r.orderId || !client) continue;
    try {
      const o = await client.getOrder(r.orderId);
      const matched = Number(o?.size_matched ?? 0) || 0;
      const delta = matched - r.filled;
      if (delta > 1e-9) {
        record(st.inv, r.side, r.price, delta, `DESC@${r.askMax}`, { orderId: r.orderId });
        r.filled = matched;
        st.events.push({ type: 'desc_fill', side: r.side, sh: delta, px: r.price });
      }
    } catch {
      /* */
    }
  }
}

function dryCrossDesc(st, asks, prevAsks) {
  for (const r of st.descRests) {
    if (r.filled + 1e-9 >= r.targetSh) continue;
    const prev = prevAsks[r.side];
    const curr = asks[r.side];
    if (prev == null || curr == null) continue;
    if (prev > r.askMax + 1e-12 && curr <= r.askMax + 1e-12) {
      const need = r.targetSh - r.filled;
      const take = Math.min(need, st.shares);
      if (invested(st.inv) + take * r.askMax > st.maxNotional + 1e-9) continue;
      record(st.inv, r.side, r.askMax, take, `DESC@${r.askMax}`, { dry: true });
      r.filled += take;
      st.events.push({ type: 'desc_fill_dry', side: r.side, sh: take, px: r.askMax });
    }
  }
}

async function postDescPlan(st, client, live, event, hedgeSide) {
  if (st.descPosted) return;
  const openSh = st.inv[st.sideOpen].shares;
  if (openSh < MIN_SHARES - 1e-9) return;
  st.descPosted = true;
  for (const lvl of CFG.descPlan) {
    let sh = Math.round(openSh * lvl.frac * 100) / 100;
    if (sh + 1e-9 < MIN_SHARES) sh = MIN_SHARES;
    if (invested(st.inv) + sh * lvl.askMax > st.maxNotional + 1e-9) {
      st.blocks.push({ reason: 'TETO_DESC', askMax: lvl.askMax, sh });
      continue;
    }
    const r = await restBuy(client, live, tokenOf(event, hedgeSide), lvl.askMax, sh, `DESC@${lvl.askMax}`);
    if (r.ok && r.orderId) {
      st.descRests.push({
        side: hedgeSide,
        askMax: lvl.askMax,
        targetSh: sh,
        filled: 0,
        orderId: r.orderId,
        price: r.price,
      });
      st.events.push({ type: 'desc_rest', side: hedgeSide, px: r.price, sh, orderId: r.orderId, ms: r.ms });
      console.log(`↓ DESC rest ${hedgeSide} @${r.price} sh=${sh} ${r.ms}ms`);
    } else {
      st.blocks.push({ reason: 'DESC_POST_FAIL', err: r.err, askMax: lvl.askMax });
      console.log(`⚠ DESC post fail @${lvl.askMax}: ${r.err || 'unknown'}`);
    }
  }
}

async function tryOpen(st, client, live, event, asks, tau) {
  if (st.mode !== 'idle' || st.openInflight) return;
  if (tau == null || tau < CFG.tauOpenMin || tau > CFG.tauOpenMax) return;
  const up = asks.UP;
  const dn = asks.DOWN;
  if (up == null || dn == null) return;
  const sum = up + dn;
  if (sum < CFG.bookSumMin || sum > CFG.bookSumMax) return;

  // chase o lado mais caro que cruzou algum SUB, com opp hedgeável
  const candidates = [];
  for (const [side, ask] of [
    ['UP', up],
    ['DOWN', dn],
  ]) {
    const opp = side === 'UP' ? dn : up;
    if (opp > CFG.openOppMax + 1e-12) continue;
    for (let i = 0; i < CFG.subLevels.length; i++) {
      const lvl = CFG.subLevels[i];
      if (st.subDone[side].has(i)) continue;
      if (ask + 1e-12 < lvl) continue;
      const limitPx = Math.min(ask, lvl + CFG.openCap);
      if (ask > lvl + CFG.openCap + 1e-12) {
        st.subDone[side].add(i); // miss consome nível
        st.blocks.push({ reason: 'OPEN_MISS_CAP', side, ask, lvl });
        continue;
      }
      candidates.push({ side, ask, lvl, limitPx, idx: i, gap: ask - lvl });
    }
  }
  if (!candidates.length) return;
  // prefer entrada no nível mais baixo ainda cruzado (SUB1)
  candidates.sort((a, b) => a.idx - b.idx || a.gap - b.gap);
  const c = candidates[0];
  const sh = st.shares;
  if (invested(st.inv) + sh * c.limitPx > st.maxNotional + 1e-9) {
    st.blocks.push({ reason: 'TETO_OPEN' });
    return;
  }

  st.openInflight = true;
  try {
    const r = await takerBuy(client, live, tokenOf(event, c.side), c.limitPx, sh, `SUB${c.idx + 1}`);
    console.log(
      `↑ SUB${c.idx + 1} ${c.side} @${c.limitPx} ask=${c.ask} → filled=${r.filledSize} ${r.ms}ms ${r.err || ''}`,
    );
    if (r.filledSize > 0) {
      record(st.inv, c.side, r.price, r.filledSize, `SUB${c.idx + 1}`, { orderId: r.orderId, ms: r.ms });
      st.subDone[c.side].add(c.idx);
      if (!st.sideOpen) {
        st.sideOpen = c.side;
        st.mode = 'opened';
      }
      const hedgeSide = c.side === 'UP' ? 'DOWN' : 'UP';
      await postDescPlan(st, client, live, event, hedgeSide);
    } else {
      // miss → libera nível para retry se ainda no book (não consome permanentemente se erro rede)
      if (r.err) st.blocks.push({ reason: 'OPEN_ERR', err: r.err });
      else st.subDone[c.side].add(c.idx);
    }
  } finally {
    st.openInflight = false;
  }
}

async function tryBalance(st, client, live, event, asks, tau) {
  if (st.mode === 'idle' || st.eqInflight) return;
  const res = residual(st.inv);
  if (!res.side || res.shares + 1e-9 < MIN_SHARES) {
    // residual < min: se quase flat, done
    if (st.mode === 'opened' && (!res.side || res.shares < 0.5)) {
      const as = avgSum(st.inv);
      if (as != null && st.inv.UP.shares >= MIN_SHARES && st.inv.DOWN.shares >= MIN_SHARES) {
        st.mode = 'done';
        st.events.push({ type: 'balanced', avgSum: as });
      }
    }
    return;
  }

  const ask = asks[res.side];
  if (ask == null) return;
  const escape = tau != null && tau <= CFG.escapeTau;
  const askMax = escape ? CFG.escapeAskMax : CFG.eqAskMax;
  const avgMax = escape ? CFG.escapeAvgSumMax : CFG.avgSumMax;
  if (ask > askMax + 1e-12) return;

  // DESC ainda resting pode cobrir — se ask já ≤ algum nível, espera um pouco salvo escape
  if (!escape) {
    const pendingDesc = st.descRests.some((r) => r.filled + 1e-9 < r.targetSh && ask <= r.askMax + 1e-12);
    if (pendingDesc && tau != null && tau > CFG.escapeTau + 5) return;
  }

  let sh = Math.max(MIN_SHARES, Math.ceil(res.shares * 100) / 100);
  // se residual entre 0.5 e 5, ainda tenta 5 (pode over-hedge levemente — melhor que residual)
  if (res.shares < MIN_SHARES) sh = MIN_SHARES;

  const oAvg = avg(st.inv, res.side === 'UP' ? 'DOWN' : 'UP');
  if (oAvg == null) return;
  const proj = oAvg + ask; // approx
  if (proj > avgMax + 1e-12) {
    st.blocks.push({ reason: escape ? 'ESCAPE_REFUSE' : 'EQ_REFUSE', proj, ask, tau });
    return;
  }
  if (invested(st.inv) + sh * ask > st.maxNotional + 1e-9) {
    // tenta size menor se já temos parcialmente
    const room = st.maxNotional - invested(st.inv);
    sh = Math.floor((room / ask) * 100) / 100;
    if (sh + 1e-9 < MIN_SHARES) {
      st.blocks.push({ reason: 'TETO_EQ' });
      return;
    }
  }

  st.eqInflight = true;
  try {
    const kind = escape ? 'ESCAPE' : 'EQUALIZA';
    const r = await takerBuy(client, live, tokenOf(event, res.side), ask, sh, kind);
    console.log(`⇄ ${kind} ${res.side} @${ask} sh=${sh} → ${r.filledSize} ${r.ms}ms`);
    if (r.filledSize > 0) {
      record(st.inv, res.side, r.price, r.filledSize, kind, { orderId: r.orderId, ms: r.ms });
      const left = residual(st.inv);
      if (!left.side || left.shares < 0.5) {
        st.mode = 'done';
        // cancela DESC sobrando
        await cancelAll(client, live, 'balanced');
        st.descRests = [];
      }
    }
  } finally {
    st.eqInflight = false;
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

  const st = createLiveState(opts);
  let prevAsks = { UP: null, DOWN: null };
  let loops = 0;
  let lastHb = 0;
  let lastStale = 0;

  console.log(
    `event=${event.slug} tau≈${tau0}s live=${opts.live} sh=${opts.shares} notional≤$${opts.maxNotional} pollMs=${opts.pollMs}`,
  );

  const decide = async () => {
    const tau = Math.floor((endMs - Date.now()) / 1000);
    if (tau <= 0 || st.mode === 'done') return;
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

    await pollDescFills(st, client, opts.live);
    if (!opts.live) dryCrossDesc(st, asks, prevAsks);

    if (st.mode === 'idle') await tryOpen(st, client, opts.live, event, asks, tau);
    if (st.mode === 'opened' && !st.openInflight) {
      await tryOpen(st, client, opts.live, event, asks, tau);
    }
    await tryBalance(st, client, opts.live, event, asks, tau);

    if (now - lastHb >= 3000) {
      lastHb = now;
      const as = avgSum(st.inv);
      const res = residual(st.inv);
      console.log(
        `… hb tau=${tau} mode=${st.mode} inv=$${invested(st.inv).toFixed(2)} ` +
          `UP=${st.inv.UP.shares} DN=${st.inv.DOWN.shares} avg=${as != null ? as.toFixed(3) : '-'} ` +
          `res=${res.side || '-'}@${res.shares} desc=${st.descRests.filter((r) => r.filled < r.targetSh).length} loops=${loops}`,
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

  // flatten final: cancel rests + última tentativa EQ
  await cancelAll(client, opts.live, 'event-end');
  const asks = { UP: state.up.bestAsk, DOWN: state.down.bestAsk };
  const tau = Math.floor((endMs - Date.now()) / 1000);
  await tryBalance(st, client, opts.live, event, asks, Math.min(tau, CFG.escapeTau));

  const upAsk = state.up.bestAsk;
  const dnAsk = state.down.bestAsk;
  const winner = upAsk != null && dnAsk != null ? (upAsk >= dnAsk ? 'UP' : 'DOWN') : null;
  const cost = invested(st.inv) + st.inv.UP.fees + st.inv.DOWN.fees;
  const pnl =
    winner != null ? Math.round((st.inv[winner].shares - cost) * 100) / 100 : null;

  kickRef.current = null;

  return {
    skipped: false,
    generatedAt: nowIso(),
    live: opts.live,
    dry: !opts.live,
    event: { slug: event.slug, upTokenId: event.upTokenId, downTokenId: event.downTokenId },
    mode: st.mode,
    avgSum: avgSum(st.inv),
    residual: residual(st.inv),
    invested: Math.round(invested(st.inv) * 100) / 100,
    fees: Math.round((st.inv.UP.fees + st.inv.DOWN.fees) * 1000) / 1000,
    inv: { UP: { ...st.inv.UP }, DOWN: { ...st.inv.DOWN } },
    fills: st.inv.fills,
    events: st.events.slice(-80),
    blocksTail: st.blocks.slice(-40),
    winner,
    pnl,
    loops,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Shotandgo micro (WS max speed) ===');
  console.log(
    `mode=${opts.live ? 'LIVE $$' : 'DRY'} shares=${opts.shares} notional≤$${opts.maxNotional} ` +
      `pollMs=${opts.pollMs} settleMs=${CFG.settleMs} SUB=${CFG.subLevels.join('/')} DESC=${CFG.descPlan.map((d) => d.askMax).join('/')}`,
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
    onStaleReconnect: ({ reason, lagMs }) => {
      console.log(`⚠ WS force-reconnect ${reason} lag=${Math.round(lagMs)}ms`);
    },
  });

  const onSig = async (sig) => {
    console.log(`\n⚠ ${sig} — cancelAll`);
    await cancelAll(client, opts.live, sig);
    clobFeed.stop?.();
    process.exit(130);
  };
  process.on('SIGINT', () => void onSig('SIGINT'));
  process.on('SIGTERM', () => void onSig('SIGTERM'));

  const outDir = path.resolve('runs/shotandgo-micro');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];

  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runEvent({ opts, state, clobFeed, client, wake, kickRef });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip ${rep.reason}`);
        continue;
      }
      console.log(
        `[result] mode=${rep.mode} avg=${rep.avgSum} inv=$${rep.invested} ` +
          `res=${rep.residual?.side || '-'}@${rep.residual?.shares} pnl≈${rep.pnl} fills=${rep.fills?.length}`,
      );
      const fname = `sg_micro_${opts.live ? 'live' : 'dry'}_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);
    }
  } finally {
    await cancelAll(client, opts.live, 'shutdown');
    clobFeed.stop?.();
  }

  const sumPath = path.join(outDir, `summary_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify({ generatedAt: nowIso(), live: opts.live, reports }, null, 2));
  console.log(`summary → ${sumPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
