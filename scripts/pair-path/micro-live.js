#!/usr/bin/env node
/**
 * Pair-Path V0 / Clip-Path V1 micro harness.
 *
 * Default: DRY (WS book + simulated fills, no CLOB orders).
 * Live: --live (real orders, micro size).
 *
 *   node scripts/pair-path/micro-live.js
 *   node scripts/pair-path/micro-live.js --clip=tight --open-shares=10 --max-events=2
 *   node scripts/pair-path/micro-live.js --live --clip=tight --open-shares=10 --max-events=1
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

const DEFAULTS = {
  openShares: 5,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTrigger: 0.55,
  openCap: 0.01, // dollars; CLI --open-cap-cents overrides
  hedgeAskMax: 0.42,
  avgSumMax: 0.96,
  tauOpenMin: 40,
  tauOpenMax: 240,
  tauHedgeMin: 15,
  maxEventNotional: 8,
  maxOpenAttempts: 3,
  maxHedgeAttempts: 2,
  maxEvents: 1,
  /** Decision loop — alta frequência; book vem do WS (+ REST se stale). */
  pollMs: 50,
  /** Não abre/hedgeia se last tick do book for mais velho que isto. */
  maxBookAgeMs: 2500,
  /** Live open/hedge: GTC marketable + poll + cancel (FOK morre sem liquidez no nível). */
  orderType: 'GTC',
  settleMs: 1200,
  settlePollMs: 150,
  /** Clip-Path: null = V0 single hedge. */
  hedgeLevels: null,
  tauHedgeEscape: null,
  hedgeEscapeAskMax: null,
  /** Soft open gate: opposite ask must be near-hedgeable. */
  openRequireHedgeReady: false,
  openHedgeSlackCents: 8,
  openPairSumMaxAtOpen: null,
  /** Escape may use a looser avgSum than normal clips (flatten > edge). */
  escapeAvgSumMax: 0.98,
  /** Stop the series if residual shares remain after an event. */
  stopOnResidual: true,
  /** Stop if equalized avgSum >= this (structural loss). */
  stopOnAvgSum: 1.0,
};

/** Named Clip-Path presets (lab clip-levels-ab). */
const CLIP_PRESETS = {
  off: {
    hedgeLevels: null,
    tauHedgeEscape: null,
    hedgeEscapeAskMax: null,
    hedgeAskMax: 0.42,
    avgSumMax: 0.96,
    maxHedgeAttempts: 2,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
  },
  '2': {
    hedgeLevels: [
      { askMax: 0.42, frac: 0.5 },
      { askMax: 0.38, frac: 0.5 },
    ],
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    hedgeAskMax: 0.42,
    avgSumMax: 0.94,
    maxHedgeAttempts: 8,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  },
  '3': {
    hedgeLevels: [
      { askMax: 0.42, frac: 0.4 },
      { askMax: 0.38, frac: 0.3 },
      { askMax: 0.34, frac: 0.3 },
    ],
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    hedgeAskMax: 0.42,
    avgSumMax: 0.94,
    maxHedgeAttempts: 8,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  },
  /** Prior tight — still GO in sweep (~pnl 11.9 sh25). */
  tight: {
    hedgeLevels: [
      { askMax: 0.4, frac: 0.5 },
      { askMax: 0.36, frac: 0.5 },
    ],
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    hedgeAskMax: 0.4,
    avgSumMax: 0.95,
    maxHedgeAttempts: 8,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  },
  /** Sweep ops pick: c3-40-36-32 avg0.94 + late escape (τ20 then τ12). */
  deep3: {
    hedgeLevels: [
      { askMax: 0.4, frac: 0.4 },
      { askMax: 0.36, frac: 0.3 },
      { askMax: 0.32, frac: 0.3 },
    ],
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    hedgeAskMax: 0.4,
    avgSumMax: 0.94,
    maxHedgeAttempts: 8,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  },
  /** Lab champion (needs ask≤30¢) — dry first. */
  deep4: {
    hedgeLevels: [
      { askMax: 0.42, frac: 0.25 },
      { askMax: 0.38, frac: 0.25 },
      { askMax: 0.34, frac: 0.25 },
      { askMax: 0.3, frac: 0.25 },
    ],
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    hedgeAskMax: 0.42,
    avgSumMax: 0.93,
    maxHedgeAttempts: 8,
    openRequireHedgeReady: false,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  },
};

