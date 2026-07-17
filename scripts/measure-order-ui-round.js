#!/usr/bin/env node
/**
 * Envia ordem de teste e imprime timestamps API/CLOB.
 * Linha SYNC: sincroniza polling da UI no browser.
 * JSON final: métricas API (ordem fica aberta — cancelar depois).
 *
 * Uso: node scripts/measure-order-ui-round.js <round>
 */
import fs from 'node:fs';
import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../src/clob/buildClient.js';
import { createSigner } from '../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../src/markets/btc5m.js';

const round = Number(process.argv[2] || 1);
const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
const event = await findActiveBtc5mEvent();
if (!event?.upTokenId) throw new Error('Nenhum evento BTC 5m ativo.');

const tSendStart = Date.now();
fs.mkdirSync('runs', { recursive: true });
fs.writeFileSync(`runs/ui-latency-sync-${round}.json`, JSON.stringify({ round, tSendStart }));
console.log(`SYNC\t${round}\t${tSendStart}`);

const resp = await client.createAndPostOrder(
  { tokenID: event.upTokenId, price: 0.01, side: Side.BUY, size: 5 },
  undefined,
  OrderType.GTC,
  true,
  false,
);
const tApiResponse = Date.now();
const orderId = resp?.orderID;
if (!resp?.success || !orderId) {
  console.log(JSON.stringify({ round, ok: false, error: resp?.errorMsg || 'rejeitada', tSendStart, tApiResponse }));
  process.exit(1);
}

let tClobVisible = null;
let clobPolls = 0;
for (let i = 0; i < 80; i++) {
  clobPolls += 1;
  const open = await client.getOpenOrders();
  if (open.some((o) => o.id === orderId)) {
    tClobVisible = Date.now();
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log(JSON.stringify({
  round,
  ok: true,
  orderId,
  event: event.title,
  status: resp.status,
  tSendStart,
  tApiResponse,
  tClobVisible,
  apiRoundTripMs: tApiResponse - tSendStart,
  clobVisibleMs: tClobVisible ? tClobVisible - tSendStart : null,
  clobPolls,
}));
