#!/usr/bin/env node
import 'dotenv/config';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });

const buyId = '8e985488-e290-48f6-8c4b-fb46b3640d69';
const sellId = 'e74122c6-d0bc-45ea-891a-add3990a19c2';

async function findTrade(id) {
  const trades = await client.getTrades({ limit: 50 });
  const list = Array.isArray(trades) ? trades : trades?.data || [];
  return list.find((t) => (t.id || t.trade_id) === id) || null;
}

for (const id of [buyId, sellId]) {
  const t = await findTrade(id);
  console.log('====', id);
  console.log(JSON.stringify(t, null, 2));
}