function parseHedgeLevels(raw) {
  if (raw == null || raw === '' || raw === 'off' || raw === 'null') return null;
  return String(raw)
    .split(',')
    .map((part) => {
      const [askMax, frac] = part.trim().split(':').map(Number);
      if (!Number.isFinite(askMax) || !Number.isFinite(frac)) {
        throw new Error(`invalid --hedge-levels segment: ${part}`);
      }
      return { askMax, frac };
    });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const clipName = String(valueOf('--clip') ?? 'off').toLowerCase();
  if (clipName !== 'off' && !CLIP_PRESETS[clipName]) {
    throw new Error(`unknown --clip=${clipName} (use off|2|3|tight|deep3|deep4)`);
  }
  const clip = CLIP_PRESETS[clipName] || CLIP_PRESETS.off;
  const hedgeLevelsRaw = valueOf('--hedge-levels');
  return {
    live: hasLiveFlag(argv),
    json: args.includes('--json'),
    clip: clipName,
    openShares: Math.max(1, parseInt(valueOf('--open-shares') ?? String(DEFAULTS.openShares), 10)),
    maxEvents: Math.max(1, parseInt(valueOf('--max-events') ?? String(DEFAULTS.maxEvents), 10)),
    maxNotional: parseFloat(valueOf('--max-notional') ?? String(DEFAULTS.maxEventNotional)),
    timeoutSec: parseInt(valueOf('--timeout') ?? '320', 10),
    openCapCents: Math.max(0, parseInt(valueOf('--open-cap-cents') ?? '1', 10) || 1),
    /** Wait until active event has at least this many seconds left before starting. */
    minTauStart: Math.max(0, parseInt(valueOf('--min-tau-start') ?? '0', 10) || 0),
    /** Max seconds to wait for a good event window. */
    waitTimeoutSec: Math.max(30, parseInt(valueOf('--wait-timeout') ?? '360', 10) || 360),
    /** LIVE order type: GTC (default, settle+cancel) | FAK | FOK */
    orderType: String(valueOf('--order-type') ?? DEFAULTS.orderType).toUpperCase(),
    settleMs: Math.max(200, parseInt(valueOf('--settle-ms') ?? String(DEFAULTS.settleMs), 10) || DEFAULTS.settleMs),
    settlePollMs: Math.max(50, parseInt(valueOf('--settle-poll-ms') ?? String(DEFAULTS.settlePollMs), 10) || DEFAULTS.settlePollMs),
    pollMs: Math.max(20, parseInt(valueOf('--poll-ms') ?? String(DEFAULTS.pollMs), 10) || DEFAULTS.pollMs),
    maxBookAgeMs: Math.max(
      500,
      parseInt(valueOf('--max-book-age-ms') ?? String(DEFAULTS.maxBookAgeMs), 10) || DEFAULTS.maxBookAgeMs,
    ),
    avgSumMax: parseFloat(valueOf('--avg-sum-max') ?? String(clip.avgSumMax ?? DEFAULTS.avgSumMax)),
    hedgeAskMax: parseFloat(valueOf('--hedge-ask-max') ?? String(clip.hedgeAskMax ?? DEFAULTS.hedgeAskMax)),
    maxHedgeAttempts: Math.max(
      1,
      parseInt(valueOf('--max-hedge-attempts') ?? String(clip.maxHedgeAttempts ?? DEFAULTS.maxHedgeAttempts), 10) ||
        DEFAULTS.maxHedgeAttempts,
    ),
    hedgeLevels:
      hedgeLevelsRaw != null ? parseHedgeLevels(hedgeLevelsRaw) : clip.hedgeLevels ?? null,
    tauHedgeEscape: (() => {
      const v = valueOf('--tau-hedge-escape');
      if (v != null) return v === 'off' || v === 'null' ? null : parseInt(v, 10);
      return clip.tauHedgeEscape ?? null;
    })(),
    hedgeEscapeAskMax: (() => {
      const v = valueOf('--hedge-escape-ask-max');
      if (v != null) return parseFloat(v);
      return clip.hedgeEscapeAskMax ?? null;
    })(),
    openRequireHedgeReady: (() => {
      if (args.includes('--hedge-ready')) return true;
      if (args.includes('--no-hedge-ready')) return false;
      return Boolean(clip.openRequireHedgeReady);
    })(),
    openHedgeSlackCents: Math.max(
      0,
      parseInt(
        valueOf('--open-hedge-slack-cents') ?? String(clip.openHedgeSlackCents ?? DEFAULTS.openHedgeSlackCents),
        10,
      ) || 0,
    ),
    openPairSumMaxAtOpen: (() => {
      const v = valueOf('--open-pair-sum-max');
      if (v != null) return parseFloat(v);
      return clip.openPairSumMaxAtOpen ?? null;
    })(),
    escapeAvgSumMax: parseFloat(
      valueOf('--escape-avg-sum-max') ?? String(clip.escapeAvgSumMax ?? DEFAULTS.escapeAvgSumMax),
    ),
    tauHedgeEscape2: (() => {
      const v = valueOf('--tau-hedge-escape2');
      if (v != null) return v === 'off' || v === 'null' ? null : parseInt(v, 10);
      return clip.tauHedgeEscape2 ?? null;
    })(),
    hedgeEscapeAskMax2: (() => {
      const v = valueOf('--hedge-escape-ask-max2');
      if (v != null) return parseFloat(v);
      return clip.hedgeEscapeAskMax2 ?? null;
    })(),
    escapeAvgSumMax2: (() => {
      const v = valueOf('--escape-avg-sum-max2');
      if (v != null) return parseFloat(v);
      return clip.escapeAvgSumMax2 ?? null;
    })(),
    stopOnResidual: !args.includes('--no-stop-on-residual'),
    stopOnAvgSum: parseFloat(valueOf('--stop-on-avg-sum') ?? String(DEFAULTS.stopOnAvgSum)),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function feeEst(price, shares, rate = 0.07) {
  const p = Math.min(0.99, Math.max(0.01, price));
  return rate * p * (1 - p) * shares;
}

function createPairState(params) {
  return {
    mode: 'idle', // idle | opened | hedged | done
    sideOpen: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    openAttempts: 0,
    hedgeAttempts: 0,
    hedgePlan: null,
    fills: [],
    orders: [],
    blocks: [],
    params,
  };
}

function buildHedgePlan(levels, openSh) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const plan = [];
  let allocated = 0;
  for (let i = 0; i < levels.length; i++) {
    const isLast = i === levels.length - 1;
    let targetSh;
    if (isLast) {
      targetSh = Math.round((openSh - allocated) * 1000) / 1000;
    } else {
      targetSh = Math.round(openSh * Number(levels[i].frac) * 1000) / 1000;
      allocated += targetSh;
    }
    if (targetSh > 0) {
      plan.push({ askMax: Number(levels[i].askMax), targetSh, filled: 0 });
    }
  }
  return plan;
}

function nextClipAskMax(st) {
  const p = st.params;
  if (!st.hedgePlan) return p.hedgeAskMax;
  for (const clip of st.hedgePlan) {
    if (clip.filled + 1e-9 < clip.targetSh) return clip.askMax;
  }
  return p.hedgeAskMax;
}

function projectedAvgSum(st, side, px, sh) {
  if (sh <= 0) return avgSum(st);
  const cur = st.inv[side];
  const newAvg = (cur.cost + sh * px) / (cur.shares + sh);
  const other = side === 'UP' ? 'DOWN' : 'UP';
  const o = avg(st, other);
  if (o == null) return null;
  return newAvg + o;
}

function invested(st) {
  return st.inv.UP.cost + st.inv.DOWN.cost;
}

function avg(st, side) {
  const x = st.inv[side];
  return x.shares > 0 ? x.cost / x.shares : null;
}

function avgSum(st) {
  const a = avg(st, 'UP');
  const b = avg(st, 'DOWN');
  if (a == null || b == null) return null;
  return a + b;
}

function recordBuy(st, side, px, sh, kind, fee, orderMeta = {}) {
  st.inv[side].shares += sh;
  st.inv[side].cost += sh * px;
  st.inv[side].fees += fee;
  const fill = { side, px, sh, kind, fee, ts: nowIso(), ...orderMeta };
  st.fills.push(fill);
  return fill;
}

function resolveOrderType(name) {
  if (name === 'FOK') return OrderType.FOK;
  if (name === 'FAK') return OrderType.FAK;
  return OrderType.GTC;
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
      return { filled: true, partial: matched + 1e-9 < original, matched, original, order: last, terminal: true };
    }
    if (['canceled', 'cancelled', 'expired'].includes(status)) {
      return { filled: matched > 0, partial: matched > 0, matched, original, order: last, terminal: true };
    }
    await sleep(settlePollMs);
  }
  const matched = Number(last?.size_matched ?? 0) || 0;
  const original = Number(last?.original_size ?? 0) || 0;
  return { filled: matched > 0, partial: matched > 0 && matched + 1e-9 < original, matched, original, order: last, terminal: false };
}

