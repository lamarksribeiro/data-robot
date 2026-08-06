#!/usr/bin/env node
/**
 * Binance-lead scalp — LIVE (ordens reais CLOB).
 *
 * Default e-golden V2: adapt + sharesCap@0.50 + impulseCap 20 + rescueStop 0.25 + pre-dump.
 * Exige --live.
 *
 *   node scripts/binance-lead-scalp/scalp-live.js --live --variant=e-golden --max-events=6 --budget=10
 *
 * Segurança: requireLiveFlag · cancelAll preflight/SIGINT · max-session-notional ·
 * min 5 shares · consolida ladder se half < 5 · gap disaster dump sem rescue maker.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { OrderType, Side, AssetType } from '@polymarket/clob-client-v2';
import { requireLiveFlag } from '../../src/cli/liveGate.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
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
  applyExternalMakerFill,
  managePosition,
  closeOpenPosition,
  feeEst,
  summarize,
} from './scalp-engine.js';

const MIN_SHARES = 5;

/** Estado vivo para SIGTERM: flatten inventário, não só cancelAll. */
const liveRisk = {
  client: null,
  opts: null,
  event: null,
  st: null,
  state: null,
  posting: false,
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
  return Math.round(Number(s) * 100) / 100;
}
function roundFee(x) {
  return Math.round(x * 1000) / 1000;
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
  requireLiveFlag('scalp-e:live', {
    argv,
    hint: 'npm run scalp-e:live -- --live --variant=e-golden --max-events=6 --budget=10',
  });
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
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
  // LIVE default: stop-desastre 0.25 (lab ds25 / e-golden V2).
  // Sem isso um crash até settlement leva 100% do notional (aconteceu: −$10).
  const rescueStop = Number(valueOf('--rescue-stop') ?? base.rescueStop ?? 0.25);
  const minTau = Number(valueOf('--min-tau') ?? base.minTau);
  const maxTau = Number(valueOf('--max-tau') ?? base.maxTau);
  const askSizeMult = Number(valueOf('--ask-size-mult') ?? base.askSizeMult ?? 0.75);
  const liqCapMult = Number(valueOf('--liq-cap-mult') ?? base.liqCapMult ?? 0.9);
  const sizingRaw = valueOf('--sizing') ?? base.sizingMode ?? 'none';
  const sizingMode = SIZING_MODES.includes(sizingRaw) ? sizingRaw : base.sizingMode ?? 'none';
  const sharesCapAsk = Number(valueOf('--shares-cap-ask') ?? base.sharesCapAsk ?? 0.5);
  const immediateDisasterDump = args.includes('--no-immediate-disaster-dump')
    ? false
    : args.includes('--immediate-disaster-dump')
      ? true
      : base.immediateDisasterDump !== false;
  const noRescueAboveAsk = Number(valueOf('--no-rescue-above-ask') ?? base.noRescueAboveAsk ?? 0);
  const maxEntrySlip = Number(valueOf('--max-entry-slip') ?? base.maxEntrySlip ?? 0);
  const entryRetries = Math.max(0, parseInt(valueOf('--entry-retries') ?? '0', 10) || 0);
  const entryRetryMs = Math.max(0, parseInt(valueOf('--entry-retry-ms') ?? '150', 10) || 0);
  const budget = Math.max(1, parseFloat(valueOf('--budget') ?? String(base.budget)) || 10);
  return {
    live: true,
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
      rescueStop: Number.isFinite(rescueStop) ? rescueStop : base.rescueStop ?? 0.25,
      minTau: Number.isFinite(minTau) && minTau >= 0 ? minTau : base.minTau,
      maxTau: Number.isFinite(maxTau) && maxTau > 0 ? maxTau : base.maxTau,
      askSizeMult: Number.isFinite(askSizeMult) && askSizeMult > 0 ? askSizeMult : 0.75,
      liqCapMult: Number.isFinite(liqCapMult) && liqCapMult > 0 ? liqCapMult : 0.9,
      sizingMode,
      sharesCapAsk:
        Number.isFinite(sharesCapAsk) && sharesCapAsk > 0 ? sharesCapAsk : base.sharesCapAsk ?? 0.5,
      immediateDisasterDump,
      noRescueAboveAsk:
        Number.isFinite(noRescueAboveAsk) && noRescueAboveAsk > 0 ? noRescueAboveAsk : 0,
      maxEntrySlip: Number.isFinite(maxEntrySlip) && maxEntrySlip > 0 ? maxEntrySlip : 0,
      budget,
    },
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? '6', 10) || 6),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    maxBookAgeMs: Math.max(500, parseInt(valueOf('--max-book-age-ms') ?? '2500', 10) || 2500),
    timeoutSec: Math.max(60, parseInt(valueOf('--timeout') ?? '320', 10) || 320),
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '60', 10) || 0),
    waitTimeoutSec: Math.max(
      30,
      parseInt(valueOf('--wait-timeout') ?? String(Math.max(600, 12 * 400)), 10) || 600,
    ),
    budget,
    maxSessionNotional: Math.max(
      budget,
      parseFloat(valueOf('--max-session-notional') ?? String(budget * 8)) || budget * 8,
    ),
    maxSessionLoss: Math.max(
      1,
      parseFloat(valueOf('--max-session-loss') ?? '25') || 25,
    ),
    settleMs: Math.max(200, parseInt(valueOf('--settle-ms') ?? '700', 10) || 700),
    settlePollMs: Math.max(30, parseInt(valueOf('--settle-poll-ms') ?? '50', 10) || 50),
    entrySlip: Math.max(0, parseFloat(valueOf('--entry-slip') ?? '0.01') || 0),
    entryRetries,
    entryRetryMs,
    warmSec: Math.max(3, parseInt(valueOf('--warm-sec') ?? '8', 10) || 8),
  };
}

