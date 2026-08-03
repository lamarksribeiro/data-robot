#!/usr/bin/env node
/**
 * Flatten residual inventory: FAK/GTC sell on token at bid.
 * Usage: node flatten-token.js <tokenId> [shares]
 */
import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';

const tokenId = process.argv[2];
const sharesArg = process.argv[3] ? Number(process.argv[3]) : null;
if (!tokenId) {
  console.error('usage: flatten-token.js <tokenId> [shares]');
  process.exit(1);
}

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
console.log('signer', wallet.address);

await client.cancelAll().catch(() => {});

let book;
try {
  book = await client.getOrderBook(tokenId);
} catch (e) {
  console.error('book err', e.message);
  process.exit(1);
}
const bid = Number(book?.bids?.[0]?.price ?? book?.bids?.[0]?.[0]);
console.log('bestBid', bid, 'asks0', book?.asks?.[0]);

const sh = sharesArg && sharesArg > 0 ? sharesArg : 20.41;
const px = Math.max(0.01, Math.round((bid || 0.01) * 100) / 100);
console.log('SELL FAK', { tokenId: tokenId.slice(0, 20), px, sh });

try {
  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price: px, side: Side.SELL, size: Math.round(sh * 100) / 100 },
    undefined,
    OrderType.FAK,
    false,
    false,
  );
  console.log('FAK', JSON.stringify({
    success: resp?.success,
    orderID: resp?.orderID,
    status: resp?.status,
    errorMsg: resp?.errorMsg,
    takingAmount: resp?.takingAmount,
  }));
  if (resp?.orderID) {
    await new Promise((r) => setTimeout(r, 500));
    const o = await client.getOrder(resp.orderID);
    console.log('order', JSON.stringify({
      status: o?.status,
      matched: o?.size_matched,
      original: o?.original_size,
      price: o?.price,
    }));
  }
} catch (e) {
  console.error('sell err', e.message);
}

const oo = await client.getOpenOrders();
const list = Array.isArray(oo) ? oo : oo?.data || [];
console.log('openOrders', list.length);
