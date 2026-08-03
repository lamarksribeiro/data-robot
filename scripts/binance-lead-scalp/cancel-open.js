#!/usr/bin/env node
import 'dotenv/config';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
console.log('signer', wallet.address);
try {
  const r = await client.cancelAll();
  console.log('cancelAll', JSON.stringify(r));
} catch (e) {
  console.log('cancelAll err', e.message);
}
try {
  const oo = await client.getOpenOrders();
  const list = Array.isArray(oo) ? oo : oo?.data || [];
  console.log('openOrders', list.length);
  for (const o of list.slice(0, 20)) {
    console.log(
      o.id || o.orderID || o.order_id,
      o.side,
      o.price,
      o.original_size || o.size,
      o.size_matched,
      o.status,
      String(o.asset_id || o.tokenID || '').slice(0, 18),
    );
  }
} catch (e) {
  console.log('openOrders err', e.message);
}
