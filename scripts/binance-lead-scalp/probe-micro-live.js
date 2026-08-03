#!/usr/bin/env node
/**
 * Probe micro LIVE — 5 shares, sinal e-adapt, maker +8¢ (tenta ganhar).
 * Mede latência CTF (BUY → balance liberar SELL) e valida dump/stop.
 *
 *   node scripts/binance-lead-scalp/probe-micro-live.js --live --max-trades=2
 */
import 'dotenv/config';
import { OrderType, Side, AssetType } from '@polymarket/clob-client-v2';
import { requireLiveFlag } from '../../src/cli/liveGate.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { createMarketState } from '../../src/feeds/marketState.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { startBinanceSpotFeed } from '../../src/feeds/binanceSpotFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  VARIANT_E_ADAPT,
  createEventState,
  createSpotRing,
  createMidRing,
  spotRingSecsFor,
  impulseThreshold,
  pushSpot,
  pushMid,
  tryEntry,
  feeEst,
} from './scalp-engine.js';

const MIN_SHARES = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function roundPx(p) {
  return Math.min(0.99, Math.max(0.01, Math.round(Number(p) * 100) / 100));
}
function roundSh(s) {
  return Math.round(Number(s) * 100) / 100;
}

function parseArgs(argv) {
  requireLiveFlag('probe-micro-live', {
    argv,
    hint: 'node scripts/binance-lead-scalp/probe-micro-live.js --live --max-trades=2',
  });
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    shares: Math.max(MIN_SHARES, parseFloat(valueOf('--shares') ?? String(MIN_SHARES)) || MIN_SHARES),
    maxTrades: Math.max(1, parseInt(valueOf('--max-trades') ?? '2', 10) || 2),
    makerOffset: Math.max(0.01, parseFloat(valueOf('--maker-offset') ?? '0.03') || 0.03),
    stopLoss: Math.max(0.02, parseFloat(valueOf('--stop') ?? '0.05') || 0.05),
    rescueStop: Math.max(0.05, parseFloat(valueOf('--rescue-stop') ?? '0.15') || 0.15),
    timeoutSec: Math.max(10, parseInt(valueOf('--timeout') ?? '25', 10) || 25),
    maxSessionLoss: Math.max(1, parseFloat(valueOf('--max-session-loss') ?? '4') || 4),
    maxBookAgeMs: Math.max(300, parseInt(valueOf('--max-book-age-ms') ?? '800', 10) || 800),
    pollMs: Math.max(30, parseInt(valueOf('--poll-ms') ?? '50', 10) || 50),
    entrySlip: Math.max(0, parseFloat(valueOf('--entry-slip') ?? '0.01') || 0),
    settleMs: Math.max(200, parseInt(valueOf('--settle-ms') ?? '800', 10) || 800),
    warmSec: Math.max(3, parseInt(valueOf('--warm-sec') ?? '8', 10) || 8),
    // Preferir asks com edge de maker (não extremos 0.15 / 0.70)
    preferMinAsk: Math.max(0.15, parseFloat(valueOf('--prefer-min-ask') ?? '0.20') || 0.20),
    preferMaxAsk: Math.min(0.7, parseFloat(valueOf('--prefer-max-ask') ?? '0.55') || 0.55),
    // plumbing: entra sem impulso Binance (só book + tau)
    plumbing: !args.includes('--signal-only'),
    minTau: Math.max(10, parseInt(valueOf('--min-tau') ?? '15', 10) || 15),
    // retries incansáveis / rápidos
    makerRetries: Math.max(5, parseInt(valueOf('--maker-retries') ?? '80', 10) || 80),
    makerRetryGapMs: Math.max(20, parseInt(valueOf('--maker-retry-gap-ms') ?? '60', 10) || 60),
    dumpRetries: Math.max(5, parseInt(valueOf('--dump-retries') ?? '40', 10) || 40),
  };
}