async function cancelAll(client, label = 'cancelAll') {
  if (!client?.cancelAll) return;
  try {
    const resp = await client.cancelAll();
    console.log(`🛡 ${label}`, resp?.canceled?.length ?? '');
  } catch (err) {
    console.log(`⚠ ${label}: ${err.message}`);
  }
}

async function cancelOrderSafe(client, orderId) {
  if (!orderId) return;
  try {
    await client.cancelOrder({ orderID: orderId });
  } catch {
    /* already gone */
  }
}

async function waitMatched(client, orderId, { settleMs, settlePollMs }) {
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
    if (matched + 1e-9 >= original && original > 0) {
      return { filled: true, partial: false, matched, original, order: last, terminal: true };
    }
    if (matched > 0 && ['matched', 'filled'].some((s) => status.includes(s))) {
      return {
        filled: true,
        partial: matched + 1e-9 < original,
        matched,
        original,
        order: last,
        terminal: true,
      };
    }
    if (['canceled', 'cancelled', 'expired'].includes(status)) {
      return { filled: matched > 0, partial: matched > 0, matched, original, order: last, terminal: true };
    }
    await sleep(settlePollMs);
  }
  const matched = Number(last?.size_matched ?? 0) || 0;
  const original = Number(last?.original_size ?? 0) || 0;
  return {
    filled: matched > 0,
    partial: matched > 0 && matched + 1e-9 < original,
    matched,
    original,
    order: last,
    terminal: false,
  };
}

async function postOrder(client, { tokenId, price, size, side, orderType, label }) {
  const t0 = performance.now();
  const px = roundPx(price);
  const sh = roundSh(size);
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: px, side, size: sh },
      undefined,
      orderType,
      false,
      false,
    );
    const orderId = resp?.orderID ?? null;
    if (!resp?.success || !orderId) {
      return {
        ok: false,
        orderId: null,
        price: px,
        size: sh,
        ms: Math.round(performance.now() - t0),
        label,
        err: resp?.errorMsg || resp?.status || 'post_failed',
        raw: resp,
      };
    }
    return {
      ok: true,
      orderId,
      price: px,
      size: sh,
      ms: Math.round(performance.now() - t0),
      label,
      takingAmount: Number(resp?.takingAmount ?? 0) || 0,
      raw: resp,
    };
  } catch (err) {
    return {
      ok: false,
      orderId: null,
      price: px,
      size: sh,
      ms: Math.round(performance.now() - t0),
      label,
      err: err.message,
    };
  }
}

/** BUY taker marketable: GTC no ask(+slip), settle curto, cancela residual. */
async function takerBuy(client, tokenId, ask, shares, opts) {
  const limit = roundPx(ask + opts.entrySlip);
  const sh = roundSh(shares);
  const posted = await postOrder(client, {
    tokenId,
    price: limit,
    size: sh,
    side: Side.BUY,
    orderType: OrderType.GTC,
    label: 'entry-buy',
  });
  if (!posted.ok) return { ...posted, filledSize: 0, avgPx: null };

  let matched = posted.takingAmount > 0 ? posted.takingAmount : 0;
  let settle = await waitMatched(client, posted.orderId, {
    settleMs: opts.settleMs,
    settlePollMs: opts.settlePollMs,
  });
  matched = Math.max(matched, settle.matched || 0);

  if (matched + 1e-9 < sh) {
    await cancelOrderSafe(client, posted.orderId);
    settle = await waitMatched(client, posted.orderId, {
      settleMs: 400,
      settlePollMs: 80,
    });
    matched = Math.max(matched, settle.matched || 0);
  }

  let avgPx = null;
  if (matched > 0) {
    try {
      const o = settle?.order || (await client.getOrder(posted.orderId));
      avgPx = await resolveFillPx(client, o, ask);
    } catch {
      avgPx = ask;
    }
  }
  return {
    ok: matched + 1e-9 >= MIN_SHARES,
    orderId: posted.orderId,
    filledSize: matched,
    avgPx,
    price: limit,
    size: sh,
    ms: posted.ms,
    err: matched + 1e-9 < MIN_SHARES ? 'underfill' : null,
  };
}

/** SELL resting GTC (ladder / rescue). */
async function restSell(client, tokenId, price, size, label) {
  if (size + 1e-9 < MIN_SHARES) {
    return { ok: false, orderId: null, price, size, err: 'below_min_shares', label };
  }
  return postOrder(client, {
    tokenId,
    price,
    size,
    side: Side.SELL,
    orderType: OrderType.GTC,
    label,
  });
}

/** Dump agressivo: FAK abaixo do bid, retries, loga falha crítica. */
async function forceDump(client, tokenId, bid, shares, opts, label) {
  const sh = roundSh(shares);
  if (sh <= 0) return { ok: true, filledSize: 0 };
  let left = sh;
  let filled = 0;
  let lastPx = Number.isFinite(bid) && bid > 0 ? bid : 0.01;
  for (let attempt = 1; attempt <= 6 && left + 1e-9 >= 0.01; attempt++) {
    const dump = await takerSell(client, tokenId, lastPx, left, opts, `${label}-a${attempt}`);
    if (dump.filledSize > 0) {
      filled += dump.filledSize;
      left = roundSh(Math.max(0, left - dump.filledSize));
      if (dump.avgPx > 0) lastPx = dump.avgPx;
    }
    if (left + 1e-9 < 0.01) break;
    // book pode ter andado — tenta mais baixo
    lastPx = Math.max(0.01, roundPx((Number.isFinite(lastPx) ? lastPx : 0.05) * 0.5));
    await sleep(150 * attempt);
  }
  if (left + 1e-9 >= MIN_SHARES) {
    console.log(
      `⛔ CRITICAL dump incomplete label=${label} filled=${filled.toFixed(2)} left=${left.toFixed(2)} — inventário NU`,
    );
    return { ok: false, filledSize: filled, left };
  }
  if (left > 1e-9) {
    console.log(`⚠ dump dust left=${left.toFixed(4)} label=${label}`);
  }
  return { ok: true, filledSize: filled, left };
}

