#!/usr/bin/env node
/**
 * Shadow sprint MIDAS — feeds reais, sink shadow (sem ordem CLOB).
 * Meta ágil: ≥5 intenções ENTER na janela terminal.
 *
 *   npm run midas:shadow-sprint
 *   npm run midas:shadow-sprint -- --target=5 --timeout=900
 */

import 'dotenv/config';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { buildMarketSnapshot } from '../../src/market/normalize.js';
import { bootstrapEngine } from '../../src/composition/bootstrap.js';
import { MIDAS_V1_STRATEGY_ID } from '../../src/strategy/midasV1.js';
import { MIDAS_V1 } from '../../src/tfc/preset-midas.js';

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
    json: args.includes('--json'),
  };
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
  let event = null;

  try {
    engine = bootstrapEngine({
      strategyId: MIDAS_V1_STRATEGY_ID,
      mode: 'shadow',
      preset: MIDAS_V1,
      strategyInstanceId: 'midas-shadow-sprint',
    });
    engine.start();

    if (!opts.json) {
      console.log(`=== MIDAS shadow sprint (target=${opts.target}, timeout=${opts.timeoutSec}s) ===`);
    }

    const deadline = Date.now() + opts.timeoutSec * 1000;

    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          if (enters.length >= opts.target || Date.now() >= deadline) {
            clearInterval(timer);
            resolve();
            return;
          }

          if (Date.now() - lastEventFetchMs > 2000 || !event) {
            event = await findActiveBtc5mEvent();
            lastEventFetchMs = Date.now();
          }
          if (!event) return;

          if (event.conditionId !== currentEventId) {
            currentEventId = event.conditionId;
            state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
            stopRtds?.();
            clobFeed?.stop();
            stopRtds = startRtdsFeed(state);
            clobFeed = createClobFeed(state);
            clobFeed.subscribe(event.upTokenId, event.downTokenId);
            if (!opts.json) {
              console.log(`[event] ${event.title} | PTB=${state.priceToBeat}`);
            }
          }

          const nowMs = Date.now();
          const snapshot = buildMarketSnapshot({ state, event, nowMs });
          await engine.ingestMarketSnapshot(snapshot);

          for (const row of engine.journal) {
            if (row.type !== 'sink' || row.intent?.kind !== 'ENTER') continue;
            const id = row.intentId ?? row.intent?.intentId;
            if (!id || seenIntentIds.has(id)) continue;
            // No máximo 1 ENTER contado por mercado/evento
            const marketKey = row.intent.marketId ?? snapshot.marketId;
            if (seenMarkets.has(marketKey)) continue;
            seenIntentIds.add(id);
            seenMarkets.add(marketKey);
            const rec = {
              n: enters.length + 1,
              intentId: id,
              side: row.intent.side,
              quantity: row.intent.quantity,
              budget: row.intent.budget,
              reason: row.intent.reason,
              secsLeft: snapshot.secsLeft,
              ask:
                row.intent.side === 'DOWN'
                  ? snapshot.book?.down?.bestAsk
                  : snapshot.book?.up?.bestAsk,
              event: event.title,
              marketId: marketKey,
              at: new Date(nowMs).toISOString(),
            };
            enters.push(rec);
            if (!opts.json) {
              console.log(
                `[ENTER ${rec.n}/${opts.target}] ${rec.side} qty=${rec.quantity} ask=${rec.ask} τ=${rec.secsLeft?.toFixed?.(1) ?? rec.secsLeft}s | ${rec.event}`,
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
        }
      }, 500);
    });

    const report = {
      ok: enters.length >= opts.target,
      strategyId: MIDAS_V1_STRATEGY_ID,
      mode: 'shadow',
      target: opts.target,
      count: enters.length,
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