async function cancelAll(client, label = 'cancelAll') {
  try {
    const resp = await client.cancelAll();
    console.log(`🛡 ${label}`, resp?.canceled?.length ?? 0);
  } catch (err) {
    console.log(`⚠ ${label}: ${err.message}`);
  }
}

async function cancelOrderSafe(client, orderId) {
  if (!orderId) return;
  try {
    await client.cancelOrder({ orderID: orderId });
  } catch {
    /* gone */
  }
}

async function getCondShares(client, tokenId) {
  try {
    const bal = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Number(bal?.balance || 0) / 1e6;
  } catch {
    return 0;
  }
}

async function waitMatched(client, orderId, { settleMs, settlePollMs = 50 }) {
  const deadline = Date.now() + settleMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await client.getOrder(orderId);
      const matched = Number(last?.size_matched ?? 0) || 0;
      const status = String(last?.status || '').toUpperCase();
      if (matched > 0 && (status === 'MATCHED' || matched + 1e-9 >= Number(last?.original_size || 0))) {
        return { matched, order: last };
      }
      if (status === 'CANCELED' || status === 'CANCELLED') {
        return { matched, order: last };
      }
    } catch {
      /* retry */
    }
    await sleep(settlePollMs);
  }
  return { matched: Number(last?.size_matched ?? 0) || 0, order: last };
}

async function postOrder(client, { tokenId, price, size, side, orderType, label }) {
  const px = roundPx(price);
  const sh = roundSh(size);
  const t0 = performance.now();
  try {
    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: px, side, size: sh },
      undefined,
      orderType,
      false,
      false,
    );
    const orderId = resp?.orderID || resp?.order_id || resp?.id || null;
    if (!resp?.success && !orderId) {
      return {
        ok: false,
        orderId: null,
        err: resp?.errorMsg || 'post_failed',
        ms: Math.round(performance.now() - t0),
        label,
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
      err: err.message,
      ms: Math.round(performance.now() - t0),
      label,
    };
  }
}

async function resolveFillPx(client, order, fallbackPx) {
  const tradeIds = order?.associate_trades;
  if (!Array.isArray(tradeIds) || !tradeIds.length || !client?.getTrades) return fallbackPx;
  try {
    const raw = await client.getTrades({ limit: 80 });
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
    if (qty > 0) return sum / qty;
  } catch {
    /* fallback */
  }
  return fallbackPx;
}

async function takerBuy(client, tokenId, ask, shares, opts) {
  const limit = roundPx(ask + opts.entrySlip);
  const posted = await postOrder(client, {
    tokenId,
    price: limit,
    size: shares,
    side: Side.BUY,
    orderType: OrderType.GTC,
    label: 'probe-buy',
  });
  if (!posted.ok) return { ...posted, filledSize: 0, avgPx: null };
  let matched = posted.takingAmount > 0 ? posted.takingAmount : 0;
  let settle = await waitMatched(client, posted.orderId, { settleMs: opts.settleMs });
  matched = Math.max(matched, settle.matched || 0);
  if (matched + 1e-9 < shares) {
    await cancelOrderSafe(client, posted.orderId);
    settle = await waitMatched(client, posted.orderId, { settleMs: 400 });
    matched = Math.max(matched, settle.matched || 0);
  }
  let avgPx = ask;
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
    ms: posted.ms,
    err: matched + 1e-9 < MIN_SHARES ? 'underfill' : null,
  };
}

async function restSell(client, tokenId, price, size, label) {
  return postOrder(client, {
    tokenId,
    price,
    size,
    side: Side.SELL,
    orderType: OrderType.GTC,
    label,
  });
}

