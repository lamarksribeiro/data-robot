#!/usr/bin/env node
import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';

const side = (process.argv[2] || 'UP').toUpperCase();
const shares = Number(process.argv[3] || 20.41);

const event = await findActiveBtc5mEvent();
if (!event) throw new Error('no event');
const tokenId = side === 'UP' ? event.upTokenId : event.downTokenId;
console.log('slug', event.slug, 'side', side, 'token', String(tokenId).slice(0, 24));

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
await client.cancelAll().catch(() => {});

const book = await client.getOrderBook(tokenId);
const bid = Number(book?.bids?.[0]?.price);
const px = Math.max(0.01, Math.round((Number.isFinite(bid) ? bid : 0.01) * 100) / 100);
const sh = Math.round(shares * 100) / 100;
console.log('SELL', { px, sh, bid });

const resp = await client.createAndPostOrder(
  { tokenID: tokenId, price: px, side: Side.SELL, size: sh },
  undefined,
  OrderType.FAK,
  false,
  false,
);
console.log('resp', {
  success: resp?.success,
  orderID: resp?.orderID,
  status: resp?.status,
  errorMsg: resp?.errorMsg,
  takingAmount: resp?.takingAmount,
});
if (resp?.orderID) {
  await new Promise((r) => setTimeout(r, 600));
  const o = await client.getOrder(resp.orderID);
  console.log('order', {
    status: o?.status,
    matched: o?.size_matched,
    original: o?.original_size,
    price: o?.price,
  });
}
