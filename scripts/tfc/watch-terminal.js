#!/usr/bin/env node
/**
 * Observa um evento BTC 5m em tempo real e avalia gates TFC (sem ordens).
 *
 * Uso:
 *   npm run tfc:watch
 *   npm run tfc:watch -- --duration 600 --json
 *   npm run tfc:watch -- --terminal-only
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState, bookView } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { evaluateEntryGates } from '../../src/tfc/evaluate.js';
import { TFC_V6_HYBRID } from '../../src/tfc/preset-v6-hybrid.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    durationSec: parseInt(valueOf('--duration') ?? '330', 10),
    terminalOnly: args.includes('--terminal-only'),
    json: args.includes('--json'),
    intervalMs: parseInt(valueOf('--interval') ?? '1000', 10),
    outDir: valueOf('--out') ?? 'runs',
  };
}

function secsLeft(eventEnd, now = Date.now()) {
  return (eventEnd.getTime() - now) / 1000;
}

function formatGates(gates) {
  return Object.entries(gates)
    .map(([k, g]) => `${k}:${g.pass ? '✓' : '✗'}`)
    .join(' ');
}

async function main() {
  const opts = parseArgs(process.argv);
  const state = createMarketState();
  const event = await findActiveBtc5mEvent();
  if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

  state.event = event;
  if (event.eventStart && event.eventEnd) {
    state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
    if (!state.priceToBeat && !opts.json) {
      console.warn('AVISO: PTB indisponível (rate limit?). Gates de distância/favorito ficam inválidos.');
    }
  }

  const stopRtds = startRtdsFeed(state);
  const clob = createClobFeed(state);
  clob.subscribe(event.upTokenId, event.downTokenId);

  const history = [];
  const samples = [];
  const runId = `watch-${Date.now()}`;
  const outFile = path.join(opts.outDir, `${runId}.jsonl`);
  fs.mkdirSync(opts.outDir, { recursive: true });

  const started = Date.now();
  const deadline = started + opts.durationSec * 1000;

  if (!opts.json) {
    console.log('=== TFC watch (observe-only) ===');
    console.log(`Evento: ${event.title}`);
    console.log(`PTB:    ${state.priceToBeat ?? 'carregando...'}`);
    console.log(`Janela terminal: ${TFC_V6_HYBRID.minSecondsLeft}s–${TFC_V6_HYBRID.maxSecondsLeft}s antes do fim`);
    console.log(`Duração: ${opts.durationSec}s | log: ${outFile}`);
    console.log('');
  }

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const nowMs = Date.now();
      if (nowMs >= deadline || secsLeft(event.eventEnd, nowMs) <= 0) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Number.isFinite(state.btc)) {
        history.push({ ts: nowMs, btc: state.btc });
        if (history.length > 120) history.shift();
      }

      const sl = secsLeft(event.eventEnd, nowMs);
      const inTerminal = sl >= TFC_V6_HYBRID.minSecondsLeft && sl < TFC_V6_HYBRID.maxSecondsLeft;
      if (opts.terminalOnly && !inTerminal) return;

      const snapshot = {
        nowMs,
        btc: state.btc,
        priceToBeat: state.priceToBeat,
        secsLeft: sl,
        book: bookView(state),
        feeds: {
          rtds: state.wsRtdsConnected,
          clob: state.wsClobConnected,
          rtdsLagMs: state.rtdsReceivedAt ? nowMs - state.rtdsReceivedAt : null,
          clobLagMs: state.clobLastAt ? nowMs - state.clobLastAt : null,
        },
      };

      const evalResult = evaluateEntryGates(snapshot, TFC_V6_HYBRID, history);
      const row = { ...snapshot, eval: evalResult };
      samples.push(row);
      fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);

      if (!opts.json) {
        const up = state.up;
        const down = state.down;
        const line = [
          `t=${sl.toFixed(1)}s`,
          `btc=${state.btc?.toFixed(2) ?? '?'}`,
          `ptb=${state.priceToBeat?.toFixed(2) ?? '?'}`,
          `fav=${evalResult.fav ?? '-'}`,
          `up ${up.bestBid?.toFixed(2)}/${up.bestAsk?.toFixed(2)}`,
          `dn ${down.bestBid?.toFixed(2)}/${down.bestAsk?.toFixed(2)}`,
          evalResult.ok ? 'GATES:OK' : 'GATES:--',
          formatGates(evalResult.gates),
        ].join(' | ');
        console.log(line);
      }
    }, opts.intervalMs);
  });

  stopRtds();
  clob.stop();

  const terminalSamples = samples.filter(
    (s) => s.secsLeft >= TFC_V6_HYBRID.minSecondsLeft && s.secsLeft < TFC_V6_HYBRID.maxSecondsLeft,
  );
  const gatePassCount = terminalSamples.filter((s) => s.eval?.ok).length;

  const summary = {
    runId,
    event: event.title,
    priceToBeat: state.priceToBeat,
    samples: samples.length,
    terminalSamples: terminalSamples.length,
    gatePassInTerminal: gatePassCount,
    outFile,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log('=== resumo ===');
    console.log(`Amostras: ${summary.samples} (terminal: ${summary.terminalSamples})`);
    console.log(`Gates OK na janela terminal: ${gatePassCount}`);
    console.log(`Log JSONL: ${outFile}`);
  }
}

main().catch((err) => {
  console.error(`[tfc:watch] ${err.message}`);
  process.exit(1);
});
