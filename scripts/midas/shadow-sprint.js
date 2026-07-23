#!/usr/bin/env node
/**
 * Shadow sprint MIDAS — feeds reais, sink shadow (sem ordem CLOB).
 * Meta ágil: ≥5 intenções ENTER na janela terminal.
 * Poll agressivo (default 50ms) para não perder a janela 5–30s.
 *
 *   npm run midas:shadow-sprint
 *   npm run midas:shadow-sprint -- --target=5 --timeout=1800 --interval=50
 */

import 'dotenv/config';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { buildMarketSnapshot } from '../../src/market/normalize.js';
import { BTC5M_STALENESS } from '../../src/market/health.js';
import { bootstrapEngine } from '../../src/composition/bootstrap.js';
import { MIDAS_V1_STRATEGY_ID } from '../../src/strategy/midasV1.js';
import { MIDAS_V1 } from '../../src/tfc/preset-midas.js';
import { evaluateEntryGates } from '../../src/tfc/evaluate.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    target: Math.max(1, parseInt(valueOf('--target') ?? '5', 10) || 5),
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '900', 10) || 900),
    /** Poll loop — default 50ms (velocidade máxima prática no Node). */
    intervalMs: Math.max(20, parseInt(valueOf('--interval') ?? '50', 10) || 50),
    json: args.includes('--json'),
  };
}

function failGates(gates) {
  return Object.entries(gates || {})
    .filter(([, g]) => !g.pass)
    .map(([k, g]) => `${k}:${g.detail ?? 'fail'}`)
    .join(' ');
}

function createShadowEngine() {
  const engine = bootstrapEngine({
    strategyId: MIDAS_V1_STRATEGY_ID,
    mode: 'shadow',
    preset: MIDAS_V1,
    strategyInstanceId: 'midas-shadow-sprint',
  });
  engine.start();
  return engine;
}