async function placeBuy(client, live, tokenId, price, size, label, execOpts = {}) {
  const t0 = performance.now();
  if (!live) {
    return {
      ok: true,
      dry: true,
      filled: true,
      price,
      size,
      filledSize: size,
      ms: Math.round(performance.now() - t0),
      orderId: null,
      raw: { dry: true, label },
    };
  }
  const orderTypeName = String(execOpts.orderType || 'GTC').toUpperCase();
  const orderType = resolveOrderType(orderTypeName);
  const settleMs = execOpts.settleMs ?? DEFAULTS.settleMs;
  const settlePollMs = execOpts.settlePollMs ?? DEFAULTS.settlePollMs;
  try {
    // GTC marketable + short settle: FOK no nível frequentemente kill por liquidez fina (live #2).
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, side: Side.BUY, size },
      undefined,
      orderType,
      false,
      false,
    );
    const orderId = resp?.orderID ?? null;
    const posted = Boolean(resp?.success && orderId);
    if (!posted) {
      return {
        ok: false,
        dry: false,
        filled: false,
        price,
        size,
        filledSize: 0,
        ms: Math.round(performance.now() - t0),
        orderId,
        raw: {
          success: resp?.success,
          status: resp?.status,
          errorMsg: resp?.errorMsg,
          label,
          orderType: orderTypeName,
        },
      };
    }

    // Immediate match fields on ack (common for aggressive GTC/FAK/FOK)
    const taking = Number(resp?.takingAmount ?? 0) || 0;
    let matched = taking > 0 ? taking : 0;
    let settle = null;
    if (orderTypeName === 'GTC') {
      settle = await waitMatched(client, orderId, { settleMs, settlePollMs });
      matched = Math.max(matched, settle.matched || 0);
      if (!settle.terminal || settle.partial || matched + 1e-9 < size) {
        try {
          await client.cancelOrder({ orderID: orderId });
        } catch {
          /* already gone / filled */
        }
        // re-read once after cancel
        settle = await waitMatched(client, orderId, { settleMs: 400, settlePollMs: 100 });
        matched = Math.max(matched, settle.matched || 0);
      }
    } else {
      // FAK/FOK: no rest — trust ack + one getOrder
      settle = await waitMatched(client, orderId, { settleMs: Math.min(settleMs, 600), settlePollMs });
      matched = Math.max(matched, settle.matched || 0);
    }

    const filledSize = matched > 0 ? matched : 0;
    const filled = filledSize + 1e-9 >= size * 0.99; // almost-full counts as fill for micro equalize
    const ms = Math.round(performance.now() - t0);
    return {
      ok: true,
      dry: false,
      filled,
      price,
      size,
      filledSize,
      ms,
      orderId,
      raw: {
        success: resp?.success,
        status: resp?.status ?? settle?.order?.status,
        errorMsg: resp?.errorMsg,
        label,
        orderType: orderTypeName,
        matched: filledSize,
        settleTerminal: settle?.terminal ?? null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      dry: false,
      filled: false,
      price,
      size,
      filledSize: 0,
      ms: Math.round(performance.now() - t0),
      orderId: null,
      raw: { error: err.message, label, orderType: orderTypeName },
    };
  }
}

