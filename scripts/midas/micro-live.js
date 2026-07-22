#!/usr/bin/env node
/**
 * Micro-live MIDAS Carry V1 via engine — strategy → risk → OMS → transport.
 *
 * Default: dry-run (sem CLOB).
 * Live: exige --live (exit 2 sem a flag).
 * Rotaciona BTC 5m via createMarketHub (mesmo núcleo da engine contínua).
 *
 *   npm run midas:micro-live
 *   npm run midas:micro-live -- --timeout=900
 *   npm run midas:micro-live -- --live --timeout=900
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
import { createMarketHub } from '../../src/market/hub.js';
import { bootstrapMidasCanaryEngine } from '../../src/composition/midasCanary.js';
import { buildMicroLiveReport, compareIntentParity } from '../../src/oms/microLiveReport.js';
import { createMidasV1Strategy } from '../../src/strategy/midasV1.js';
import { CANARY_LIMITS, canaryMidasPreset } from '../../src/tfc/preset-midas.js';
import { buildStrategyContext } from '../../src/engine/contract.js';
import { emptyPosition } from '../../src/engine/schemas.js';
import { createUserChannel } from '../../src/executor/userChannel.js';
import { preflightChecksFromResult, runLivePreflight } from '../../src/risk/livePreflight.js';

/** Staleness folgado na espera de sinal (livro 5m pode ficar quieto). */
const WAIT_HEALTH = Object.freeze({
  rtdsMaxLagMs: 8_000,
  clobMaxLagMs: 15_000,
  clockSkewMaxMs: 5_000,
});

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
    timeoutSec: Math.max(30, parseInt(valueOf('--timeout') ?? '900', 10) || 900),
    intervalMs: Math.max(50, parseInt(valueOf('--interval') ?? '100', 10) || 100),
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
      hint: 'npm run midas:micro-live -- --live --timeout=900',
    });
  }

  const mode = opts.live ? 'live' : 'dry-run';
  const preset = canaryMidasPreset();
  const state = createMarketState();
  const hub = createMarketHub({ state, healthLimits: WAIT_HEALTH });
  let engine = null;
  let stopRtds = null;
  let clobFeed = null;
  let placed = false;
  let serverClockOffsetMs = null;
  let subscribedMarketId = null;
  let lastSyncMs = 0;
  let lastPtbRetryMs = 0;
  let lastHbMs = 0;
  let client = null;
  let userChannel = null;
  let riskOpts = {};
  let tickBusy = false;

  function buildEngine() {
    return bootstrapMidasCanaryEngine({
      mode,
      liveEnabled: opts.live,
      client: opts.live ? client : undefined,
      Side: opts.live ? Side : undefined,
      OrderType: opts.live ? OrderType : undefined,
      userChannel,
      riskOpts,
      preset,
    });
  }

  try {
    stopRtds = startRtdsFeed(state);
    clobFeed = createClobFeed(state);

    const first = await hub.syncMarket();
    if (!first.ok || !hub.event) throw new Error('Nenhum evento BTC 5m ativo.');
    clobFeed.subscribe(hub.event.upTokenId, hub.event.downTokenId);
    subscribedMarketId = first.marketId;
    lastSyncMs = Date.now();
    lastPtbRetryMs = Date.now();

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
      // Sem filtro de mercado: sobrevive a rotação BTC 5m enquanto espera ENTER.
      userChannel = createUserChannel({
        kind: 'ws',
        url: config.clobUserWsUrl,
        auth: {
          apiKey: config.polymarketApiKey,
          secret: config.polymarketApiSecret,
          passphrase: config.polymarketApiPassphrase,
        },
        markets: [],
      });
    }

    engine = buildEngine();
    await engine.sink.start();
    engine.start();

    const deadline = Date.now() + opts.timeoutSec * 1000;
    if (!opts.json) {
      console.log(`=== MIDAS Carry V1 micro-live engine (${mode}) ===`);
      console.log(
        `Canary cap: $${engine.canary.maxCanaryBudget} | timeout=${opts.timeoutSec}s interval=${opts.intervalMs}ms`,
      );
      console.log(`[event] ${hub.event.title} | PTB=${state.priceToBeat ?? 'pendente'}`);
    }

    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (tickBusy) return;
        tickBusy = true;
        (async () => {
          try {
            if (placed || Date.now() >= deadline) {
              clearInterval(timer);
              resolve();
              return;
            }

            const nowMs = Date.now();
            const endMs =
              hub.event?.eventEnd instanceof Date ? hub.event.eventEnd.getTime() : null;
            const needSync =
              !hub.event ||
              nowMs - lastSyncMs > 1000 ||
              (endMs != null && nowMs >= endMs);

            if (needSync) {
              const synced = await hub.syncMarket(new Date(nowMs));
              lastSyncMs = nowMs;
              if (!synced.ok || !hub.event) {
                if (!opts.json && nowMs - lastHbMs > 10_000) {
                  lastHbMs = nowMs;
                  console.log(`[hb] sem evento ativo (${synced.reason ?? 'NO_ACTIVE_EVENT'})`);
                }
                return;
              }
              if (synced.rotated || synced.marketId !== subscribedMarketId) {
                clobFeed.subscribe(hub.event.upTokenId, hub.event.downTokenId);
                subscribedMarketId = synced.marketId;
                // Engine limpa: evita estado/posição shadow de slot anterior.
                await engine.safeShutdown('midas-micro-market-rotate');
                engine.sink.dispose?.();
                engine = buildEngine();
                await engine.sink.start();
                engine.start();
                if (!opts.json) {
                  console.log(
                    `[event] ${hub.event.title} | PTB=${state.priceToBeat ?? 'pendente'} (rot=${hub.stats.rotations})`,
                  );
                }
              }
            }

            if (
              state.priceToBeat == null &&
              hub.event?.eventStart &&
              hub.event?.eventEnd &&
              nowMs - lastPtbRetryMs > 2000
            ) {
              lastPtbRetryMs = nowMs;
              await hub.syncMarket(new Date(nowMs));
              if (state.priceToBeat != null && !opts.json) {
                console.log(`[ptb] ${state.priceToBeat}`);
              }
            }

            const captured = hub.capture({
              requireAcceptingOrders: true,
              minSecsLeft: 1,
              serverNowMs:
                serverClockOffsetMs == null ? null : nowMs + Number(serverClockOffsetMs),
            });
            if (!captured.snapshot) return;

            const snapshot = captured.snapshot;
            if (!opts.json && nowMs - lastHbMs > 10_000) {
              lastHbMs = nowMs;
              console.log(
                `[hb] τ=${snapshot.secsLeft?.toFixed?.(1) ?? '?'}s ptb=${state.priceToBeat ?? '?'} ` +
                  `btc=${snapshot.btc ?? '?'} eligible=${captured.eligible ? 1 : 0} ` +
                  `rot=${hub.stats.rotations} reasons=${(captured.reasons ?? []).join(',') || '-'}`,
              );
            }

            // Ingest mesmo se não elegível estrito — estratégia aplica seus gates.
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
              .filter(
                (row) => row.type === 'execution' && row.event?.intentId === sinkEntry.intentId,
              )
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
            report.event = hub.event?.title ?? null;
            report.marketId = snapshot.marketId;
            report.rotations = hub.stats.rotations;
            report.canaryBudget = engine.canary.maxCanaryBudget;

            if (opts.json) console.log(JSON.stringify(report, null, 2));
            else {
              console.log(mode === 'live' ? 'LIVE processado:' : 'DRY-RUN processado:');
              console.log(report);
            }
            clearInterval(timer);
            // CLI: sair imediatamente após o report — WS/OMS não podem segurar o process.
            stopRtds?.();
            clobFeed?.stop();
            try {
              await engine.safeShutdown('micro-live-done');
            } catch {
              /* ignore */
            }
            try {
              engine.sink.dispose?.();
            } catch {
              /* ignore */
            }
            process.exit(0);
          } catch (err) {
            clearInterval(timer);
            reject(err);
          } finally {
            tickBusy = false;
          }
        })();
      }, opts.intervalMs);
    });

    if (!placed && !opts.json) {
      console.log(
        `Timeout ${opts.timeoutSec}s sem intenção ENTER (rotações=${hub.stats.rotations}).`,
      );
      process.exitCode = 2;
    }
  } finally {
    try {
      if (engine) await engine.safeShutdown('micro-live-finally');
    } catch (err) {
      console.error(`[midas:micro-live] shutdown: ${err.message}`);
    }
    stopRtds?.();
    clobFeed?.stop();
    try {
      engine?.sink.dispose?.();
    } catch {
      /* ignore */
    }
  }

  process.exit(Number(process.exitCode ?? (placed ? 0 : 1)));
}

main().catch((err) => {
  console.error(`[midas:micro-live] ${err.message}`);
  process.exit(1);
});
