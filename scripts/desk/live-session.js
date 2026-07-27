#!/usr/bin/env node
/**
 * Desk discricionário BTC 5m — observa em loop e gerencia posição ao vivo.
 *
 * Uso:
 *   node scripts/desk/live-session.js              # só observa
 *   node scripts/desk/live-session.js --live       # observa + entra/sai com dinheiro real
 *   node scripts/desk/live-session.js --live --windows 2
 *
 * Regras de gestão (não é estratégia fixa de entrada — só risco):
 *   - size mínimo 5 shares, notional ~$2–4
 *   - se o delta BTC-PTB virar contra a tese com velocidade, vende (exit)
 *   - se o ask do lado contrário comprimir o cushion, vende
 *   - não deixa posição ir a settlement “no escuro”
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const WINDOWS = Math.max(1, parseInt(args.find((a) => a.startsWith('--windows='))?.split('=')[1] ?? '1', 10));
const POLL_MS = 500;
const LOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.live-session.lock');

function acquireSingletonLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      try {
        process.kill(prev.pid, 0);
        console.error(`[desk] BLOQUEADO: já existe desk rodando (pid=${prev.pid} live=${prev.live}). Mate-o antes.`);
        process.exit(2);
      } catch {
        /* stale lock */
      }
    }
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, live: LIVE, startedAt: new Date().toISOString() }));
    const release = () => {
      try {
        if (fs.existsSync(LOCK_PATH)) {
          const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
          if (cur.pid === process.pid) fs.unlinkSync(LOCK_PATH);
        }
      } catch {
        /* ignore */
      }
    };
    process.on('exit', release);
    process.on('SIGINT', () => {
      release();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      release();
      process.exit(143);
    });
  } catch (err) {
    console.error('[desk] falha no lock:', err.message);
    process.exit(1);
  }
}

const ENTRY_MAX_ASK = 0.55;
const CONVICTION_MAX_ASK = 0.58;
const MOMENTUM_MAX_ASK = 0.52;
const MIN_CUSHION_USD = 40;
const CONVICTION_CUSHION = 55;
const EARLY_CUSHION = 999; // recovery: desliga EARLY
const EARLY_MAX_ASK = 0.50;
const MOMENTUM_MIN_CUSHION = 45;
const MOMENTUM_VEL = 20;
const EXIT_CUSHION_USD = 18;
const TAKE_PROFIT_TICKS = 0.10;
const ENTRY_SECS_MIN = 45;
const ENTRY_SECS_MAX = 240;
const EXIT_SECS_FLOOR = 8;
const SNIPE_SECS_MAX = 25;
const SNIPE_MIN_DELTA = 40;
const SNIPE_MAX_ASK = 0.96;
const CHOP_RANGE_MAX = 12;
const CHOP_MAX_ABS_DELTA = 25;
const CTX_LOG_EVERY_MS = 10_000;
const MAX_LOSSES_PAUSE = 2;
const SESSION_MAX_LOSS_USD = 6; // circuit breaker: para se perder +$6 nesta sessão
const SIZE = 5;
const MAX_NOTIONAL = 2.2;

