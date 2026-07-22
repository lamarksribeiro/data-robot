#!/usr/bin/env node
/**
 * Micro-live MIDAS Carry V1 via engine — strategy → risk → OMS → transport.
 *
 * Default: dry-run (sem CLOB).
 * Live: exige --live (exit 2 sem a flag).
 *
 *   npm run midas:micro-live
 *   npm run midas:micro-live -- --live --cancel --timeout=330
 */

import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { requireLiveFlag, hasLiveFlag } from '../../src/cli/liveGate.js';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { resolveSignatureType } from '../../src/clob/signatureType.js';
import config from '../../src/config.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { buildMarketSnapshot } from '../../src/market/normalize.js';
import { bootstrapMidasCanaryEngine } from '../../src/composition/midasCanary.js';
import { buildMicroLiveReport, compareIntentParity } from '../../src/oms/microLiveReport.js';
import { createMidasV1Strategy } from '../../src/strategy/midasV1.js';
import { CANARY_LIMITS, canaryMidasPreset } from '../../src/tfc/preset-midas.js';
import { buildStrategyContext } from '../../src/engine/contract.js';
import { emptyPosition } from '../../src/engine/schemas.js';
import { createUserChannel } from '../../src/executor/userChannel.js';
import { preflightChecksFromResult, runLivePreflight } from '../../src/risk/livePreflight.js';

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
  const strategy = createMidasV1Strategy();
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
    requireLiveFlag('midas:micro-live', {
      hint: 'npm run midas:micro-live -- --live --cancel --timeout=330',
    });
  }

  const mode = opts.live ? 'live' : 'dry-run';
  const preset = canaryMidasPreset();
  const state = createMarketState();
  let engine = null;
  let stopRtds = null;
  let clobFeed = null;
  let placed = false;
  let serverClockOffsetMs = null;

  try {
    const event = await findActiveBtc5mEvent();
    if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

    state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
    stopRtds = startRtdsFeed(state);
    clobFeed = createClobFeed(state);
    clobFeed.subscribe(event.upTokenId, event.downTokenId);

    let client = null;
    let userChannel = null;
    let riskOpts = {};
    if (opts.live) {
      const wallet = createSigner(config.polymarketPrivateKey);
      const signatureType = resolveSignatureType(config.polymarketSignatureType);
      const funderAddress = config.polymarketFunderAddress.trim() || wallet.address;
      client = buildClobClient({ wallet, signatureType, funderAddress, throwOnError: true });
      const preflight = await runLivePreflight({
        client,
        signerAddress: wallet.address,
        signatureType,
        funderAddress,
        minBalanceUsd: CANARY_LIMITS.maxCanaryBudget,
      });
      if (!preflight.ok) {
        const failed = Object.entries(preflight.checks)
          .filter(([, check]) => !check.ok)
          .map(([name]) => name)
          .join(', ');
        throw new Error(`preflight live reprovado: ${failed}`);
      }
      serverClockOffsetMs = preflight.checks.clock.offsetMs;
      riskOpts = { preflightChecks: preflightChecksFromResult(preflight) };
      userChannel = createUserChannel({
        kind: 'ws',
        url: config.clobUserWsUrl,
        auth: {
          apiKey: config.polymarketApiKey,
          secret: config.polymarketApiSecret,
          passphrase: config.polymarketApiPassphrase,
        },
        markets: [event.conditionId],
      });
    }

    engine = bootstrapMidasCanaryEngine({
      mode,
      liveEnabled: opts.live,
      client: opts.live ? client : undefined,
      Side: opts.live ? Side : undefined,
      OrderType: opts.live ? OrderType : undefined,
      userChannel,
      riskOpts,
      preset,
    });
    await engine.sink.start();
    engine.start();

    const deadline = Date.now() + opts.timeoutSec * 1000;
    if (!opts.json) {
      console.log(`=== MIDAS Carry V1 micro-live engine (${mode}) ===`);
      console.log(`Canary cap: $${engine.canary.maxCanaryBudget} | Evento: ${event.title}`);
    }

    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          if (placed || Date.now() >= deadline) {
            clearInterval(timer);
            resolve();
            return;
          }
          const nowMs = Date.now();
          const snapshot = buildMarketSnapshot({
            state,
            event,
            nowMs,
            serverNowMs:
              serverClockOffsetMs == null ? null : nowMs + Number(serverClockOffsetMs),
          });
          await engine.ingestMarketSnapshot(snapshot);
          const sinkEntry = [...engine.journal]
            .reverse()
            .find((j) => j.type === 'sink' && j.intent?.kind === 'ENTER');
          if (!sinkEntry) return;

          placed = true;
          if (opts.live) {
            await engine.sink.waitForFinal(sinkEntry.intentId, {
              timeoutMs: Math.min(15_000, Math.max(1000, deadline - Date.now())),
            });
          }

          let canceled = false;
          if (opts.live && opts.cancel) {
            const result = await engine.sink.cancelOpenOrders('micro-live-cancel');
            canceled = (result.canceled?.length ?? 0) > 0;
          }

          const riskEntry = [...engine.journal]
            .reverse()
            .find((j) => j.type === 'risk' && j.intentId === sinkEntry.intentId);
          const replayIntent = replayEnterIntent(snapshot, preset);
          const liveIntent = { intentId: sinkEntry.intentId, ...sinkEntry.intent };
          const ask =
            liveIntent.side === 'DOWN'
              ? snapshot.book?.down?.bestAsk
              : snapshot.book?.up?.bestAsk;
          const events = engine.journal
            .filter((row) => row.type === 'execution' && row.event?.intentId === sinkEntry.intentId)
            .map((row) => row.event);
          const report = buildMicroLiveReport({
            intent: liveIntent,
            events,
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
          reject(err);
        }
      }, 500);
    });

    if (!placed && !opts.json) {
      console.log(`Timeout ${opts.timeoutSec}s sem intenção ENTER na janela.`);
    }
  } finally {
    if (engine) await engine.safeShutdown('micro-live-finally');
    stopRtds?.();
    clobFeed?.stop();
    engine?.sink.dispose?.();
  }
}

main().catch((err) => {
  console.error(`[midas:micro-live] ${err.message}`);
  process.exit(1);
});