async function main() {
  const opts = parseArgs(process.argv);
  const state = createMarketState();
  let stopRtds = null;
  let clobFeed = null;
  let engine = null;
  const enters = [];
  const seenIntentIds = new Set();
  const seenMarkets = new Set();
  let currentEventId = null;
  let lastEventFetchMs = 0;
  let lastPtbRetryMs = 0;
  let lastGateLogMs = 0;
  let lastHeartbeatMs = 0;
  let event = null;
  let tickBusy = false;
  const history = [];

  try {
    engine = createShadowEngine();

    if (!opts.json) {
      console.log(
        `=== MIDAS shadow sprint (target=${opts.target}, timeout=${opts.timeoutSec}s, interval=${opts.intervalMs}ms) ===`,
      );
    }

    const deadline = Date.now() + opts.timeoutSec * 1000;

    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (tickBusy) return;
        tickBusy = true;
        (async () => {
          try {
            if (enters.length >= opts.target || Date.now() >= deadline) {
              clearInterval(timer);
              resolve();
              return;
            }

            if (Date.now() - lastEventFetchMs > 1000 || !event) {
              event = await findActiveBtc5mEvent();
              lastEventFetchMs = Date.now();
            }
            if (!event) return;

            if (event.conditionId !== currentEventId) {
              currentEventId = event.conditionId;
              // Sprint conta 1 ENTER/mercado: posição shadow do evento anterior
              // não pode bloquear o próximo (plugin só ENTER com qty=0).
              if (engine) {
                await engine.safeShutdown('midas-shadow-market-rotate');
                engine = createShadowEngine();
              }
              state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
              lastPtbRetryMs = Date.now();
              history.length = 0;
              stopRtds?.();
              clobFeed?.stop();
              stopRtds = startRtdsFeed(state);
              clobFeed = createClobFeed(state);
              clobFeed.subscribe(event.upTokenId, event.downTokenId);
              if (!opts.json) {
                console.log(`[event] ${event.title} | PTB=${state.priceToBeat ?? 'pendente'}`);
              }
            }

            // PTB costuma chegar segundos após o open — retentar rápido.
            if (
              state.priceToBeat == null &&
              event.eventStart &&
              event.eventEnd &&
              Date.now() - lastPtbRetryMs > 2000
            ) {
              lastPtbRetryMs = Date.now();
              const ptb = await fetchPriceToBeat(event.eventStart, event.eventEnd);
              if (ptb != null) {
                state.priceToBeat = ptb;
                if (!opts.json) console.log(`[ptb] ${ptb}`);
              }
            }

            const nowMs = Date.now();
            // Shadow: não descartar book quieto com stale 2–3s (mercado noturno é rarefeito).
            const snapshot = buildMarketSnapshot({
              state,
              event,
              nowMs,
              healthLimits: BTC5M_STALENESS,
            });
            if (Number.isFinite(snapshot.btc)) {
              history.push({ ts: nowMs, btc: snapshot.btc });
              if (history.length > 600) history.splice(0, history.length - 600);
            }
            await engine.ingestMarketSnapshot(snapshot);

            const marketKey = snapshot.marketId;
            const secsLeft = snapshot.secsLeft;
            const inTerminal =
              Number.isFinite(secsLeft) &&
              secsLeft >= MIDAS_V1.minSecondsLeft &&
              secsLeft < MIDAS_V1.maxSecondsLeft;
            const approaching =
              Number.isFinite(secsLeft) && secsLeft < 45 && secsLeft >= MIDAS_V1.maxSecondsLeft;
            const healthReasons = (snapshot.health?.reasons ?? []).join(',') || '-';

            // Heartbeat fora da janela (a cada 10s) — não ficar cego.
            if (!opts.json && !inTerminal && Date.now() - lastHeartbeatMs > 10_000) {
              lastHeartbeatMs = Date.now();
              console.log(
                `[hb] enters=${enters.length}/${opts.target} τ=${secsLeft?.toFixed?.(1) ?? '?'}s ` +
                  `ptb=${state.priceToBeat ?? '?'} btc=${snapshot.btc ?? '?'} ` +
                  `rtds=${snapshot.feeds?.rtdsConnected ? 1 : 0} clob=${snapshot.feeds?.clobConnected ? 1 : 0} ` +
                  `healthy=${snapshot.feeds?.healthy !== false ? 1 : 0} reasons=${healthReasons}`,
              );
            }

            // Na aproximação / janela: log de gates a cada 1s.
            if (
              !opts.json &&
              (inTerminal || approaching) &&
              !seenMarkets.has(marketKey) &&
              Date.now() - lastGateLogMs > 1000
            ) {
              lastGateLogMs = Date.now();
              const evalResult = evaluateEntryGates(snapshot, MIDAS_V1, history);
              const fails = failGates(evalResult.gates);
              console.log(
                `[${inTerminal ? 'term' : 'near'}] τ=${secsLeft?.toFixed?.(1)}s fav=${evalResult.fav ?? '-'} ` +
                  `ask=${evalResult.ask ?? '?'} dist=${evalResult.dist?.toFixed?.(1) ?? '?'} ` +
                  `ok=${evalResult.ok ? 1 : 0} ${fails || 'all-pass'}`,
              );
            }

            for (const row of engine.journal) {
              if (row.type !== 'sink' || row.intent?.kind !== 'ENTER') continue;
              const id = row.intentId ?? row.intent?.intentId;
              if (!id || seenIntentIds.has(id)) continue;
              const mk = row.intent.marketId ?? snapshot.marketId;
              if (seenMarkets.has(mk)) continue;
              seenIntentIds.add(id);
              seenMarkets.add(mk);
              const rec = {
                n: enters.length + 1,
                intentId: id,
                side: row.intent.side,
                quantity: row.intent.quantity,
                budget: row.intent.budget,
                reason: row.intent.reason,
                secsLeft,
                ask:
                  row.intent.side === 'DOWN'
                    ? snapshot.book?.down?.bestAsk
                    : snapshot.book?.up?.bestAsk,
                event: event.title,
                marketId: mk,
                at: new Date(nowMs).toISOString(),
              };
              enters.push(rec);
              if (!opts.json) {
                console.log(
                  `[ENTER ${rec.n}/${opts.target}] ${rec.side} qty=${rec.quantity} ask=${rec.ask} τ=${secsLeft?.toFixed?.(1) ?? secsLeft}s | ${rec.event}`,
                );
              }
              if (enters.length >= opts.target) {
                clearInterval(timer);
                resolve();
                return;
              }
            }
          } catch (err) {
            clearInterval(timer);
            reject(err);
          } finally {
            tickBusy = false;
          }
        })();
      }, opts.intervalMs);
    });

    const report = {
      ok: enters.length >= opts.target,
      strategyId: MIDAS_V1_STRATEGY_ID,
      mode: 'shadow',
      target: opts.target,
      count: enters.length,
      intervalMs: opts.intervalMs,
      enters,
      timedOut: enters.length < opts.target,
    };

    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('=== resultado ===');
      console.log(JSON.stringify(report, null, 2));
    }

    process.exitCode = report.ok ? 0 : 2;
  } finally {
    if (engine) await engine.safeShutdown('midas-shadow-sprint');
    stopRtds?.();
    clobFeed?.stop();
  }
}

main().catch((err) => {
  console.error(`[midas:shadow-sprint] ${err.message}`);
  process.exit(1);
});