async function forceDump(client, tokenId, bid, shares, opts, label) {
  let left = roundSh(shares);
  let filled = 0;
  let lastPx = Number.isFinite(bid) && bid > 0 ? bid : 0.01;
  const maxAttempts = opts.dumpRetries ?? 40;
  for (let attempt = 1; attempt <= maxAttempts && left >= 0.01; attempt++) {
    // Já vendeu?
    const bal = await getCondShares(client, tokenId);
    if (bal + 1e-9 < 0.5) {
      console.log(`  ✓ dump done (bal≈0) after ${attempt - 1} tries filled=${filled.toFixed(2)}`);
      left = 0;
      break;
    }
    left = roundSh(Math.min(left, Math.max(bal, left)));

    const px = roundPx(Math.max(0.01, lastPx - 0.05));
    let posted = await postOrder(client, {
      tokenId,
      price: px,
      size: left,
      side: Side.SELL,
      orderType: OrderType.FAK,
      label: `${label}-a${attempt}`,
    });
    if (!posted.ok) {
      posted = await postOrder(client, {
        tokenId,
        price: px,
        size: left,
        side: Side.SELL,
        orderType: OrderType.GTC,
        label: `${label}-gtc-a${attempt}`,
      });
    }
    if (posted.ok) {
      const settle = await waitMatched(client, posted.orderId, {
        settleMs: Math.min(opts.settleMs, 400),
        settlePollMs: 40,
      });
      const m = Math.max(posted.takingAmount || 0, settle.matched || 0);
      if (m > 0) {
        filled += m;
        left = roundSh(Math.max(0, left - m));
        lastPx = (await resolveFillPx(client, settle.order, lastPx)) || lastPx;
        console.log(`  dump fill #${attempt} +${m.toFixed(2)} left=${left.toFixed(2)}`);
      }
      if (String(posted.label || '').includes('gtc')) await cancelOrderSafe(client, posted.orderId);
    } else {
      const err = String(posted.err || '').toLowerCase();
      console.log(`  dump miss #${attempt}/${maxAttempts}: ${posted.err}`);
      // Shares travadas em ordem aberta → cancela e tenta de novo
      if (err.includes('matched orders') || err.includes('balance')) {
        await cancelAll(client, `dump-unlock-${attempt}`);
        await sleep(80);
      }
    }
    if (left < 0.01) break;
    lastPx = Math.max(0.01, roundPx(lastPx * 0.7));
    await sleep(Math.min(40 + attempt * 8, 120));
  }
  const ok = left < MIN_SHARES;
  if (!ok) console.log(`⛔ dump incomplete left=${left.toFixed(2)} filled=${filled.toFixed(2)}`);
  return { ok, filledSize: filled, left, avgPx: lastPx };
}

/** Espera balance CTF >= need; retorna ms até liberar. */
async function waitBalance(client, tokenId, need, maxMs = 4000) {
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < maxMs) {
    last = await getCondShares(client, tokenId);
    if (last + 1e-9 >= need) return { ok: true, ms: Date.now() - t0, bal: last };
    await sleep(80);
  }
  return { ok: false, ms: Date.now() - t0, bal: last };
}

async function listOpenSells(client, tokenId) {
  try {
    const oo = await client.getOpenOrders();
    const list = Array.isArray(oo) ? oo : oo?.data || [];
    return list.filter((o) => {
      const side = String(o.side || '').toUpperCase();
      const asset = String(o.asset_id || o.token_id || '');
      return side === 'SELL' && asset === String(tokenId);
    });
  } catch {
    return [];
  }
}

/**
 * Posta maker SELL com retries rápidos e incansáveis.
 * A cada tentativa: confere se já existe SELL resting / se já fillou / balance livre.
 */
