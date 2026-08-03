#!/usr/bin/env node
/** Lista open orders SEM cancelar. */
import 'dotenv/config';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
console.log('signer', wallet.address);
const oo = await client.getOpenOrders();
const list = Array.isArray(oo) ? oo : oo?.data || [];
console.log('openOrders', list.length);
for (const o of list) {
  console.log(
    JSON.stringify({
      id: o.id || o.orderID,
      side: o.side,
      price: o.price,
      original: o.original_size || o.size,
      matched: o.size_matched,
      status: o.status,
      outcome: o.outcome,
      asset: String(o.asset_id || '').slice(0, 22),
    }),
  );
}