function pickChaseSide(upAsk, dnAsk) {
  if (upAsk == null || dnAsk == null) return null;
  return upAsk >= dnAsk ? 'UP' : 'DOWN';
}

function tryOpenLogic(st, upAsk, dnAsk, tau) {
  const p = st.params;
  if (st.mode !== 'idle') return null;
  if (tau == null || tau < p.tauOpenMin || tau > p.tauOpenMax) return null;
  if (st.openAttempts >= p.maxOpenAttempts) return null;

  const side = pickChaseSide(upAsk, dnAsk);
  if (!side) return null;
  const ask = side === 'UP' ? upAsk : dnAsk;
  const other = side === 'UP' ? dnAsk : upAsk;
  if (ask == null || other == null) return null;

  const sum = ask + other;
  if (sum < 0.95 || sum > 1.05) {
    st.blocks.push({ reason: 'BOOK_SUM', sum, tau });
    return null;
  }
  if (ask < p.openAskLo || ask > p.openAskHi) return null;
  if (ask + 1e-12 < p.openTrigger) return null;

  // Hedge-ready: don't open if opposite is already too expensive to clip/escape.
  if (p.openRequireHedgeReady) {
    const slack = (p.openHedgeSlackCents || 0) / 100;
    const oppMax = p.hedgeAskMax + slack;
    if (other > oppMax + 1e-12) {
      st.blocks.push({ reason: 'OPEN_HEDGE_NOT_READY', ask, askO: other, oppMax, tau });
      return null;
    }
    const pairMax = p.openPairSumMaxAtOpen != null ? p.openPairSumMaxAtOpen : p.avgSumMax;
    if (sum > pairMax + 1e-12) {
      st.blocks.push({ reason: 'OPEN_PAIR_NOT_CHEAP', sum, pairMax, tau });
      return null;
    }
  }

  const limitPx = Math.min(ask, p.openTrigger + p.openCap);
  const gap = ask - p.openTrigger;
  st.openAttempts += 1;
  if (gap > p.openCap + 1e-12) {
    st.blocks.push({ reason: 'OPEN_MISS_CAP', ask, gapC: gap * 100, tau });
    return { action: 'miss', side, ask, limitPx };
  }
  const sh = p.openShares;
  if (invested(st) + sh * limitPx > p.maxEventNotional) {
    st.blocks.push({ reason: 'TETO', tau });
    return null;
  }
  return { action: 'open', side, ask, limitPx, sh };
}