async function postMakerWithBalanceRetry(client, tokenId, px, sh, label, opts = {}) {
  const maxAttempts = opts.makerRetries ?? 80;
  const gapMs = opts.makerRetryGapMs ?? 60;
  const t0 = Date.now();
  let lastErr = null;
  let postedIds = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1) Já temos SELL resting cobrindo?
    const opens = await listOpenSells(client, tokenId);
    for (const o of opens) {
      const id = o.id || o.orderID;
      const orig = Number(o.original_size || o.size || 0);
      const matched = Number(o.size_matched || 0);
      const rem = orig - matched;
      const status = String(o.status || '').toUpperCase();
      if (matched + 1e-9 >= sh * 0.95 || status === 'MATCHED') {
        console.log(
          `  ✓ already FILLED via open order id=${id} matched=${matched} (try ${attempt}, ${Date.now() - t0}ms)`,
        );
        return {
          ok: true,
          orderId: id,
          price: Number(o.price) || px,
          size: sh,
          attempts: attempt,
          alreadyFilled: true,
          ms: Date.now() - t0,
        };
      }
      if (rem + 1e-9 >= sh * 0.9 && Number(o.price) === px) {
        console.log(
          `  ✓ already LIVE resting id=${id} @${o.price} rem=${rem.toFixed(2)} (try ${attempt}, ${Date.now() - t0}ms)`,
        );
        return {
          ok: true,
          orderId: id,
          price: Number(o.price) || px,
          size: sh,
          attempts: attempt,
          alreadyLive: true,
          ms: Date.now() - t0,
        };
      }
    }

    // 2) Inventário sumiu (= fill externo / dump)
    const bal = await getCondShares(client, tokenId);
    if (bal + 1e-9 < 0.5) {
      console.log(`  ✓ inventory gone bal=${bal.toFixed(4)} (try ${attempt}) — treat as filled`);
      return {
        ok: true,
        orderId: postedIds[postedIds.length - 1] || null,
        price: px,
        size: sh,
        attempts: attempt,
        inventoryGone: true,
        ms: Date.now() - t0,
      };
    }

    // 3) Posta
    const r = await restSell(client, tokenId, px, sh, `${label}-t${attempt}`);
    if (r.ok) {
      postedIds.push(r.orderId);
      console.log(
        `  ✓ maker POSTED @${px} id=${r.orderId} try=${attempt}/${maxAttempts} elapsed=${Date.now() - t0}ms`,
      );
      return { ...r, attempts: attempt, ms: Date.now() - t0 };
    }

    lastErr = r.err;
    const err = String(r.err || '').toLowerCase();
    const isBal =
      err.includes('balance') || err.includes('allowance') || err.includes('insufficient');
    if (!isBal) {
      console.log(`  ✗ maker hard-fail try=${attempt}: ${r.err}`);
      // ainda assim: se for rate limit / transient, continua um pouco
      if (!err.includes('rate') && !err.includes('timeout') && !err.includes('503') && !err.includes('429')) {
        return { ...r, attempts: attempt, ms: Date.now() - t0 };
      }
    }

    if (attempt === 1 || attempt % 5 === 0 || attempt === maxAttempts) {
      console.log(
        `  ⏳ maker retry ${attempt}/${maxAttempts} bal=${bal.toFixed(2)} opens=${opens.length} err=${r.err}`,
      );
    }
    await sleep(gapMs);
  }

  return {
    ok: false,
    err: lastErr || 'balance_retries_exhausted',
    attempts: maxAttempts,
    ms: Date.now() - t0,
  };
}

function tokenFor(event, side) {
  return side === 'UP' ? event.upTokenId : event.downTokenId;
}