/** Dump residual no bid (FAK preferido, fallback GTC settle+cancel). */
async function takerSell(client, tokenId, bid, shares, opts, label = 'dump-sell') {
  // Limite 5¢ abaixo do bid: garante fill se o book andar (taker executa no preço do book, não no limit).
  const bidRef = Number.isFinite(bid) && bid > 0 ? bid : 0.01;
  const px = roundPx(Math.max(0.01, bidRef - 0.05));
  const sh = roundSh(shares);
  if (sh + 1e-9 < MIN_SHARES) {
    // residual < min: tenta mesmo assim (algumas contas aceitam) senão abandona tracking
    if (sh <= 0) return { ok: true, filledSize: 0, avgPx: px, skipped: true };
  }
  let posted = await postOrder(client, {
    tokenId,
    price: px,
    size: Math.max(sh, MIN_SHARES > sh ? sh : sh),
    side: Side.SELL,
    orderType: OrderType.FAK,
    label,
  });
  if (!posted.ok) {
    posted = await postOrder(client, {
      tokenId,
      price: px,
      size: sh,
      side: Side.SELL,
      orderType: OrderType.GTC,
      label: `${label}-gtc`,
    });
  }
  if (!posted.ok) return { ...posted, filledSize: 0, avgPx: null };

  let matched = posted.takingAmount > 0 ? posted.takingAmount : 0;
  const settle = await waitMatched(client, posted.orderId, {
    settleMs: Math.min(opts.settleMs, 600),
    settlePollMs: opts.settlePollMs,
  });
  matched = Math.max(matched, settle.matched || 0);
  if (String(posted.raw?.orderType || '').includes('GTC') || posted.label?.includes('gtc')) {
    await cancelOrderSafe(client, posted.orderId);
  }
  // Preço real do fill (não o limit agressivo) para o PnL bater com o CLOB
  let avgPx = bidRef;
  if (matched > 0) {
    try {
      const o = settle?.order || (await client.getOrder(posted.orderId));
      avgPx = await resolveFillPx(client, o, bidRef);
    } catch {
      avgPx = bidRef;
    }
  }
  return {
    ok: matched > 0,
    orderId: posted.orderId,
    filledSize: matched,
    avgPx,
    ms: posted.ms,
    err: matched <= 0 ? 'no_fill' : null,
  };
}

async function cancelPosOrders(client, pos) {
  if (!pos?.ladder) return;
  for (const lvl of pos.ladder) {
    if (lvl.orderId && !lvl.filled) await cancelOrderSafe(client, lvl.orderId);
    lvl.orderId = null;
  }
}

function isBalanceErr(err) {
  const s = String(err || '').toLowerCase();
  return (
    s.includes('not enough balance') ||
    s.includes('insufficient') ||
    s.includes('balance') ||
    s.includes('allowance')
  );
}

/** Preço médio real via associate_trades; fallback = limit. Cache curto por ordem. */
const _fillPxCache = new Map();
async function resolveFillPx(client, order, fallbackPx) {
  const orderId = order?.id || order?.orderID || order?.order_id;
  const matched = Number(order?.size_matched ?? 0) || 0;
  if (!(matched > 0)) return fallbackPx;
  const cacheKey = `${orderId}:${matched}`;
  if (_fillPxCache.has(cacheKey)) return _fillPxCache.get(cacheKey);

  const tradeIds = order?.associate_trades;
  if (Array.isArray(tradeIds) && tradeIds.length && client?.getTrades) {
    try {
      const raw = await client.getTrades({ limit: 40 });
      const list = Array.isArray(raw) ? raw : raw?.data || [];
      let sum = 0;
      let qty = 0;
      for (const tid of tradeIds) {
        const t = list.find((x) => (x.id || x.trade_id) === tid);
        if (!t) continue;
        const p = Number(t.price);
        const s = Number(t.size);
        if (p > 0 && s > 0) {
          sum += p * s;
          qty += s;
        }
      }
      if (qty > 0) {
        const avg = sum / qty;
        _fillPxCache.set(cacheKey, avg);
        return avg;
      }
    } catch {
      /* fallback */
    }
  }
  _fillPxCache.set(cacheKey, fallbackPx);
  return fallbackPx;
}

async function syncLadderFromClob(client, st) {
  const pos = st.pos;
  if (!pos) return null;
  for (const lvl of pos.ladder) {
    if (lvl.filled || !lvl.orderId) continue;
    let o;
    try {
      o = await client.getOrder(lvl.orderId);
    } catch {
      continue;
    }
    const matched = Number(o?.size_matched ?? 0) || 0;
    const prev = lvl.matched || 0;
    if (matched > prev + 1e-9) {
      const fillPx = await resolveFillPx(client, o, lvl.limitPx);
      applyExternalMakerFill(st, fillPx, matched - prev, { limitPx: lvl.limitPx });
      lvl.matched = matched;
      if (Math.abs(fillPx - lvl.limitPx) > 1e-9) {
        console.log(
          `  fill px real=${fillPx} limit=${lvl.limitPx} Δsh=${(matched - prev).toFixed(2)}`,
        );
      }
    }
    const status = String(o?.status ?? '').toLowerCase();
    // só marca filled com size_matched real (não confiar só no status)
    if (matched + 1e-9 >= lvl.shares * 0.99) {
      lvl.filled = true;
    } else if (['canceled', 'cancelled', 'expired'].includes(status)) {
      lvl.orderId = null;
    }
  }
  if (pos.remaining <= 1e-9) {
    return closeOpenPosition(st, 0, 0, pos.rescue ? 'rescue_full' : 'ladder_full', Date.now());
  }
  return null;
}

/**
 * Posta ladder maker. Retry curto só em erro de balance (lag pós-BUY).
 * Se falhar tudo: consolida 1 ask no 1º nível da ladder (mantém edge maker).
 * Nunca deixa posição nua se ainda houver saldo.
 */
