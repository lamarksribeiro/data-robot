#!/usr/bin/env node
/**
 * Micro-live TFC V7 via engine (P7) — strategy → risk → OMS → transport.
 *
 * Default: dry-run (sem CLOB).
 * Live: exige --live (exit 2 sem a flag).
 *
 *   npm run tfc:micro-live
 *   npm run tfc:micro-live -- --live --cancel --timeout=330
 */

import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { requireLiveFlag, hasLiveFlag } from '../../src/cli/liveGate.js';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { buildMarketSnapshot } from '../../src/market/normalize.js';
import { bootstrapTfcCanaryEngine } from '../../src/composition/tfcCanary.js';
import { buildMicroLiveReport, compareIntentParity } from '../../src/oms/microLiveReport.js';
import { createTfcV7Strategy } from '../../src/strategy/tfcV7.js';
import { canaryPreset } from '../../src/tfc/preset-v7.js';
import { buildStrategyContext } from '../../src/engine/contract.js';
import { emptyPosition } from '../../src/engine/schemas.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    live: hasLiveFlag(argv),
    cancel: args.includes('--cancel'),
    json: args.includes('--json'),
    timeoutSec: parseInt(valueOf('--timeout') ?? '300', 10),
  };
}

function replayEnterIntent(snapshot, preset) {
  const strategy = createTfcV7Strategy();
  const ctx = buildStrategyContext({
    snapshot,
    position: emptyPosition({ marketId: snapshot.marketId }),
    mode: 'shadow',
    clockMs: snapshot.nowMs,
    preset,
    strategyInstanceId: 'parity-check',
  });
  const init = strategy.initialize(ctx, preset);
  const out = strategy.onSnapshot(ctx, {
    ...init.state,
    history: [
      { ts: snapshot.nowMs - 5000, btc: snapshot.btc },
      { ts: snapshot.nowMs, btc: snapshot.btc },
    ],
  });
  return out.intents.find((i) => i.kind === 'ENTER') ?? null;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.live) {
    requireLiveFlag('tfc:micro-live', {
      hint: 'npm run tfc:micro-live -- --live --cancel --timeout=330',
    });
  }

  const mode = opts.live ? 'live' : 'dry-run';
  const preset = canaryPreset();
  const state = createMarketState();
  const event = await findActiveBtc5mEvent();
  if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

  state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
  const stopRtds = startRtdsFeed(state);
  const clobFeed = createClobFeed(state);
  clobFeed.subscribe(event.upTokenId, event.downTokenId);

  let client = null;
  if (opts.live) {
    const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
    client = buildClobClient({ wallet, throwOnError: true });
  }

  const engine = bootstrapTfcCanaryEngine({
    mode,
    liveEnabled: opts.live,
    client: opts.live ? client : undefined,
    Side: opts.live ? Side : undefined,
    OrderType: opts.live ? OrderType : undefined,
    preset,
  });
  engine.start();

  let placed = false;
  const deadline = Date.now() + opts.timeoutSec * 1000;

  if (!opts.json) {
    console.log(`=== TFC V7 micro-live engine (${mode}) ===`);
    console.log(`Canary cap: $${engine.canary.maxCanaryBudget} | Evento: ${event.title}`);
  }

  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        if (placed || Date.now() >= deadline) {
          clearInterval(timer);
          resolve();
          return;
        }

        const snapshot = buildMarketSnapshot({ state, event });
        await engine.ingestMarketSnapshot(snapshot);

        const sinkEntry = [...engine.journal].reverse().find((j) => j.type === 'sink' && j.intent?.kind === 'ENTER');
        if (!sinkEntry) return;

        placed = true;
        const riskEntry = [...engine.journal]
          .reverse()
          .find((j) => j.type === 'risk' && j.intentId === sinkEntry.intentId);

        let canceled = false;
        if (opts.live && opts.cancel && typeof engine.sink.cancelOpenOrders === 'function') {
          const r = await engine.sink.cancelOpenOrders('micro-live-cancel');
          canceled = (r.canceled?.length ?? 0) > 0;
        }

        const replayIntent = replayEnterIntent(snapshot, preset);
        const liveIntent = {
          intentId: sinkEntry.intentId,
          ...sinkEntry.intent,
        };
        const ask =
          liveIntent.side === 'DOWN'
            ? snapshot.book?.down?.bestAsk
            : snapshot.book?.up?.bestAsk;

        const report = buildMicroLiveReport({
          intent: liveIntent,
          events: sinkEntry.events ?? [],
          position: engine.getStatus().position,
          askAtSignal: ask,
          riskDecision: riskEntry?.decision,
          canceled,
        });
        report.parity = compareIntentParity(liveIntent, replayIntent);
        report.mode = mode;
        report.event = event.title;
        report.canaryBudget = engine.canary.maxCanaryBudget;

        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(mode === 'live' ? 'LIVE processado:' : 'DRY-RUN processado:');
          console.log(report);
        }

        clearInterval(timer);
        resolve();
      } catch (err) {
        clearInterval(timer);
        console.error(`[tfc:micro-live] loop: ${err.message}`);
        resolve();
      }
    }, 500);
  });

  engine.halt('micro-live-done');
  stopRtds();
  clobFeed.stop();

  if (!placed && !opts.json) {
    console.log(`Timeout ${opts.timeoutSec}s sem intenção ENTER na janela.`);
  }
}

main().catch((err) => {
  console.error(`[tfc:micro-live] ${err.message}`);
  process.exit(1);
});
