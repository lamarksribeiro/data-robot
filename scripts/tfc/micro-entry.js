#!/usr/bin/env node
/**
 * Micro-entrada TFC V7: quando todos os gates passam, envia ordem mínima (~$0.10).
 * Padrão é dry-run; use --live para enviar ordem real.
 *
 * Uso:
 *   npm run tfc:micro-entry              # dry-run
 *   npm run tfc:micro-entry -- --live --cancel
 */

import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { createMarketState, bookView } from '../../src/feeds/marketState.js';
import { startRtdsFeed } from '../../src/feeds/rtdsFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { fetchPriceToBeat } from '../../src/markets/priceToBeat.js';
import { evaluateEntryGates } from '../../src/tfc/evaluate.js';
import { TFC_V7, MICRO_TEST } from '../../src/tfc/preset-v7.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    live: args.includes('--live'),
    cancel: args.includes('--cancel'),
    json: args.includes('--json'),
    timeoutSec: parseInt(args.find((a) => a.startsWith('--timeout='))?.split('=')[1] ?? '300', 10),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const params = { ...TFC_V7, ...MICRO_TEST };
  const state = createMarketState();
  const event = await findActiveBtc5mEvent();
  if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

  state.priceToBeat = await fetchPriceToBeat(event.eventStart, event.eventEnd);
  const stopRtds = startRtdsFeed(state);
  const clob = createClobFeed(state);
  clob.subscribe(event.upTokenId, event.downTokenId);

  let client = null;
  if (opts.live) {
    const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
    client = buildClobClient({ wallet, throwOnError: true });
  }

  const history = [];
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let placed = false;

  if (!opts.json) {
    console.log(`=== TFC V7 micro-entry (${opts.live ? 'LIVE' : 'dry-run'}) ===`);
    console.log(`Preset: btc-champion-v7 | Evento: ${event.title} | PTB: ${state.priceToBeat}`);
  }

  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (placed || Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
        return;
      }

      const nowMs = Date.now();
      const sl = (event.eventEnd.getTime() - nowMs) / 1000;
      if (Number.isFinite(state.btc)) {
        history.push({ ts: nowMs, btc: state.btc });
        if (history.length > 120) history.shift();
      }

      const snapshot = {
        nowMs,
        btc: state.btc,
        priceToBeat: state.priceToBeat,
        secsLeft: sl,
        book: bookView(state),
      };
      const ev = evaluateEntryGates(snapshot, params, history);
      if (!ev.ok || !ev.fav) return;

      const tokenId = ev.fav === 'UP' ? event.upTokenId : event.downTokenId;
      const ask = ev.ask;
      if (ask == null) return;

      const size = Math.max(params.minShares, Math.floor(params.entryBudget / ask));
      const notional = (size * ask).toFixed(2);

      const plan = {
        side: ev.fav,
        tokenId,
        price: ask,
        size,
        notionalUsd: notional,
        secsLeft: sl,
        gates: ev.gates,
      };

      if (!opts.live) {
        placed = true;
        if (opts.json) console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
        else console.log('DRY-RUN — gates OK, plano:', plan);
        clearInterval(timer);
        resolve();
        return;
      }

      placed = true;
      const t0 = performance.now();
      const resp = await client.createAndPostOrder(
        { tokenID: tokenId, price: ask, side: Side.BUY, size },
        undefined,
        OrderType.GTC,
        false,
        false,
      );
      const createMs = Math.round(performance.now() - t0);

      const result = {
        ...plan,
        orderId: resp?.orderID,
        status: resp?.status,
        createMs,
        success: resp?.success === true,
      };

      if (opts.cancel && result.orderId) {
        const c0 = performance.now();
        await client.cancelOrder({ orderID: result.orderId });
        result.cancelMs = Math.round(performance.now() - c0);
        result.canceled = true;
      }

      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log('ORDEM ENVIADA:', result);
        console.log('Confira polymarket.com/portfolio?tab=open');
      }

      clearInterval(timer);
      resolve();
    }, 500);
  });

  stopRtds();
  clob.stop();

  if (!placed && !opts.json) {
    console.log(`Timeout ${opts.timeoutSec}s sem gates OK na janela terminal.`);
  }
}

main().catch((err) => {
  console.error(`[tfc:micro-entry] ${err.message}`);
  process.exit(1);
});