async function postLadderSells(client, tokenId, pos, opts = {}) {
  // Balance CTF pós-BUY demora até ~2s para liberar (visto ao vivo): 8×250ms cobre.
  const retries = opts.retries ?? 8;
  const gapMs = opts.gapMs ?? 250;
  const ids = [];

  for (let i = 0; i < pos.ladder.length; i++) {
    const lvl = pos.ladder[i];
    if (lvl.filled || lvl.orderId || lvl.shares + 1e-9 < MIN_SHARES) continue;

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const r = await restSell(client, tokenId, lvl.limitPx, lvl.shares, `ladder-${i}`);
      if (r.ok) {
        lvl.orderId = r.orderId;
        lvl.matched = 0;
        ids.push(r.orderId);
        console.log(
          `  ladder rest SELL @${lvl.limitPx} sh=${lvl.shares} id=${r.orderId}` +
            (attempt > 1 ? ` (try ${attempt})` : ''),
        );
        lastErr = null;
        break;
      }
      lastErr = r.err;
      if (!isBalanceErr(r.err) || attempt === retries) {
        console.log(`⚠ ladder post fail ${lvl.limitPx}: ${r.err}`);
        break;
      }
      await sleep(gapMs);
    }
    if (lastErr) {
      /* leave without orderId — fallback abaixo */
    }
  }

  const uncovered = pos.ladder.filter(
    (l) => !l.filled && !l.orderId && l.shares + 1e-9 >= MIN_SHARES,
  );
  if (!uncovered.length) return ids;

  // Só o que ainda NÃO está em ordem resting (não re-vender o que já postou)
  const lockedSh = pos.ladder
    .filter((l) => l.orderId && !l.filled)
    .reduce((a, l) => a + Math.max(0, l.shares - (l.matched || 0)), 0);
  const uncoveredSh = uncovered.reduce((a, l) => a + l.shares, 0);
  const rem = roundSh(Math.min(pos.remaining - lockedSh, uncoveredSh));
  if (rem + 1e-9 < MIN_SHARES) {
    console.log(
      `⚠ ladder parcial ok — locked=${lockedSh.toFixed(2)} uncovered<min (${rem}); sem fallback`,
    );
    return ids;
  }
  const fallbackPx =
    uncovered[0]?.limitPx ??
    pos.ladder.find((l) => Number.isFinite(l.limitPx))?.limitPx ??
    roundPx(pos.entryAsk + (pos.ladder[0]?.offset || 0.08));

  console.log(
    `⚠ ladder incomplete — fallback maker SELL @${fallbackPx} sh=${rem}` +
      ` (locked=${lockedSh.toFixed(2)}; não ficar nu)`,
  );
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = await restSell(client, tokenId, fallbackPx, rem, 'ladder-fallback');
    if (r.ok) {
      const kept = pos.ladder.filter((l) => l.orderId || (l.filled && (l.matched || 0) > 0));
      pos.ladder = [
        ...kept,
        {
          offset: round4(fallbackPx - pos.entryAsk),
          limitPx: fallbackPx,
          shares: rem,
          filled: false,
          matched: 0,
          orderId: r.orderId,
        },
      ];
      ids.push(r.orderId);
      console.log(`  fallback rest SELL @${fallbackPx} sh=${rem} id=${r.orderId}`);
      return ids;
    }
    if (!isBalanceErr(r.err) || attempt === retries) {
      console.log(`⚠ fallback maker fail: ${r.err}`);
      break;
    }
    await sleep(gapMs);
  }
  return ids;
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
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
  return { UP: state.up, DOWN: state.down };
}

function pushMids(midRing, state, now) {
  for (const side of ['UP', 'DOWN']) {
    const b = state[side === 'UP' ? 'up' : 'down'];
    if (Number.isFinite(b?.bestAsk) && Number.isFinite(b?.bestBid)) {
      pushMid(midRing, now, side, (b.bestAsk + b.bestBid) / 2);
    }
  }
}

function tokenFor(event, side) {
  return side === 'UP' ? event.upTokenId : event.downTokenId;
}