function tryHedgeLogic(st, upAsk, dnAsk, tau) {
  const p = st.params;
  if (st.mode !== 'opened') return null;
  if (tau == null) return null;
  const escapeWindowOpen =
    (p.tauHedgeEscape != null && tau <= p.tauHedgeEscape + 1e-12) ||
    (p.tauHedgeEscape2 != null && tau <= p.tauHedgeEscape2 + 1e-12);
  if (tau < p.tauHedgeMin && !escapeWindowOpen) return null;

  const side = st.sideOpen === 'UP' ? 'DOWN' : 'UP';
  const ask = side === 'UP' ? upAsk : dnAsk;
  if (ask == null) return null;

  const openSh = st.inv[st.sideOpen].shares;
  let remaining = openSh - st.inv[side].shares;
  if (remaining <= 1e-9) {
    st.mode = 'hedged';
    return null;
  }

  // --- Clip-Path multi-level ---
  if (Array.isArray(p.hedgeLevels) && p.hedgeLevels.length > 0) {
    if (!st.hedgePlan) st.hedgePlan = buildHedgePlan(p.hedgeLevels, openSh);
    if (st.hedgeAttempts >= p.maxHedgeAttempts) return null;

    const nextMax = nextClipAskMax(st);
    const escMax = p.hedgeEscapeAskMax != null ? p.hedgeEscapeAskMax : p.hedgeAskMax;
    const escMax2 = p.hedgeEscapeAskMax2 != null ? p.hedgeEscapeAskMax2 : escMax;
    // Prefer stage2 (later/harder) when both windows open — mirrors engine.mjs.
    const escapeStages = [
      {
        enabled: p.tauHedgeEscape2 != null,
        tauMax: p.tauHedgeEscape2,
        askMax: escMax2,
        avgSumMax: p.escapeAvgSumMax2 != null ? p.escapeAvgSumMax2 : p.escapeAvgSumMax ?? p.avgSumMax,
        kind: 'hedge_escape2',
        via: 'escape2',
      },
      {
        enabled: p.tauHedgeEscape != null,
        tauMax: p.tauHedgeEscape,
        askMax: escMax,
        avgSumMax: p.escapeAvgSumMax != null ? p.escapeAvgSumMax : p.avgSumMax,
        kind: 'hedge_escape',
        via: 'escape',
      },
    ];

    if (ask > nextMax + 1e-12) {
      for (const stage of escapeStages) {
        if (
          !stage.enabled ||
          tau > Number(stage.tauMax) + 1e-12 ||
          ask > Number(stage.askMax) + 1e-12
        ) {
          continue;
        }
        const proj = projectedAvgSum(st, side, ask, remaining);
        if (proj != null && proj > stage.avgSumMax) {
          st.blocks.push({
            reason: 'HEDGE_REFUSE_AVGSUM',
            proj,
            ask,
            tau,
            via: stage.via,
            escAvgMax: stage.avgSumMax,
          });
          continue;
        }
        if (invested(st) + remaining * ask > p.maxEventNotional) {
          st.blocks.push({ reason: 'TETO_HEDGE', tau, via: stage.via });
          return null;
        }
        st.hedgeAttempts += 1;
        return {
          action: 'hedge',
          kind: stage.kind,
          side,
          ask,
          limitPx: ask,
          sh: remaining,
          via: stage.via,
        };
      }
      return null;
    }

    // Fill shallow→deep clips eligible at current ask (one clip per decision tick).
    for (const clip of st.hedgePlan) {
      const need = clip.targetSh - clip.filled;
      if (need <= 1e-9) continue;
      if (ask > clip.askMax + 1e-12) continue;
      const sh = Math.min(need, remaining);
      const proj = projectedAvgSum(st, side, ask, sh);
      if (proj != null && proj > p.avgSumMax) {
        st.blocks.push({ reason: 'HEDGE_REFUSE_AVGSUM', proj, ask, sh, tau });
        return null;
      }
      if (invested(st) + sh * ask > p.maxEventNotional) {
        st.blocks.push({ reason: 'TETO_HEDGE', tau });
        return null;
      }
      st.hedgeAttempts += 1;
      return {
        action: 'hedge',
        kind: 'hedge_clip',
        side,
        ask,
        limitPx: ask,
        sh,
        askMax: clip.askMax,
        clip,
      };
    }
    return null;
  }

  // --- V0 single full hedge ---
  if (st.hedgeAttempts >= p.maxHedgeAttempts) return null;
  if (ask > p.hedgeAskMax + 1e-12) return null;

  const proj = projectedAvgSum(st, side, ask, remaining);
  if (proj != null && proj > p.avgSumMax) {
    st.blocks.push({ reason: 'HEDGE_REFUSE_AVGSUM', proj, ask, tau });
    return null;
  }
  if (invested(st) + remaining * ask > p.maxEventNotional) {
    st.blocks.push({ reason: 'TETO_HEDGE', tau });
    return null;
  }
  st.hedgeAttempts += 1;
  return { action: 'hedge', kind: 'hedge', side, ask, limitPx: ask, sh: remaining };
}