/** Ask máximo justo dado o cushion — escala com delta forte. */
function maxFairAsk(deltaAbs) {
  if (deltaAbs >= CONVICTION_CUSHION) return CONVICTION_MAX_ASK;
  if (deltaAbs >= MIN_CUSHION_USD) return ENTRY_MAX_ASK;
  const fair = 0.5 + Math.min(deltaAbs / 70, 0.1);
  return Math.min(EARLY_MAX_ASK, +fair.toFixed(2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bestLevels(book) {
  const bids = (book?.bids || [])
    .map((x) => ({ price: +x.price, size: +x.size }))
    .filter((x) => x.price > 0)
    .sort((a, b) => b.price - a.price);
  const asks = (book?.asks || [])
    .map((x) => ({ price: +x.price, size: +x.size }))
    .filter((x) => x.price > 0)
    .sort((a, b) => a.price - b.price);
  const depthBid = bids.slice(0, 3).reduce((s, x) => s + x.size * x.price, 0);
  const depthAsk = asks.slice(0, 3).reduce((s, x) => s + x.size * x.price, 0);
  return {
    bid: bids[0] || null,
    ask: asks[0] || null,
    depthBidUsd: +depthBid.toFixed(2),
    depthAskUsd: +depthAsk.toFixed(2),
  };
}

function tickPrice(p, dir = 0) {
  const x = Math.round(p * 100) / 100;
  if (dir > 0) return Math.min(0.99, Math.round((x + 0.01) * 100) / 100);
  if (dir < 0) return Math.max(0.01, Math.round((x - 0.01) * 100) / 100);
  return x;
}

/** Média de prob DOWN nos 5m de ETH/SOL/XRP (sentimento cross-asset). */
async function fetchAltBias(slotTs) {
  const syms = ['eth', 'sol', 'xrp'];
  const downs = [];
  for (const sym of syms) {
    try {
      const url = `https://gamma-api.polymarket.com/events?slug=${sym}-updown-5m-${slotTs}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const events = await res.json();
      const prices = JSON.parse(events?.[0]?.markets?.[0]?.outcomePrices || '[]');
      if (prices[1] != null) downs.push(parseFloat(prices[1]));
    } catch {
      /* ignore */
    }
  }
  if (!downs.length) return null;
  const avgDown = downs.reduce((a, b) => a + b, 0) / downs.length;
  return { avgDown: +avgDown.toFixed(3), n: downs.length };
}

/** Janela anterior: preço gamma indica quem ganhou. */
async function fetchPrevWindowBias(slotTs) {
  const prev = slotTs - 300;
  try {
    const url = `https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${prev}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const events = await res.json();
    const prices = JSON.parse(events?.[0]?.markets?.[0]?.outcomePrices || '[]');
    const up = parseFloat(prices[0]);
    const down = parseFloat(prices[1]);
    if (!Number.isFinite(up)) return null;
    return up >= 0.9 ? 'prevUP' : down >= 0.9 ? 'prevDOWN' : 'prevMIXED';
  } catch {
    return null;
  }
}

function detectChop(hist, n = 16) {
  const slice = hist.slice(-n).map((h) => h.delta).filter(Number.isFinite);
  if (slice.length < 6) return { chop: false, range: 0 };
  const range = Math.max(...slice) - Math.min(...slice);
  const maxAbs = Math.max(...slice.map((d) => Math.abs(d)));
  // chop = lateral perto do PTB; tendência forte (|Δ|≥20) nunca é chop
  const chop = range < CHOP_RANGE_MAX && maxAbs < CHOP_MAX_ABS_DELTA;
  return { chop, range: +range.toFixed(1), maxAbs: +maxAbs.toFixed(1) };
}

function qualityBlockers(snap, hist, ctx) {
  const analysis = analyzeContext(snap, hist, ctx);
  const blockers = [];
  const absD = Math.abs(snap.delta);
  if (analysis.chop.chop) blockers.push(`chop Δ±${analysis.chop.range}`);
  // bounce/pullback só bloqueia se delta fraco
  if (absD < CONVICTION_CUSHION) {
    if (ctx.prevBias === 'prevDOWN' && snap.delta > 0) blockers.push('bounce pós-DOWN — não perseguir');
    if (ctx.prevBias === 'prevUP' && snap.delta < 0) blockers.push('pullback pós-UP — não perseguir');
  }
  return { blockers, analysis };
}

function passesGates(side, snap, hist, ctx, askPrice) {
  const { blockers, analysis } = qualityBlockers(snap, hist, ctx);
  if (blockers.length) return { ok: false, reason: blockers.join(' · ') };

  const delta = snap.delta;
  const deltaAbs = Math.abs(delta);
  const fairCap = maxFairAsk(deltaAbs);
  if (askPrice > fairCap) {
    return { ok: false, reason: `ask ${askPrice} > fair ${fairCap} (Δ=${deltaAbs.toFixed(0)})` };
  }

  const depth = analysis.depth;
  if (side === 'UP' && depth.upPct < 54) {
    return { ok: false, reason: `book não confirma UP (${depth.upPct}% ask depth)` };
  }
  if (side === 'DOWN' && depth.downPct < 54) {
    return { ok: false, reason: `book não confirma DOWN (${depth.downPct}% ask depth)` };
  }

  // delta sustentado: últimos 6 ticks na mesma direção
  const recent = hist.slice(-6).map((h) => h.delta).filter(Number.isFinite);
  if (recent.length >= 4) {
    if (side === 'UP' && recent.filter((d) => d >= MIN_CUSHION_USD * 0.6).length < 3) {
      return { ok: false, reason: 'delta UP não sustentado' };
    }
    if (side === 'DOWN' && recent.filter((d) => d <= -MIN_CUSHION_USD * 0.6).length < 3) {
      return { ok: false, reason: 'delta DOWN não sustentado' };
    }
  }

  return { ok: true, analysis };
}

function depthBias(up, down) {
  const upAsk = up.depthAskUsd || 0;
  const dnAsk = down.depthAskUsd || 0;
  const total = upAsk + dnAsk || 1;
  return {
    downPct: +((dnAsk / total) * 100).toFixed(0),
    upPct: +((upAsk / total) * 100).toFixed(0),
  };
}

/** Leitura qualitativa — complementa thresholds numéricos. */
function analyzeContext(snap, hist, ctx) {
  const { delta, up, down, secsLeft } = snap;
  const chop = detectChop(hist);
  const depth = depthBias(up, down);
  const notes = [];

  if (chop.chop) notes.push(`chop Δ±${chop.range}`);
  if (ctx.altBias?.avgDown >= 0.58) notes.push(`alts bearish dn=${(ctx.altBias.avgDown * 100).toFixed(0)}%`);
  else if (ctx.altBias?.avgDown <= 0.42) notes.push(`alts bullish up=${((1 - ctx.altBias.avgDown) * 100).toFixed(0)}%`);
  if (ctx.prevBias === 'prevUP' && delta < 0) notes.push('pullback pós-UP anterior');
  if (ctx.prevBias === 'prevDOWN' && delta > 0) notes.push('bounce pós-DOWN anterior');
  if (depth.downPct >= 58) notes.push(`book inclina DOWN (${depth.downPct}% ask depth)`);
  if (depth.upPct >= 58) notes.push(`book inclina UP (${depth.upPct}% ask depth)`);
  if (secsLeft > ENTRY_SECS_MAX) notes.push(`observando abertura (${secsLeft.toFixed(0)}s rest)`);

  let lean = 'NEUTRO';
  if (delta <= -14 && !chop.chop && depth.downPct >= 52) lean = 'DOWN';
  else if (delta >= 14 && !chop.chop && depth.upPct >= 52) lean = 'UP';
  else if (chop.chop) lean = 'CHOP — não forçar';

  return { lean, notes: notes.join(' · ') || 'sem sinal claro', chop, depth };
}

function decide(snap, hist, ctx = {}, session = {}) {
  const { secsLeft, delta, up, down } = snap;
  if (!Number.isFinite(delta) || !up.ask || !down.ask) {
    return { action: 'wait', reason: 'feed incompleto' };
  }

  if (session.consecutiveLosses >= MAX_LOSSES_PAUSE) {
    return { action: 'wait', reason: `pausa: ${session.consecutiveLosses} perdas seguidas — só observa` };
  }
  if (session.realizedPnl <= -SESSION_MAX_LOSS_USD) {
    return { action: 'wait', reason: `circuit breaker: sessão ${session.realizedPnl.toFixed(2)} USD — stop` };
  }

  // LOCK/SNIPE: últimos segundos — delta forte, compra lado vencedor
  if (!Number.isNaN(secsLeft) && secsLeft <= SNIPE_SECS_MAX && secsLeft > EXIT_SECS_FLOOR) {
    if (delta >= SNIPE_MIN_DELTA && up.ask.price >= 0.85 && up.ask.price <= SNIPE_MAX_ASK) {
      return {
        action: 'enter',
        side: 'UP',
        reason: `LOCK delta=+${delta.toFixed(1)} upAsk=${up.ask.price} t-${secsLeft.toFixed(0)}s`,
        skipGates: true,
      };
    }
    if (delta <= -SNIPE_MIN_DELTA && down.ask.price >= 0.85 && down.ask.price <= SNIPE_MAX_ASK) {
      return {
        action: 'enter',
        side: 'DOWN',
        reason: `LOCK delta=${delta.toFixed(1)} dnAsk=${down.ask.price} t-${secsLeft.toFixed(0)}s`,
        skipGates: true,
      };
    }
    if (delta >= SNIPE_MIN_DELTA && up.ask.price <= 0.25) {
      return {
        action: 'enter',
        side: 'UP',
        reason: `SNIPE delta=+${delta.toFixed(1)} upAsk=${up.ask.price} t-${secsLeft.toFixed(0)}s`,
        skipGates: true,
      };
    }
    if (delta <= -SNIPE_MIN_DELTA && down.ask.price <= 0.25) {
      return {
        action: 'enter',
        side: 'DOWN',
        reason: `SNIPE delta=${delta.toFixed(1)} dnAsk=${down.ask.price} t-${secsLeft.toFixed(0)}s`,
        skipGates: true,
      };
    }
  }

  if (secsLeft < ENTRY_SECS_MIN || secsLeft > ENTRY_SECS_MAX) {
    return { action: 'wait', reason: `secs=${secsLeft.toFixed(0)} fora da janela de entrada` };
  }

  const vel =
    hist.length >= 4
      ? delta - hist[hist.length - 4].delta
      : 0;

  const { blockers, analysis } = qualityBlockers(snap, hist, ctx);
  if (blockers.length) {
    return { action: 'wait', reason: blockers.join(' · ') };
  }

  // Momentum: move rápido + ask ainda barato
  if (delta >= MOMENTUM_MIN_CUSHION && vel >= MOMENTUM_VEL && up.ask.price <= MOMENTUM_MAX_ASK) {
    const gate = passesGates('UP', snap, hist, ctx, up.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'UP',
        reason: `MOMENTUM delta=+${delta.toFixed(1)} vel=+${vel.toFixed(1)} upAsk=${up.ask.price}`,
      };
    }
  }
  if (delta <= -MOMENTUM_MIN_CUSHION && vel <= -MOMENTUM_VEL && down.ask.price <= MOMENTUM_MAX_ASK) {
    const gate = passesGates('DOWN', snap, hist, ctx, down.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'DOWN',
        reason: `MOMENTUM delta=${delta.toFixed(1)} vel=${vel.toFixed(1)} downAsk=${down.ask.price}`,
      };
    }
  }

  // Entrada cedo: ask barato + delta moderado + book confirma
  if (delta >= EARLY_CUSHION && up.ask.price <= EARLY_MAX_ASK && vel >= 2) {
    const gate = passesGates('UP', snap, hist, ctx, up.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'UP',
        reason: `EARLY delta=+${delta.toFixed(1)} vel=+${vel.toFixed(1)} upAsk=${up.ask.price}`,
      };
    }
  }
  if (delta <= -EARLY_CUSHION && down.ask.price <= EARLY_MAX_ASK && vel <= -2) {
    const gate = passesGates('DOWN', snap, hist, ctx, down.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'DOWN',
        reason: `EARLY delta=${delta.toFixed(1)} vel=${vel.toFixed(1)} dnAsk=${down.ask.price}`,
      };
    }
  }

  // Entrada principal: cushion forte + ask justo + book alinhado
  if (delta >= MIN_CUSHION_USD && up.ask.price <= ENTRY_MAX_ASK && vel >= 0) {
    const gate = passesGates('UP', snap, hist, ctx, up.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'UP',
        reason: `delta=+${delta.toFixed(1)} vel=${vel.toFixed(1)} upAsk=${up.ask.price}`,
      };
    }
    return { action: 'wait', reason: gate.reason };
  }
  if (delta <= -MIN_CUSHION_USD && down.ask.price <= ENTRY_MAX_ASK && vel <= 0) {
    const gate = passesGates('DOWN', snap, hist, ctx, down.ask.price);
    if (gate.ok) {
      return {
        action: 'enter',
        side: 'DOWN',
        reason: `delta=${delta.toFixed(1)} vel=${vel.toFixed(1)} downAsk=${down.ask.price}`,
      };
    }
    return { action: 'wait', reason: gate.reason };
  }

  return {
    action: 'wait',
    reason: `${analysis.lean}: ${analysis.notes || `delta=${delta.toFixed(1)} vel=${vel.toFixed(1)}`}`,
  };
}