/** Entrada plumbing: sem impulso — pega o lado com ask negociável e size suficiente. */
function pickPlumbingEntry(state, opts, tau) {
  if (tau < opts.minTau) return null;
  const cands = [];
  for (const side of ['UP', 'DOWN']) {
    const b = state[side === 'UP' ? 'up' : 'down'];
    const ask = Number(b?.bestAsk);
    const bid = Number(b?.bestBid);
    const topAskSz = Number(b?.asks?.[0]?.size);
    const askSz = Number.isFinite(topAskSz) ? topAskSz : Infinity;
    if (!Number.isFinite(ask) || !Number.isFinite(bid)) continue;
    if (ask < opts.preferMinAsk || ask > opts.preferMaxAsk) continue;
    if (ask - bid > 0.06) continue;
    if (askSz + 1e-9 < opts.shares * 0.9) continue;
    // score: mais perto de 0.40 = melhor R:R para maker +offset
    const score = -Math.abs(ask - 0.4) + (Number.isFinite(bid) ? bid * 0.05 : 0);
    cands.push({ side, ask, bid, askSz, score });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  return {
    action: 'enter',
    side: best.side,
    ask: best.ask,
    bid: best.bid,
    binRet: 0,
    impulseMin: 0,
    tau,
    plumbing: true,
  };
}

function pushMids(midRing, state, now) {
  for (const side of ['UP', 'DOWN']) {
    const b = state[side === 'UP' ? 'up' : 'down'];
    if (Number.isFinite(b?.bestAsk) && Number.isFinite(b?.bestBid)) {
      pushMid(midRing, now, side, (b.bestAsk + b.bestBid) / 2);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const params = {
    ...VARIANT_E_ADAPT,
    // tryEntry usa budget/ask só p/ checar ASK_SIZE; compra real = opts.shares
    budget: opts.shares * 0.4,
    rescue: true,
    rescueOffset: 0.01,
    rescueStop: opts.rescueStop,
    stopLoss: opts.stopLoss,
    timeoutSec: opts.timeoutSec,
    maxTradesPerEvent: opts.maxTrades,
    maxBookAgeMs: opts.maxBookAgeMs,
    minTau: opts.minTau,
  };

  console.log('=== Probe micro LIVE (plumbing — retries incansáveis) ===');
  console.log(
    `shares=${opts.shares} maxTrades=${opts.maxTrades} maker=+${opts.makerOffset}` +
      ` stop=-${opts.stopLoss} rescueStop=-${opts.rescueStop} timeout=${opts.timeoutSec}s` +
      ` bookAge≤${opts.maxBookAgeMs}ms preferAsk=${opts.preferMinAsk}–${opts.preferMaxAsk}` +
      ` plumbing=${opts.plumbing} minTau=${opts.minTau}` +
      ` makerRetries=${opts.makerRetries}×${opts.makerRetryGapMs}ms dumpRetries=${opts.dumpRetries}` +
      ` sessionLoss≤$${opts.maxSessionLoss}`,
  );

  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });
  console.log('signer', wallet.address);
  await cancelAll(client, 'preflight');

  const state = createMarketState();
  const clobFeed = createClobFeed(state, {
    onStale: (reason, lagMs) => {
      console.log(`⚠ clob stale ${reason} lag=${Math.round(lagMs)}`);
    },
  });
  const stopBinance = startBinanceSpotFeed(state);
  const spotRing = createSpotRing(spotRingSecsFor(params));
  const midRing = createMidRing(12);

  const liveRisk = { tokenId: null, shares: 0, side: null };

  const onSig = async (sig) => {
    console.log(`\n⚠ ${sig} — flatten`);
    await cancelAll(client, sig);
    if (liveRisk.tokenId && liveRisk.shares >= 0.5) {
      await forceDump(client, liveRisk.tokenId, 0.01, liveRisk.shares, opts, `sig-${sig}`);
    }
    try {
      clobFeed.stop?.();
    } catch {
      /* */
    }
    try {
      stopBinance?.();
    } catch {
      /* */
    }
    process.exit(130);
  };
  process.on('SIGINT', () => void onSig('SIGINT'));
  process.on('SIGTERM', () => void onSig('SIGTERM'));

  console.log(`warming Binance (~${opts.warmSec}s)…`);
  const warmDeadline = Date.now() + opts.warmSec * 1000;
  while (Date.now() < warmDeadline) {
    if (state.binance != null) pushSpot(spotRing, Date.now(), state.binance);
    await sleep(100);
  }
  console.log(`warm samples=${spotRing.pts.length} bn=${state.binance}`);

  let sessionPnl = 0;
  let tradesDone = 0;
  const results = [];

  while (tradesDone < opts.maxTrades && sessionPnl > -opts.maxSessionLoss) {
    const event = await findActiveBtc5mEvent();
    if (!event?.upTokenId) {
      console.log('waiting event…');
      await sleep(2000);
      continue;
    }
    const endMs =
      event.eventEnd instanceof Date
        ? event.eventEnd.getTime()
        : Number(event.eventEndMs ?? Date.now() + 300_000);
    const tau0 = Math.floor((endMs - Date.now()) / 1000);
    if (tau0 < params.minTau) {
      console.log(`tau=${tau0} low — wait next`);
      await sleep(3000);
      continue;
    }

    clobFeed.subscribe(event.upTokenId, event.downTokenId);
    await clobFeed.refreshBooks();
    const st = createEventState({ ...params });
    console.log(`\n--- trade ${tradesDone + 1}/${opts.maxTrades} event=${event.slug} tau≈${tau0}s ---`);

    let entered = false;
    const deadline = Date.now() + Math.min(tau0 - 5, 240) * 1000;
    let lastHb = 0;

    while (Date.now() < deadline && !entered) {
      const now = Date.now();
      const tau = Math.floor((endMs - now) / 1000);
      if (tau < params.minTau) break;

      if (state.binance != null) pushSpot(spotRing, now, state.binance);
      pushMids(midRing, state, now);

      const lag = clobFeed.lagMs();
      const bookFresh = Number.isFinite(lag) && lag <= opts.maxBookAgeMs;
      if (!bookFresh) {
        if (now - lastHb >= 3000) {
          lastHb = now;
          await clobFeed.refreshBooks();
        }
        await sleep(opts.pollMs);
        continue;
      }

      if (now - lastHb >= 5000) {
        lastHb = now;
        const thr = impulseThreshold(spotRing, now, params);
        console.log(
          `… hb tau=${tau} up=${state.up.bestAsk}/${state.up.bestBid}` +
            ` dn=${state.down.bestAsk}/${state.down.bestBid}` +
            ` bn=${state.binance} thr=${thr.toFixed(2)} lag=${Math.round(lag)}`,
        );
      }

      const book = { UP: state.up, DOWN: state.down };
      let intent = null;
      if (opts.plumbing) {
        intent = pickPlumbingEntry(state, opts, tau);
      } else {
        const spotAgeMs =
          state.binanceReceivedAt != null ? now - state.binanceReceivedAt : null;
        intent = tryEntry(st, {
          spotRing,
          midRing,
          book,
          tau,
          nowMs: now,
          spotAgeMs,
          bookAgeMs: lag,
        });
        if (intent?.action === 'enter') {
          if (intent.ask < opts.preferMinAsk || intent.ask > opts.preferMaxAsk) {
            console.log(
              `skip ask=${intent.ask} fora prefer ${opts.preferMinAsk}–${opts.preferMaxAsk}`,
            );
            intent = null;
          }
        }
      }

      if (intent?.action !== 'enter') {
        await sleep(opts.pollMs);
        continue;
      }

      console.log(
        `ENTER intent ${intent.side} ask=${intent.ask} ` +
          `${intent.plumbing ? 'plumbing' : `binRet=${intent.binRet} thr=${intent.impulseMin}`}` +
          ` τ=${intent.tau}`,
      );

      const tokenId = tokenFor(event, intent.side);
      const buy = await takerBuy(client, tokenId, intent.ask, opts.shares, opts);
      if (!buy.ok) {
        console.log(`ENTER aborted ${buy.err} filled=${buy.filledSize || 0}`);
        if (buy.filledSize > 0.01) {
          const bid = intent.side === 'UP' ? state.up.bestBid : state.down.bestBid;
          await forceDump(client, tokenId, bid, buy.filledSize, opts, 'dust');
        }
        await sleep(1500);
        continue;
      }

      entered = true;
      const entryPx = buy.avgPx || intent.ask;
      const sh = roundSh(buy.filledSize);
      liveRisk.tokenId = tokenId;
      liveRisk.shares = sh;
      liveRisk.side = intent.side;
      const entryFee = feeEst(entryPx, sh, params.feeRate);
      console.log(
        `ENTER fill ${intent.side} @${entryPx.toFixed(4)} sh=${sh} fee≈${entryFee.toFixed(3)} ms=${buy.ms}`,
      );

      // Medir CTF
      const balWait = await waitBalance(client, tokenId, sh * 0.95, 4000);
      console.log(
        `CTF balance wait ms=${balWait.ms} ok=${balWait.ok} bal=${balWait.bal.toFixed(4)}`,
      );

      const makerPx = roundPx(entryPx + opts.makerOffset);
      const maker = await postMakerWithBalanceRetry(
        client,
        tokenId,
        makerPx,
        sh,
        'probe-maker',
        opts,
      );
      if (!maker.ok) {
        console.log(`⚠ maker fail: ${maker.err} — dump`);
        const bid = intent.side === 'UP' ? state.up.bestBid : state.down.bestBid;
        const dump = await forceDump(client, tokenId, bid, sh, opts, 'maker-fail');
        const pnl =
          (dump.avgPx || 0) * dump.filledSize - entryPx * sh - entryFee;
        sessionPnl += pnl;
        results.push({
          reason: 'maker_fail_dump',
          side: intent.side,
          entry: entryPx,
          exit: dump.avgPx,
          pnl,
          ctfMs: balWait.ms,
        });
        liveRisk.shares = 0;
        tradesDone += 1;
        console.log(`RESULT maker_fail pnl=${pnl.toFixed(3)} session=${sessionPnl.toFixed(3)}`);
        break;
      }

      console.log(
        `MAKER rest SELL @${makerPx} sh=${sh} id=${maker.orderId} attempts=${maker.attempts}`,
      );

      // Gerenciar até fill / stop / timeout / rescueStop
      const entryTs = Date.now();
      let closed = null;
      let makerOrderId = maker.orderId;
      let inRescue = false;
      let rescueOrderId = null;

      while (Date.now() < endMs - 3000) {
        await sleep(400);
        const sideKey = intent.side === 'UP' ? 'up' : 'down';
        const bid = Number(state[sideKey]?.bestBid);
        const hold = (Date.now() - entryTs) / 1000;

        // sync maker fill
        const oid = inRescue ? rescueOrderId : makerOrderId;
        if (oid) {
          try {
            const o = await client.getOrder(oid);
            const matched = Number(o?.size_matched ?? 0) || 0;
            if (matched + 1e-9 >= sh * 0.95) {
              const exitPx = await resolveFillPx(client, o, inRescue ? entryPx + 0.01 : makerPx);
              const exitFee = feeEst(exitPx, sh, params.feeRate);
              const pnl = exitPx * sh - entryPx * sh - entryFee - exitFee;
              closed = {
                reason: inRescue ? 'rescue_full' : 'maker_full',
                exitPx,
                pnl,
              };
              break;
            }
          } catch {
            /* */
          }
        }

        if (!inRescue && Number.isFinite(bid) && bid > 0 && bid <= entryPx - opts.stopLoss) {
          console.log(`STOP hit bid=${bid} — cancel maker → rescue @+1¢`);
          await cancelOrderSafe(client, makerOrderId);
          await cancelAll(client, 'pre-rescue');
          const rPx = roundPx(entryPx + 0.01);
          const r = await postMakerWithBalanceRetry(client, tokenId, rPx, sh, 'rescue', opts);
          if (r.ok) {
            inRescue = true;
            rescueOrderId = r.orderId;
            console.log(`RESCUE ask=${rPx} id=${r.orderId}`);
          } else {
            console.log(`RESCUE fail — dump`);
            const dump = await forceDump(client, tokenId, bid, sh, opts, 'stop-dump');
            const exitFee = feeEst(dump.avgPx || bid, dump.filledSize, params.feeRate);
            const pnl =
              (dump.avgPx || bid) * dump.filledSize - entryPx * sh - entryFee - exitFee;
            closed = { reason: 'stop_dump', exitPx: dump.avgPx || bid, pnl };
            break;
          }
        }

        if (
          inRescue &&
          Number.isFinite(bid) &&
          bid > 0 &&
          bid <= entryPx - opts.rescueStop
        ) {
          console.log(`RESCUE_STOP bid=${bid} — dump`);
          await cancelOrderSafe(client, rescueOrderId);
          await cancelAll(client, 'pre-rescue-stop');
          const dump = await forceDump(client, tokenId, bid, sh, opts, 'rescue-stop');
          const exitFee = feeEst(dump.avgPx || bid, dump.filledSize, params.feeRate);
          const pnl =
            (dump.avgPx || bid) * dump.filledSize - entryPx * sh - entryFee - exitFee;
          closed = { reason: 'rescue_stop', exitPx: dump.avgPx || bid, pnl };
          break;
        }

        if (!inRescue && hold >= opts.timeoutSec) {
          console.log(`TIMEOUT ${hold.toFixed(1)}s — rescue`);
          await cancelOrderSafe(client, makerOrderId);
          await cancelAll(client, 'pre-timeout-rescue');
          const rPx = roundPx(entryPx + 0.01);
          const r = await postMakerWithBalanceRetry(client, tokenId, rPx, sh, 'rescue-to', opts);
          if (r.ok) {
            inRescue = true;
            rescueOrderId = r.orderId;
            console.log(`RESCUE ask=${rPx} id=${r.orderId}`);
          } else {
            const dump = await forceDump(client, tokenId, bid || 0.01, sh, opts, 'timeout-dump');
            const pnl = (dump.avgPx || 0) * dump.filledSize - entryPx * sh - entryFee;
            closed = { reason: 'timeout_dump', exitPx: dump.avgPx, pnl };
            break;
          }
        }

        if (Date.now() - lastHb >= 5000) {
          lastHb = Date.now();
          console.log(
            `… pos ${intent.side}@${entryPx}${inRescue ? '/R' : ''} bid=${bid} hold=${hold.toFixed(0)}s`,
          );
        }
      }

      if (!closed) {
        // EOD: cancel + dump residual
        await cancelOrderSafe(client, makerOrderId);
        await cancelOrderSafe(client, rescueOrderId);
        await cancelAll(client, 'eod');
        const rem = await getCondShares(client, tokenId);
        const sideKey = intent.side === 'UP' ? 'up' : 'down';
        const bid = Number(state[sideKey]?.bestBid) || 0.01;
        if (rem >= 0.5) {
          const dump = await forceDump(client, tokenId, bid, rem, opts, 'eod-dump');
          const pnl = (dump.avgPx || 0) * dump.filledSize - entryPx * sh - entryFee;
          closed = { reason: 'eod_dump', exitPx: dump.avgPx, pnl };
        } else {
          // provavelmente redeem 0 ou 1 — assume 0 se não vendeu
          closed = { reason: 'eod_zero', exitPx: 0, pnl: -entryPx * sh - entryFee };
        }
      }

      sessionPnl += closed.pnl;
      results.push({
        ...closed,
        side: intent.side,
        entry: entryPx,
        sh,
        ctfMs: balWait.ms,
        makerAttempts: maker.attempts,
      });
      liveRisk.shares = 0;
      tradesDone += 1;
      console.log(
        `RESULT ${closed.reason} ${intent.side} entry=${entryPx} exit≈${closed.exitPx}` +
          ` pnl=${closed.pnl.toFixed(3)} session=${sessionPnl.toFixed(3)} ctfMs=${balWait.ms}`,
      );
    }

    if (!entered) {
      console.log('no entry this window — next');
      await sleep(2000);
    }
  }

  await cancelAll(client, 'shutdown');
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ sessionPnl, tradesDone, results }, null, 2));
  try {
    clobFeed.stop?.();
  } catch {
    /* */
  }
  try {
    stopBinance?.();
  } catch {
    /* */
  }
  process.exit(sessionPnl < 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