async function runOneEvent({ client, live, params, outDir, feedCtx }) {
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
  if (tau0 < params.tauOpenMin) {
    return { skipped: true, reason: 'tau_low', tau: tau0, event: event.title };
  }

  const { state, clobFeed } = feedCtx;
  clobFeed.subscribe(event.upTokenId, event.downTokenId);
  await clobFeed.refreshBooks();

  // Wait for a fresh book (WS tick or REST seed), not just any non-null ask.
  for (let i = 0; i < 80; i++) {
    const lag = clobFeed.lagMs();
    if (
      state.up.bestAsk != null &&
      state.down.bestAsk != null &&
      Number.isFinite(lag) &&
      lag < params.maxBookAgeMs
    ) {
      break;
    }
    if (i > 0 && i % 20 === 0) await clobFeed.refreshBooks();
    await sleep(50);
  }

  const st = createPairState(params);
  const log = [];
  const deadline = Date.now() + Math.min(params.timeoutSec || 320, Math.max(30, tau0 + 5)) * 1000;
  let lastHb = 0;
  let lastStaleRefresh = 0;
  let loops = 0;
  let staleBlocks = 0;

  console.log(
    `event=${event.slug || event.title} tau≈${tau0}s live=${live} shares=${params.openShares} maxNotional=${params.maxEventNotional} orderType=${params.orderType} pollMs=${params.pollMs}`,
  );

  while (Date.now() < deadline) {
    const tau = Math.floor((endMs - Date.now()) / 1000);
    if (tau <= 0) break;

    const now = Date.now();
    const lag = clobFeed.lagMs();
    const bookFresh = Number.isFinite(lag) && lag <= params.maxBookAgeMs;

    // REST fallback agressivo no harness se o book envelhecer (além do reseed do clobFeed).
    if (!bookFresh && now - lastStaleRefresh >= 1000) {
      lastStaleRefresh = now;
      await clobFeed.refreshBooks();
    }

    const upAsk = state.up.bestAsk;
    const dnAsk = state.down.bestAsk;
    loops += 1;

    if (now - lastHb >= 5_000) {
      lastHb = now;
      console.log(
        `… hb tau=${tau} up=${upAsk} dn=${dnAsk} mode=${st.mode} fills=${st.fills.length}` +
          ` ws=${state.wsClobConnected} ageMs=${Number.isFinite(lag) ? Math.round(lag) : null}` +
          ` fresh=${bookFresh} loops=${loops}`,
      );
    }

    if (!bookFresh) {
      staleBlocks += 1;
      await sleep(params.pollMs);
      continue;
    }

    if (st.mode === 'idle') {
      const intent = tryOpenLogic(st, upAsk, dnAsk, tau);
      if (intent?.action === 'open') {
        const tokenId = intent.side === 'UP' ? event.upTokenId : event.downTokenId;
        console.log(`OPEN intent ${intent.side} @${intent.limitPx} sh=${intent.sh} ask=${intent.ask} type=${params.orderType}`);
        const res = await placeBuy(client, live, tokenId, intent.limitPx, intent.sh, 'open', {
          orderType: params.orderType,
          settleMs: params.settleMs,
          settlePollMs: params.settlePollMs,
        });
        st.orders.push({ kind: 'open', ...res });
        log.push({ t: nowIso(), phase: 'open', intent, res });
        const fillSh = res.dry ? intent.sh : Number(res.filledSize || 0);
        // Live: always book any positive fill (partial GTC still moves inventory).
        if (res.ok && fillSh > 0) {
          const fee = feeEst(intent.limitPx, fillSh);
          recordBuy(st, intent.side, intent.limitPx, fillSh, 'open', res.dry ? fee : fee, {
            orderId: res.orderId,
            dry: res.dry,
            ms: res.ms,
            orderType: params.orderType,
            partial: fillSh + 1e-9 < intent.sh * 0.99,
          });
          st.sideOpen = intent.side;
          st.mode = 'opened';
          console.log(
            `OPEN fill ${intent.side} @${intent.limitPx} sh=${fillSh}` +
              `${fillSh + 1e-9 < intent.sh ? ` (partial/${intent.sh})` : ''} ms=${res.ms} dry=${res.dry}`,
          );
        } else {
          console.log(`OPEN fail/miss`, res.raw);
        }
      }
    } else if (st.mode === 'opened') {
      const intent = tryHedgeLogic(st, upAsk, dnAsk, tau);
      if (intent?.action === 'hedge') {
        const tokenId = intent.side === 'UP' ? event.upTokenId : event.downTokenId;
        const kind = intent.kind || 'hedge';
        console.log(
          `HEDGE intent ${intent.side} @${intent.limitPx} sh=${intent.sh} kind=${kind}` +
            `${intent.askMax != null ? ` askMax=${intent.askMax}` : ''} type=${params.orderType}`,
        );
        const res = await placeBuy(client, live, tokenId, intent.limitPx, intent.sh, kind, {
          orderType: params.orderType,
          settleMs: params.settleMs,
          settlePollMs: params.settlePollMs,
        });
        st.orders.push({ kind, ...res });
        log.push({ t: nowIso(), phase: 'hedge', intent, res });
        const fillSh = res.dry ? intent.sh : Number(res.filledSize || 0);
        if (res.ok && fillSh > 0) {
          const fee = feeEst(intent.limitPx, fillSh);
          recordBuy(st, intent.side, intent.limitPx, fillSh, kind, res.dry ? fee : fee, {
            orderId: res.orderId,
            dry: res.dry,
            ms: res.ms,
            orderType: params.orderType,
            askMax: intent.askMax,
            via: intent.via,
            partial: fillSh + 1e-9 < intent.sh * 0.99,
          });
          if (intent.clip) {
            intent.clip.filled += fillSh;
          } else if (st.hedgePlan && (kind === 'hedge_escape' || kind === 'hedge_escape2')) {
            let left = fillSh;
            for (const clip of st.hedgePlan) {
              const need = clip.targetSh - clip.filled;
              if (need <= 0 || left <= 0) continue;
              const take = Math.min(need, left);
              clip.filled += take;
              left -= take;
            }
          }
          const residual = Math.abs(st.inv.UP.shares - st.inv.DOWN.shares);
          st.mode = residual < 1e-6 ? 'done' : 'opened';
          console.log(
            `HEDGE fill ${intent.side} @${intent.limitPx} sh=${fillSh} kind=${kind}` +
              `${fillSh + 1e-9 < intent.sh ? ` (partial/${intent.sh})` : ''}` +
              ` mode=${st.mode} avgSum=${avgSum(st)} residual=${residual}`,
          );
        } else {
          console.log(`HEDGE fail`, res.raw);
        }
      }
    }

    if (st.mode === 'done') break;
    await sleep(params.pollMs);
  }

  // winner proxy
  const upAsk = state.up.bestAsk;
  const dnAsk = state.down.bestAsk;
  let winner = null;
  if (upAsk != null && dnAsk != null) winner = upAsk >= dnAsk ? 'UP' : 'DOWN';
  const cost = invested(st);
  const fees = st.inv.UP.fees + st.inv.DOWN.fees;
  const pnl = winner != null ? st.inv[winner].shares - cost - fees : null;

  const report = {
    generatedAt: nowIso(),
    live,
    event: {
      slug: event.slug,
      title: event.title,
      upTokenId: event.upTokenId,
      downTokenId: event.downTokenId,
    },
    params,
    mode: st.mode,
    sideOpen: st.sideOpen,
    inv: st.inv,
    invested: Math.round(cost * 100) / 100,
    fees: Math.round(fees * 1000) / 1000,
    avgSum: avgSum(st) != null ? Math.round(avgSum(st) * 1000) / 1000 : null,
    residual: Math.abs(st.inv.UP.shares - st.inv.DOWN.shares),
    winner,
    pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
    fills: st.fills,
    hedgePlan: st.hedgePlan,
    nHedgeClips: st.fills.filter((f) =>
      f.kind === 'hedge_clip' || f.kind === 'hedge_escape' || f.kind === 'hedge_escape2',
    ).length,
    orders: st.orders.map((o) => ({
      kind: o.kind,
      ok: o.ok,
      filled: o.filled,
      dry: o.dry,
      ms: o.ms,
      price: o.price,
      size: o.size,
      raw: o.raw,
    })),
    openAttempts: st.openAttempts,
    hedgeAttempts: st.hedgeAttempts,
    staleBlocks,
    blockCounts: st.blocks.reduce((m, b) => {
      m[b.reason] = (m[b.reason] || 0) + 1;
      return m;
    }, {}),
    log,
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const slug = event.slug || `event-${Date.now()}`;
    fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(report, null, 2));
  }
  return report;
}