function shouldExit(pos, snap, hist) {
  const { secsLeft, delta, up, down } = snap;
  if (!pos) return null;
  const isSnipe = pos.reason?.startsWith('SNIPE') || pos.reason?.startsWith('LOCK');
  if (secsLeft <= EXIT_SECS_FLOOR && isSnipe) return null;

  const vel =
    hist.length >= 4
      ? delta - hist[hist.length - 4].delta
      : 0;

  const bid = pos.side === 'UP' ? up.bid : down.bid;
  if (bid && pos.entry && bid.price >= pos.entry + TAKE_PROFIT_TICKS) {
    return { reason: `take profit bid=${bid.price} entry=${pos.entry}` };
  }

  if (pos.side === 'DOWN') {
    if (delta > -EXIT_CUSHION_USD) {
      return { reason: `cushion DOWN erodiu delta=${delta.toFixed(1)}` };
    }
    if (vel > 8) {
      return { reason: `velocidade adversa +${vel.toFixed(1)} em ~3s` };
    }
    if (up.ask && up.ask.price >= 0.48 && delta > -MIN_CUSHION_USD) {
      return { reason: `book precifica reclaim upAsk=${up.ask.price}` };
    }
  }
  if (pos.side === 'UP') {
    if (delta < EXIT_CUSHION_USD) {
      return { reason: `cushion UP erodiu delta=${delta.toFixed(1)}` };
    }
    if (vel < -8) {
      return { reason: `velocidade adversa ${vel.toFixed(1)} em ~3s` };
    }
    if (down.ask && down.ask.price >= 0.48 && delta < MIN_CUSHION_USD) {
      return { reason: `book precifica dump downAsk=${down.ask.price}` };
    }
  }

  // perto do fim sem snipe: realiza se bid > entry ou cushion fraco
  if (secsLeft <= 45 && !isSnipe && bid && pos.entry) {
    if (bid.price >= pos.entry) {
      return { reason: `realiza antes settle bid=${bid.price}` };
    }
    if (Math.abs(delta) < EXIT_CUSHION_USD) {
      return { reason: `corta antes settle delta=${delta.toFixed(1)}` };
    }
  }

  return null;
}