async function runOneEvent({ opts, feedCtx, spotRing, midRing, client, session }) {
  const event = await findActiveBtc5mEvent();
  if (!event?.upTokenId || !event?.downTokenId) throw new Error('no active BTC 5m event');

  liveRisk.client = client;
  liveRisk.opts = opts;
  liveRisk.event = event;
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
  liveRisk.st = st;
  liveRisk.state = state;

  const decisionLatency = [];
  const eventDeadline = Date.now() + Math.min(opts.timeoutSec, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let loops = 0;
  let staleBlocks = 0;
  let lastStaleRefresh = 0;
  let lastSync = 0;
  let posting = false;
  const P = opts.params;
  const thrDesc =
    P.impulseVolMult > 0
      ? `impulse=adapt(${P.impulseVolMult}σ∈$${P.impulseFloor}–$${P.impulseCap}, win=${P.volWindowSec}s, fb=$${P.impulseUsd})`
      : `impulse≥$${P.impulseUsd}/${P.leadSec}s`;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s live=1 budget=$${opts.budget}` +
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

    if (state.binance != null) pushSpot(spotRing, now, state.binance);
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

    // 1) posição aberta: sync CLOB + stop/timeout/rescue
    if (st.pos && !posting) {
      // Throttle: getOrder por nível a cada 400ms (evita rate-limit no poll de 50ms)
      let filledClose = null;
      if (now - lastSync >= 400) {
        lastSync = now;
        filledClose = await syncLadderFromClob(client, st);
      }
      if (filledClose) {
        console.log(
          `EXIT ${filledClose.reason} ${filledClose.side} entry=${filledClose.entryAsk} exit≈${filledClose.exitPx}` +
            ` pnl=${filledClose.pnl} hold=${filledClose.holdSec}s makerSh=${filledClose.makerExitShares}` +
            ` takerSh=${filledClose.takerExitShares} fees=${roundFee(filledClose.entryFee + filledClose.exitFee)}`,
        );
        session.realizedPnl += filledClose.pnl;
        await sleep(opts.pollMs);
        continue;
      }
      if (!st.pos) {
        await sleep(opts.pollMs);
        continue;
      }

      // Cancel resting ANTES de dump (managePosition fecha contábil e zera pos)
      const posPeek = st.pos;
      const sideKeyPeek = posPeek.side === 'UP' ? 'up' : 'down';
      const bidPeek = Number(state[sideKeyPeek]?.bestBid);
      const holdPeek = (now - posPeek.entryTsMs) / 1000;
      const pastDisaster =
        P.rescueStop > 0 &&
        Number.isFinite(bidPeek) &&
        bidPeek > 0 &&
        bidPeek <= posPeek.entryAsk - P.rescueStop;
      const hitStop =
        !posPeek.rescue &&
        Number.isFinite(bidPeek) &&
        bidPeek > 0 &&
        bidPeek <= posPeek.entryAsk - P.stopLoss;
      const hitTimeout = !posPeek.rescue && holdPeek >= P.timeoutSec;
      const noRescueHigh =
        Number.isFinite(P.noRescueAboveAsk) &&
        P.noRescueAboveAsk > 0 &&
        posPeek.entryAsk >= P.noRescueAboveAsk;
      // Em rescue OU gap (ainda na ladder) com bid ≤ entry−rescueStop → dump.
      const hitRescueStop =
        pastDisaster &&
        (posPeek.rescue || (P.immediateDisasterDump !== false && !posPeek.rescue));
      const willDump =
        hitRescueStop ||
        ((hitStop || hitTimeout) && !P.rescue) ||
        (hitStop && noRescueHigh);
      // Nunca postar rescue maker se o book já está em zona de desastre.
      // Ask caro: soft-stop dumpa; timeout ainda pode resgatar.
      const willRescue =
        !posPeek.rescue &&
        P.rescue &&
        ((hitStop && !noRescueHigh) || hitTimeout) &&
        !pastDisaster;

      // Rescue: cancel resting ENQUANTO orderIds ainda existem (enterRescue descarta níveis)
      if (willRescue) {
        posting = true;
        try {
          const tokenId = tokenFor(event, posPeek.side);
          await cancelPosOrders(client, posPeek);
          await cancelAll(client, 'pre-rescue');
          const closed = managePosition(st, {
            book,
            nowMs: now,
            fillMode: 'honest',
            skipMaker: true,
          });
          if (closed?.action === 'rescue' && st.pos) {
            const lvl = st.pos.ladder.find((l) => !l.filled);
            const sh = roundSh(st.pos.remaining);
            const px = lvl?.limitPx ?? roundPx(st.pos.entryAsk + (P.rescueOffset || 0.01));
            let posted = null;
            if (sh + 1e-9 >= MIN_SHARES) {
              for (let attempt = 1; attempt <= 5; attempt++) {
                const r = await restSell(client, tokenId, px, sh, `rescue-${closed.trigger}`);
                if (r.ok) {
                  posted = r;
                  break;
                }
                if (!isBalanceErr(r.err) || attempt === 5) {
                  console.log(`⚠ RESCUE post fail: ${r.err}`);
                  break;
                }
                await sleep(200);
              }
            }
            if (posted?.ok) {
              if (lvl) {
                lvl.orderId = posted.orderId;
                lvl.shares = sh;
                lvl.matched = 0;
              } else {
                st.pos.ladder = [
                  {
                    offset: P.rescueOffset || 0.01,
                    limitPx: px,
                    shares: sh,
                    filled: false,
                    matched: 0,
                    orderId: posted.orderId,
                  },
                ];
              }
              console.log(
                `RESCUE enter ${closed.side} trigger=${closed.trigger}` +
                  ` entry=${closed.entryAsk} ask=${px}` +
                  ` rem=${sh} sh=${closed.shares} id=${posted.orderId}`,
              );
            } else {
              console.log(
                `RESCUE enter ${closed.side} trigger=${closed.trigger}` +
                  ` entry=${closed.entryAsk} ask=${px}` +
                  ` rem=${sh} sh=${closed.shares} (sem ordem — inventário livre)`,
              );
            }
          }
        } finally {
          posting = false;
        }
        await sleep(opts.pollMs);
        continue;
      }

      if (willDump) {
        posting = true;
        try {
          const tokenId = tokenFor(event, posPeek.side);
          const rem = posPeek.remaining;
          await cancelPosOrders(client, posPeek);
          await cancelAll(client, 'pre-dump');
          let exitPx = Number.isFinite(bidPeek) && bidPeek > 0 ? bidPeek : posPeek.entryAsk;
          let exitFee = 0;
          if (rem > 1e-9) {
            const dump = await takerSell(client, tokenId, exitPx, rem, opts, 'stop-dump');
            if (dump.filledSize > 0) {
              exitPx = dump.avgPx || exitPx;
              exitFee = feeEst(exitPx, dump.filledSize, st.params.feeRate);
            }
          }
          const reason = hitRescueStop
            ? 'rescue_stop'
            : hitStop
              ? 'ladder_stop'
              : posPeek.fills.length
                ? 'ladder_timeout_partial'
                : 'ladder_timeout';
          const closed = closeOpenPosition(st, exitPx, exitFee, reason, now);
          if (closed) {
            console.log(
              `EXIT ${closed.reason} ${closed.side} entry=${closed.entryAsk} exit≈${closed.exitPx}` +
                ` pnl=${closed.pnl} hold=${closed.holdSec}s makerSh=${closed.makerExitShares}` +
                ` takerSh=${closed.takerExitShares} fees=${roundFee(closed.entryFee + closed.exitFee)}`,
            );
            session.realizedPnl += closed.pnl;
          }
        } finally {
          posting = false;
        }
        await sleep(opts.pollMs);
        continue;
      }

      const closed = managePosition(st, {
        book,
        nowMs: now,
        fillMode: 'honest',
        skipMaker: true,
      });

      if (closed && closed.reason) {
        // ladder_full etc.
        console.log(
          `EXIT ${closed.reason} ${closed.side} entry=${closed.entryAsk} exit≈${closed.exitPx}` +
            ` pnl=${closed.pnl} hold=${closed.holdSec}s makerSh=${closed.makerExitShares}` +
            ` takerSh=${closed.takerExitShares} fees=${roundFee(closed.entryFee + closed.exitFee)}`,
        );
        session.realizedPnl += closed.pnl;
      }

      await sleep(opts.pollMs);
      continue;
    }

    // 2) entrada
    if (
      !st.pos &&
      !posting &&
      tau >= opts.params.minTau &&
      tau <= opts.params.maxTau &&
      session.notionalUsed + opts.budget <= opts.maxSessionNotional + 1e-9 &&
      session.realizedPnl > -opts.maxSessionLoss
    ) {
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

        posting = true;
        try {
          const tokenId = tokenFor(event, intent.side);
          const wantSh = roundSh(intent.shares ?? opts.budget / intent.ask);
          if (wantSh + 1e-9 < MIN_SHARES) {
            console.log(`ENTER aborted below_min_shares need=${wantSh}`);
          } else {
            let buy = null;
            const attempts = 1 + (opts.entryRetries || 0);
            for (let attempt = 1; attempt <= attempts; attempt++) {
              const askNow =
                attempt === 1
                  ? intent.ask
                  : Number(state[intent.side === 'UP' ? 'up' : 'down']?.bestAsk) || intent.ask;
              buy = await takerBuy(client, tokenId, askNow, wantSh, opts);
              if (buy.ok && buy.filledSize + 1e-9 >= MIN_SHARES) break;
              if (attempt < attempts) {
                console.log(
                  `ENTER retry ${attempt}/${attempts - 1} underfill filled=${buy.filledSize || 0}`,
                );
                if (buy.filledSize > 1e-9) {
                  const sideKey = intent.side === 'UP' ? 'up' : 'down';
                  const bid = state[sideKey]?.bestBid ?? intent.bid;
                  await forceDump(client, tokenId, bid, buy.filledSize, opts, 'retry-dust');
                }
                if (opts.entryRetryMs > 0) await sleep(opts.entryRetryMs);
              }
            }
            if (!buy?.ok || buy.filledSize + 1e-9 < MIN_SHARES) {
              console.log(
                `ENTER aborted ${buy?.err || 'no_fill'} filled=${buy?.filledSize || 0}`,
              );
              if (buy?.filledSize > 1e-9) {
                const sideKey = intent.side === 'UP' ? 'up' : 'down';
                const bid = state[sideKey]?.bestBid ?? intent.bid;
                await forceDump(client, tokenId, bid, buy.filledSize, opts, 'dust-exit');
              }
            } else {
              const fillAsk = buy.avgPx || intent.ask;
              const res = applyEntryFill(st, intent, {
                fillMode: 'honest',
                fillAsk,
                fillShares: buy.filledSize,
                nowMs: Date.now(),
                // Já compramos: rejeitar ask_slipped e falhar o dump = -$budget (já aconteceu).
                acceptSlippedAsk: true,
              });
              if (!res.ok) {
                console.log(`ENTER aborted ${res.reason} — dumping inventory`);
                const sideKey = intent.side === 'UP' ? 'up' : 'down';
                const bid = state[sideKey]?.bestBid ?? intent.bid;
                await forceDump(client, tokenId, bid, buy.filledSize, opts, 'abort-exit');
              } else {
                session.notionalUsed += fillAsk * buy.filledSize;
                console.log(
                  `ENTER fill ${intent.side} @${res.ask} sh=${res.shares.toFixed(2)}` +
                    ` fee=${res.entryFee.toFixed(3)} binRet=${intent.binRet}` +
                    ` thr=${intent.impulseMin}` +
                    ` ladder=${res.ladder.map((l) => l.limitPx).join(',')}` +
                    (buy.avgPx != null && Math.abs(buy.avgPx - res.ask) > 1e-9
                      ? ` realPx=${buy.avgPx}`
                      : ''),
                );
                await sleep(150);
                const posted = await postLadderSells(client, tokenId, st.pos, {
                  retries: 8,
                  gapMs: 250,
                });
                if (!posted.length) {
                  console.log(
                    '⛔ CRITICAL: sem SELL resting após BUY — tentando ask de emergência entry+offset',
                  );
                  const rescuePx = roundPx(st.pos.entryAsk + (P.rescueOffset || 0.01));
                  let emergencyId = null;
                  for (let attempt = 1; attempt <= 5; attempt++) {
                    const r = await restSell(
                      client,
                      tokenId,
                      rescuePx,
                      st.pos.remaining,
                      'emergency-rescue',
                    );
                    if (r.ok) {
                      emergencyId = r.orderId;
                      break;
                    }
                    if (!isBalanceErr(r.err)) {
                      console.log(`⚠ emergency fail: ${r.err}`);
                      break;
                    }
                    await sleep(250);
                  }
                  if (emergencyId) {
                    st.pos.ladder = [
                      {
                        offset: P.rescueOffset || 0.01,
                        limitPx: rescuePx,
                        shares: st.pos.remaining,
                        filled: false,
                        matched: 0,
                        orderId: emergencyId,
                      },
                    ];
                    st.pos.rescue = true;
                    st.pos.rescueTrigger = 'ladder_post_fail';
                    console.log(
                      `RESCUE enter ${st.pos.side} trigger=ladder_post_fail` +
                        ` entry=${st.pos.entryAsk} ask=${rescuePx}` +
                        ` rem=${st.pos.remaining} sh=${st.pos.shares} id=${emergencyId}`,
                    );
                  } else {
                    console.log(
                      '⛔ CRITICAL: posição nua sem SELL — dump no bid para cortar risco',
                    );
                    const sideKey = intent.side === 'UP' ? 'up' : 'down';
                    const bid = state[sideKey]?.bestBid ?? intent.bid;
                    const dump = await takerSell(
                      client,
                      tokenId,
                      bid,
                      st.pos.remaining,
                      opts,
                      'naked-abort',
                    );
                    const exitPx = dump.avgPx || bid || st.pos.entryAsk;
                    const exitFee = feeEst(
                      exitPx,
                      dump.filledSize || st.pos.remaining,
                      st.params.feeRate,
                    );
                    const closed = closeOpenPosition(
                      st,
                      exitPx,
                      exitFee,
                      'ladder_post_fail_dump',
                      Date.now(),
                    );
                    if (closed) {
                      console.log(
                        `EXIT ${closed.reason} ${closed.side} entry=${closed.entryAsk} exit≈${closed.exitPx}` +
                          ` pnl=${closed.pnl} hold=${closed.holdSec}s makerSh=${closed.makerExitShares}` +
                          ` takerSh=${closed.takerExitShares} fees=${roundFee(closed.entryFee + closed.exitFee)}`,
                      );
                      session.realizedPnl += closed.pnl;
                    }
                  }
                }
              }
            }
          }
        } finally {
          posting = false;
        }
      }
    } else if (
      session.notionalUsed + opts.budget > opts.maxSessionNotional + 1e-9 ||
      session.realizedPnl <= -opts.maxSessionLoss
    ) {
      st.lastNoEntryReason =
        session.realizedPnl <= -opts.maxSessionLoss ? 'SESSION_LOSS_CAP' : 'SESSION_NOTIONAL_CAP';
    }

    await sleep(opts.pollMs);
  }

  // EOD: cancel resting + dump residual
  if (st.pos) {
    const pos = st.pos;
    const tokenId = tokenFor(event, pos.side);
    await cancelPosOrders(client, pos);
    const rem = pos.remaining;
    const sideKey = pos.side === 'UP' ? 'up' : 'down';
    const bid = state[sideKey]?.bestBid;
    let exitPx = Number.isFinite(bid) && bid > 0 ? bid : pos.entryAsk;
    let exitFee = 0;
    if (rem > 1e-9) {
      const dump = await takerSell(client, tokenId, exitPx, rem, opts, 'eod-dump');
      if (dump.filledSize > 0) {
        exitPx = dump.avgPx || exitPx;
        exitFee = feeEst(exitPx, dump.filledSize, st.params.feeRate);
        // remaining may exceed filled — still close accounting at bid for residual risk
      }
    }
    const reason = pos.rescue
      ? 'rescue_eod'
      : pos.fills.length
        ? 'ladder_eod_partial'
        : 'ladder_eod';
    const closed = closeOpenPosition(st, exitPx, exitFee, reason, Date.now());
    if (closed) {
      console.log(
        `EXIT ${closed.reason} ${closed.side} entry=${closed.entryAsk} exit≈${closed.exitPx}` +
          ` pnl=${closed.pnl} hold=${closed.holdSec}s makerSh=${closed.makerExitShares}` +
          ` takerSh=${closed.takerExitShares} fees=${roundFee(closed.entryFee + closed.exitFee)}`,
      );
      session.realizedPnl += closed.pnl;
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
    dry: false,
    live: true,
    strategy: 'binance-lead-scalp',
    variant: opts.params.id,
    setup: opts.variantName,
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
    session: { ...session },
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('=== Binance-lead scalp LIVE (ordens reais) ===');
  console.log(
    `variant=${opts.variantName} maxEvents=${opts.maxEvents} budget=$${opts.budget}` +
      ` sessionNotional≤$${opts.maxSessionNotional} sessionLoss≤$${opts.maxSessionLoss}` +
      ` pollMs=${opts.pollMs}`,
  );
  const P = opts.params;
  const thrDesc =
    P.impulseVolMult > 0
      ? `impulse=adapt(${P.impulseVolMult}σ ∈$${P.impulseFloor}–$${P.impulseCap} win=${P.volWindowSec}s fb=$${P.impulseUsd})`
      : `impulse≥$${P.impulseUsd}/${P.leadSec}s`;
  const rescueDesc = P.rescue
    ? ` rescue=+${P.rescueOffset}${P.rescueStop > 0 ? `/ds-${P.rescueStop}` : '/hold'}${
        P.noRescueAboveAsk > 0 ? `/nra${P.noRescueAboveAsk}` : ''
      }`
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
      `${P.maxEntrySlip > 0 ? ` slip≤${P.maxEntrySlip}` : ''}` +
      ` maxTrades=${P.maxTradesPerEvent} τ=${P.minTau}–${P.maxTau}`,
  );
  console.log('fill=live');

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

  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });
  console.log(`signer=${wallet.address}`);
  await cancelAll(client, 'preflight');

  const session = { notionalUsed: 0, realizedPnl: 0 };

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

  const onSig = async (sig) => {
    console.log(`\n⚠ ${sig} — cancelAll + flatten + exit`);
    const c = liveRisk.client || client;
    const o = liveRisk.opts || opts;
    const ev = liveRisk.event;
    const stNow = liveRisk.st;
    const stateNow = liveRisk.state;
    try {
      await cancelAll(c, sig);
    } catch {
      /* ignore */
    }
    try {
      // 1) posição conhecida
      if (stNow?.pos?.remaining > 1e-9 && ev) {
        const tokenId = tokenFor(ev, stNow.pos.side);
        const sideKey = stNow.pos.side === 'UP' ? 'up' : 'down';
        const bid = Number(stateNow?.[sideKey]?.bestBid) || 0.01;
        console.log(
          `🛡 ${sig} flatten tracked ${stNow.pos.side} rem=${stNow.pos.remaining} bid=${bid}`,
        );
        await forceDump(c, tokenId, bid, stNow.pos.remaining, o, `sig-${sig}`);
      }
      // 2) inventário órfão no evento atual (ex.: fill no meio do ENTER)
      if (ev?.upTokenId && ev?.downTokenId) {
        for (const [side, tid] of [
          ['UP', ev.upTokenId],
          ['DOWN', ev.downTokenId],
        ]) {
          try {
            const bal = await c.getBalanceAllowance({
              asset_type: AssetType.CONDITIONAL,
              token_id: tid,
            });
            const shares = Number(bal?.balance || 0) / 1e6;
            if (shares + 1e-9 >= 0.5) {
              const sideKey = side === 'UP' ? 'up' : 'down';
              const bid = Number(stateNow?.[sideKey]?.bestBid) || 0.01;
              console.log(`🛡 ${sig} orphan ${side} bal=${shares.toFixed(2)} bid=${bid}`);
              await forceDump(c, tid, bid, shares, o, `sig-orphan-${side}`);
            }
          } catch (err) {
            console.log(`⚠ ${sig} bal ${side}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.log(`⚠ ${sig} flatten: ${err.message}`);
    }
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
    process.exit(130);
  };
  process.on('SIGINT', () => void onSig('SIGINT'));
  process.on('SIGTERM', () => void onSig('SIGTERM'));

  const warmNeed = Math.min(opts.warmSec, opts.params.impulseVolMult > 0 ? 8 : opts.warmSec);
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

  const outDir = path.resolve('runs/binance-lead-scalp-live');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  let lastSlug = null;

  async function waitNextWindow(afterSlug) {
    const waitDeadline = Date.now() + opts.waitTimeoutSec * 1000;
    while (Date.now() < waitDeadline) {
      if (session.realizedPnl <= -opts.maxSessionLoss) {
        console.log(`session loss cap hit pnl=${session.realizedPnl}`);
        return false;
      }
      if (session.notionalUsed + opts.budget > opts.maxSessionNotional + 1e-9) {
        console.log(`session notional cap hit used=${session.notionalUsed}`);
        return false;
      }
      const ev = await findActiveBtc5mEvent();
      if (ev?.eventEnd) {
        const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
        const tau = Math.floor((endMs - Date.now()) / 1000);
        const slug = ev.slug || null;
        if (slug && slug !== afterSlug && tau >= Math.max(opts.minTauStart, 60)) {
          console.log(`next window ok slug=${slug} tau=${tau}`);
          return true;
        }
        console.log(`waiting next… slug=${slug || '?'} tau=${tau} after=${afterSlug || '-'}`);
      } else console.log('waiting next… no active event');
      await sleep(2000);
    }
    return false;
  }

  try {
    for (let i = 0; i < opts.maxEvents; i++) {
      if (i > 0) {
        const ok = await waitNextWindow(lastSlug);
        if (!ok) break;
      }
      console.log(`\n--- event ${i + 1}/${opts.maxEvents} ---`);
      const rep = await runOneEvent({
        opts,
        feedCtx: { state, clobFeed },
        spotRing,
        midRing,
        client,
        session,
      });
      reports.push(rep);
      if (rep.skipped) {
        console.log(`skip: ${rep.reason} tau=${rep.tau ?? '-'}`);
        await sleep(2000);
        if (rep.reason === 'tau_low' || rep.reason === 'tau_past_window') {
          i -= 1;
          const ok = await waitNextWindow(rep.event || lastSlug);
          if (!ok) break;
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
        `decisionLatency p50=${rep.decisionLatencyMs.p50}ms p95=${rep.decisionLatencyMs.p95}ms` +
          ` sessionNotional=${session.notionalUsed.toFixed(2)} sessionPnl=${session.realizedPnl.toFixed(2)}`,
      );
      const fname = `scE_live_${(rep.event.slug || 'e').replace(/[^\w-]/g, '_')}_${Date.now()}.json`;
      fs.writeFileSync(path.join(outDir, fname), JSON.stringify(rep, null, 2));
      console.log(`wrote ${path.join(outDir, fname)}`);

      if (session.realizedPnl <= -opts.maxSessionLoss) {
        console.log('⛔ stopping: max-session-loss');
        break;
      }
      if (session.notionalUsed + opts.budget > opts.maxSessionNotional + 1e-9) {
        console.log('⛔ stopping: max-session-notional');
        break;
      }
    }
  } finally {
    await cancelAll(client, 'shutdown');
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
  const byReason = {};
  for (const t of allTrades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const summary = {
    generatedAt: nowIso(),
    dry: false,
    live: true,
    strategy: 'binance-lead-scalp',
    variant: opts.params.id,
    setup: opts.variantName,
    maxEvents: opts.maxEvents,
    budget: opts.budget,
    session,
    events: traded.length,
    trades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: allTrades.length ? Math.round((1000 * wins.length) / allTrades.length) / 10 : null,
    lucroBruto: Math.round((totalPnl + fees) * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    lucroLiquido: Math.round(totalPnl * 100) / 100,
    profitFactor: grossLossAbs > 0 ? Math.round((grossProfit / grossLossAbs) * 100) / 100 : wins.length ? Infinity : null,
    exitReasons: byReason,
    reports: reports.map((r) =>
      r.skipped
        ? { skipped: true, reason: r.reason, event: r.event }
        : { slug: r.event?.slug, result: r.result },
    ),
  };
  const sumPath = path.join(outDir, `summary_${Date.now()}.json`);
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log(`\n=== LIVE summary ===`);
  console.log(
    `events=${summary.events} trades=${summary.trades} wr=${summary.winRate}%` +
      ` liquido=${summary.lucroLiquido} fees=${summary.fees} pf=${summary.profitFactor}`,
  );
  console.log(`summary → ${sumPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