async function cancelAllOpenOrders(client, label = 'cancelAll') {
  if (!client || typeof client.cancelAll !== 'function') return { ok: false, reason: 'no_cancelAll' };
  try {
    const resp = await client.cancelAll();
    console.log(`🛡 ${label}: cancelAll ok`, resp?.canceled?.length ?? resp ?? '');
    return { ok: true, resp };
  } catch (err) {
    console.log(`⚠ ${label}: cancelAll failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function preflightLive(client) {
  if (!client) return;
  try {
    const open = await client.getOpenOrders();
    const n = Array.isArray(open) ? open.length : 0;
    console.log(`preflight openOrders=${n}`);
    if (n > 0) {
      console.log('🛡 orphan open orders — cancelAll before series');
      await cancelAllOpenOrders(client, 'preflight');
      const after = await client.getOpenOrders();
      const n2 = Array.isArray(after) ? after.length : 0;
      if (n2 > 0) {
        throw new Error(`EXISTING_OPEN_ORDERS after cancelAll: ${n2}`);
      }
    }
  } catch (err) {
    if (String(err.message || '').includes('EXISTING_OPEN_ORDERS')) throw err;
    console.log(`⚠ preflight getOpenOrders: ${err.message}`);
  }
}

function sessionKillReason(report, params) {
  if (!report || report.skipped) return null;
  const residual = Number(report.residual || 0);
  if (params.stopOnResidual && residual >= 1) {
    return `RESIDUAL_${residual}`;
  }
  if (
    report.avgSum != null &&
    params.stopOnAvgSum != null &&
    report.fills?.length >= 2 &&
    residual < 1e-6 &&
    report.avgSum >= params.stopOnAvgSum
  ) {
    return `AVGSUM_${report.avgSum}`;
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.live) {
    requireLiveFlag('pair-path:micro-live', {
      hint: 'node scripts/pair-path/micro-live.js --live --clip=tight --open-shares=10 --max-events=1',
    });
  }

  const params = {
    ...DEFAULTS,
    openShares: opts.openShares,
    maxEventNotional: opts.maxNotional,
    maxEvents: opts.maxEvents,
    timeoutSec: opts.timeoutSec,
    openCap: opts.openCapCents / 100,
    pollMs: opts.pollMs,
    maxBookAgeMs: opts.maxBookAgeMs,
    orderType: ['GTC', 'FAK', 'FOK'].includes(opts.orderType) ? opts.orderType : 'GTC',
    settleMs: opts.settleMs,
    settlePollMs: opts.settlePollMs,
    avgSumMax: opts.avgSumMax,
    hedgeAskMax: opts.hedgeAskMax,
    maxHedgeAttempts: opts.maxHedgeAttempts,
    hedgeLevels: opts.hedgeLevels,
    tauHedgeEscape: opts.tauHedgeEscape,
    hedgeEscapeAskMax: opts.hedgeEscapeAskMax,
    openRequireHedgeReady: opts.openRequireHedgeReady,
    openHedgeSlackCents: opts.openHedgeSlackCents,
    openPairSumMaxAtOpen: opts.openPairSumMaxAtOpen,
    escapeAvgSumMax: opts.escapeAvgSumMax,
    tauHedgeEscape2: opts.tauHedgeEscape2,
    hedgeEscapeAskMax2: opts.hedgeEscapeAskMax2,
    escapeAvgSumMax2: opts.escapeAvgSumMax2,
    stopOnResidual: opts.stopOnResidual,
    stopOnAvgSum: opts.stopOnAvgSum,
    clip: opts.clip,
  };

  console.log('=== Pair-Path / Clip-Path micro-live ===');
  console.log(
    `mode=${opts.live ? 'LIVE' : 'DRY'} clip=${opts.clip} openShares=${params.openShares} maxEvents=${params.maxEvents}`,
  );
  console.log(
    `maxNotional=${params.maxEventNotional} avgSumMax=${params.avgSumMax} hedgeMax=${params.hedgeAskMax}` +
      ` openCap=${opts.openCapCents}¢ orderType=${params.orderType} settleMs=${params.settleMs}` +
      ` maxHedgeAttempts=${params.maxHedgeAttempts}`,
  );
  if (params.hedgeLevels?.length) {
    console.log(
      `hedgeLevels=${params.hedgeLevels.map((l) => `${l.frac}@≤${l.askMax}`).join(' + ')}` +
        ` escape=${params.tauHedgeEscape != null ? `τ≤${params.tauHedgeEscape}@≤${params.hedgeEscapeAskMax}` : 'off'}` +
        ` escAvgMax=${params.escapeAvgSumMax}` +
        (params.tauHedgeEscape2 != null
          ? ` escape2=τ≤${params.tauHedgeEscape2}@≤${params.hedgeEscapeAskMax2} esc2Avg≤${params.escapeAvgSumMax2}`
          : ''),
    );
  } else {
    console.log('hedgeLevels=off (V0 single full hedge)');
  }
  console.log(
    `protections: hedgeReady=${params.openRequireHedgeReady}` +
      `${params.openRequireHedgeReady ? `(slack+${params.openHedgeSlackCents}¢ pair≤${params.openPairSumMaxAtOpen})` : ''}` +
      ` stopOnResidual=${params.stopOnResidual} stopOnAvgSum=${params.stopOnAvgSum}`,
  );
  console.log(`feed pollMs=${params.pollMs} maxBookAgeMs=${params.maxBookAgeMs} (WS+REST stale heal)`);
  if (opts.minTauStart > 0) {
    console.log(`wait for event with tau>=${opts.minTauStart}s (timeout ${opts.waitTimeoutSec}s)`);
  }

  let client = null;
  if (opts.live) {
    const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
    client = buildClobClient({ wallet, throwOnError: true });
    console.log(`signer=${wallet.address}`);
    await preflightLive(client);
  }

  let shuttingDown = false;
  const onSignal = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n⚠ ${sig} — cancelAll + exit`);
    if (opts.live && client) await cancelAllOpenOrders(client, sig);
    process.exit(130);
  };
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));

  // Optional: wait until a fresh event window (high tau)
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

  // Um único Market WS para a série — resubscribe por evento (evita tear-down/zombie).
  const state = createMarketState();
  let staleReconnects = 0;
  const clobFeed = createClobFeed(state, {
    onStaleReconnect: ({ reason, lagMs }) => {
      staleReconnects += 1;
      console.log(`⚠ feed force-reconnect reason=${reason} lagMs=${Math.round(lagMs)} n=${staleReconnects}`);
    },
  });
  const feedCtx = { state, clobFeed };

  const outDir = path.resolve('runs/pair-path-micro');
  const reports = [];
  let killReason = null;
  try {
    for (let i = 0; i < params.maxEvents; i++) {
      if (shuttingDown) break;
      console.log(`\n--- event ${i + 1}/${params.maxEvents} ---`);
      const r = await runOneEvent({ client, live: opts.live, params, outDir, feedCtx });
      reports.push(r);
      if (r.skipped) {
        console.log('skipped', r.reason, 'tau', r.tau);
        if (r.reason === 'tau_low') {
          const waitSec = Math.max(3, (r.tau ?? 0) + 2);
          console.log(`tau low — waiting ${waitSec}s for next event…`);
          await sleep(waitSec * 1000);
          if (opts.minTauStart > 0) {
            const waitDeadline = Date.now() + Math.min(opts.waitTimeoutSec, 400) * 1000;
            while (Date.now() < waitDeadline) {
              const ev = await findActiveBtc5mEvent();
              if (ev?.eventEnd) {
                const endMs = ev.eventEnd instanceof Date ? ev.eventEnd.getTime() : Number(ev.eventEnd);
                const tau = Math.floor((endMs - Date.now()) / 1000);
                if (tau >= opts.minTauStart) break;
              }
              await sleep(2000);
            }
          }
          i -= 1; // não consome slot da série
          continue;
        }
        await sleep(3000);
        continue;
      }
      console.log(
        `result mode=${r.mode} fills=${r.fills?.length ?? 0} clips=${r.nHedgeClips ?? 0}` +
          ` avgSum=${r.avgSum} pnl≈${r.pnl} invested=${r.invested} residual=${r.residual}` +
          ` staleBlocks=${r.staleBlocks ?? 0}`,
      );
      console.log('blocks', r.blockCounts);

      killReason = sessionKillReason(r, params);
      if (killReason) {
        console.log(`🛑 SESSION KILL: ${killReason} — não abre próximo evento`);
        if (opts.live && client) await cancelAllOpenOrders(client, 'session-kill');
        break;
      }
    }
  } finally {
    try {
      clobFeed.stop();
    } catch {
      /* ignore */
    }
    if (opts.live && client) {
      await cancelAllOpenOrders(client, 'series-end');
    }
  }

  const summary = {
    generatedAt: nowIso(),
    live: opts.live,
    params,
    staleReconnects,
    killReason,
    reports: reports.map((r) =>
      r.skipped
        ? r
        : {
            slug: r.event?.slug,
            mode: r.mode,
            fills: r.fills?.length,
            clips: r.nHedgeClips,
            avgSum: r.avgSum,
            pnl: r.pnl,
            invested: r.invested,
            residual: r.residual,
            staleBlocks: r.staleBlocks,
            blockCounts: r.blockCounts,
          },
    ),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `summary-${Date.now()}.json`), JSON.stringify(summary, null, 2));
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else console.log('\n=== done ===', JSON.stringify(summary.reports, null, 2));
  if (killReason) console.log('killReason:', killReason);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
