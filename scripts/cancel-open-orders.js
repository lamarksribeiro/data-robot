#!/usr/bin/env node
import 'dotenv/config';
import { buildClobClient } from '../src/clob/buildClient.js';
import { createSigner } from '../src/clob/wallet.js';

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
const open = await client.getOpenOrders();
let canceled = 0;
for (const o of open) {
  const r = await client.cancelOrder({ orderID: o.id });
  if (r?.canceled?.includes?.(o.id) || r?.success) canceled += 1;
}
console.log(JSON.stringify({ openBefore: open.length, canceled, openAfter: (await client.getOpenOrders()).length }));