async function buySide(client, tokenId, askPrice) {
  const price = tickPrice(askPrice, +1);
  let size = Math.max(SIZE, Math.ceil(1.05 / price));
  if (price * size > MAX_NOTIONAL) size = Math.max(SIZE, Math.floor(MAX_NOTIONAL / price));
  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.BUY, size },
    undefined,
    OrderType.GTC,
    false,
    false,
  );
  return { resp, price, size };
}

async function sellSide(client, tokenId, bidPrice, size) {
  const price = tickPrice(bidPrice, -1);
  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.SELL, size },
    undefined,
    OrderType.GTC,
    false,
    false,
  );
  return { resp, price, size };
}

function logLine(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${tag} ${msg}`);
}

async function runWindow(client, windowIdx, session) {
  const state = createMarketState();
  let event = await findActiveBtc5mEvent();
  if (!event) {
    logLine('WAIT', 'aguardando evento BTC 5m…');
    for (let i = 0; i < 40 && !event; i++) {
      await sleep(500);
      event = await findActiveBtc5mEvent();
    }
  }
  if (!event) throw new Error('sem evento BTC 5m');

  // PTB às vezes demora alguns segundos no começo da janela — retenta.
  for (let attempt = 0; attempt < 12 && state.priceToBeat == null; attempt++) {
    state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
    if (state.priceToBeat == null) {
      logLine('PTB', `ainda null, retry ${attempt + 1}/12`);
      await sleep(1000);
    }
  }
  const stopRtds = startRtdsFeed(state);
  const clob = createClobFeed(state);
  clob.subscribe(event.upTokenId, event.downTokenId);

  logLine(
    'WIN',
    `#${windowIdx} ${event.title} | PTB=${state.priceToBeat} | live=${LIVE}`,
  );
  if (state.priceToBeat == null) {
    logLine('WARN', 'PTB indisponível — só observa, sem entrada');
  }

  const hist = [];
  let pos = null;
  let enteredThisWindow = false;
  let done = false;
  let lastCtxLog = 0;
  const slotTs = Math.floor(event.eventStart.getTime() / 1000);
  const ctx = {
    altBias: await fetchAltBias(slotTs),
    prevBias: await fetchPrevWindowBias(slotTs),
  };
  logLine(
    'CTX',
    `alts avgDown=${ctx.altBias?.avgDown ?? '—'} | prev=${ctx.prevBias ?? '—'}`,
  );

  while (!done) {
    const now = Date.now();
    const secsLeft = (event.eventEnd.getTime() - now) / 1000;
    if (secsLeft <= 0) {
      logLine('END', `janela fechou | pos=${pos ? pos.side : 'flat'}`);
      done = true;
      break;
    }

    let upBook;
    let downBook;
    try {
      [upBook, downBook] = await Promise.all([
        client.getOrderBook(event.upTokenId),
        client.getOrderBook(event.downTokenId),
      ]);
    } catch (err) {
      logLine('ERR', `book ${err.message}`);
      await sleep(POLL_MS);
      continue;
    }

    const up = bestLevels(upBook);
    const down = bestLevels(downBook);
    const btc = Number.isFinite(state.btc) ? state.btc : null;
    const ptb = state.priceToBeat;
    const delta = btc != null && ptb != null ? btc - ptb : NaN;

    const snap = { secsLeft, btc, ptb, delta, up, down, now };
    hist.push({ t: now, delta, btc, upAsk: up.ask?.price, downAsk: down.ask?.price });
    if (hist.length > 90) hist.shift();

    const midUp = up.bid && up.ask ? (up.bid.price + up.ask.price) / 2 : up.ask?.price;
    void midUp;
    logLine(
      'TICK',
      `t-${secsLeft.toFixed(0).padStart(3)}s BTC=${btc?.toFixed?.(2) ?? '—'} Δ=${Number.isFinite(delta) ? (delta >= 0 ? '+' : '') + delta.toFixed(1) : '—'} | UP ${up.bid?.price ?? '—'}/${up.ask?.price ?? '—'} d$${up.depthAskUsd} | DN ${down.bid?.price ?? '—'}/${down.ask?.price ?? '—'} d$${down.depthAskUsd} | pos=${pos ? pos.side : 'flat'}`,
    );

    if (now - lastCtxLog >= CTX_LOG_EVERY_MS) {
      lastCtxLog = now;
      const a = analyzeContext(snap, hist, ctx);
      logLine('READ', `${a.lean} | ${a.notes}`);
    }

    // Gestão de saída primeiro
    if (pos) {
      const exit = shouldExit(pos, snap, hist);
      if (exit) {
        const bid = pos.side === 'UP' ? up.bid : down.bid;
        if (!bid) {
          logLine('EXIT?', `sinal: ${exit.reason} — sem bid`);
        } else if (!LIVE) {
          logLine('EXIT', `DRY ${pos.side} @${bid.price} — ${exit.reason}`);
          pos = null;
        } else {
          try {
            const { resp, price } = await sellSide(client, pos.tokenId, bid.price, pos.size);
            logLine(
              'EXIT',
              `${pos.side} sell size=${pos.size} px=${price} status=${resp?.status} matched=${resp?.takingAmount || resp?.makingAmount || ''} — ${exit.reason}`,
            );
            if (resp?.success) {
              const exitPx = price;
              const pnl = (exitPx - pos.entry) * pos.size;
              session.realizedPnl = (session.realizedPnl || 0) + pnl;
              logLine('PNL', `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD (${pos.side} ${pos.entry}→${exitPx}) sess=${session.realizedPnl.toFixed(2)}`);
              if (pnl < -0.05) session.consecutiveLosses += 1;
              else if (pnl > 0.05) session.consecutiveLosses = 0;
              pos = null;
            } else logLine('EXIT!', `falhou: ${resp?.errorMsg || JSON.stringify(resp)}`);
          } catch (err) {
            logLine('EXIT!', err.message);
          }
        }
      }
    }

    // Entrada: snipe pode repetir; normal max 1/janela
    const d = decide(snap, hist, ctx, session);
    const allowEnter = !pos && (!enteredThisWindow || d.reason?.startsWith('SNIPE') || d.reason?.startsWith('LOCK'));
    if (allowEnter && d.action === 'enter') {
        const tokenId = d.side === 'UP' ? event.upTokenId : event.downTokenId;
        const ask = d.side === 'UP' ? up.ask : down.ask;
        if (!ask) {
          logLine('SKIP', 'sem ask');
        } else if (!LIVE) {
          logLine('ENTER', `DRY ${d.side} @${ask.price} — ${d.reason}`);
          pos = { side: d.side, tokenId, size: SIZE, entry: ask.price, reason: d.reason };
          enteredThisWindow = true;
        } else {
          try {
            const { resp, price, size } = await buySide(client, tokenId, ask.price);
            logLine(
              'ENTER',
              `${d.side} buy size=${size} px=${price} status=${resp?.status} cost=${resp?.makingAmount || ''} — ${d.reason}`,
            );
            if (resp?.success && (resp.status === 'matched' || resp.status === 'live' || resp.orderID)) {
              const filled = resp.status === 'matched' || Number(resp.takingAmount) > 0;
              const sz = filled ? Number(resp.takingAmount) || size : size;
              pos = {
                side: d.side,
                tokenId,
                size: sz,
                entry: Number(resp.makingAmount) && sz ? Number(resp.makingAmount) / sz : price,
                orderId: resp.orderID,
                reason: d.reason,
              };
              enteredThisWindow = true;
              // se ficou live sem fill imediato, cancela e aborta entrada
              if (resp.status === 'live' && !filled) {
                try {
                  await client.cancelOrder({ orderID: resp.orderID });
                  logLine('ENTER', 'ordem live sem fill — cancelada');
                  pos = null;
                  enteredThisWindow = false;
                } catch {
                  /* keep watching */
                }
              }
            } else {
              logLine('ENTER!', resp?.errorMsg || JSON.stringify(resp));
            }
          } catch (err) {
            logLine('ENTER!', err.message);
          }
        }
    } else if (!pos && secsLeft % 8 < 1) {
      logLine('IDLE', d.reason);
    }

    await sleep(POLL_MS);
  }

  stopRtds();
  clob.stop();
  if (pos) {
    logLine('HOLD', `settlement ${pos.side} entry=${pos.entry} — aguardando resolve`);
  }
  return { event: event.title, pos };
}

async function main() {
  acquireSingletonLock();
  console.log(`=== DESK BTC 5m RECOVERY (${LIVE ? 'LIVE MONEY' : 'observe-only'}) windows=${WINDOWS} maxLoss=$${SESSION_MAX_LOSS_USD} ===`);
  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });

  // limpa ordens órfãs de desks paralelos
  try {
    const open = await client.getOpenOrders();
    for (const o of open) {
      await client.cancelOrder({ orderID: o.id });
    }
    if (open.length) logLine('CLEAN', `cancelou ${open.length} ordens abertas`);
  } catch (err) {
    logLine('CLEAN!', err.message);
  }

  const session = { consecutiveLosses: 0, realizedPnl: 0 };

  for (let i = 1; i <= WINDOWS; i++) {
    if (session.realizedPnl <= -SESSION_MAX_LOSS_USD) {
      logLine('STOP', `circuit breaker atingido (${session.realizedPnl.toFixed(2)}) — encerrando`);
      break;
    }
    await runWindow(client, i, session);
    if (i < WINDOWS) {
      logLine('GAP', 'aguardando próxima janela…');
      await sleep(2000);
    }
  }
  logLine('DONE', `sessão encerrada | PNL=${session.realizedPnl.toFixed(2)}`);
}

main().catch((err) => {
  console.error('[desk]', err);
  process.exit(1);
});
