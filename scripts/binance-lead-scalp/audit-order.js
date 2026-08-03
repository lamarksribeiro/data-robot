#!/usr/bin/env node
import 'dotenv/config';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';

const ORDER =
  process.argv[2] ||
  '0xdcac59508900a9e63472edde1f2eb441a7385497a79bc935e6b795a616f89962';

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });
console.log('signer', wallet.address);

try {
  const o = await client.getOrder(ORDER);
  console.log('ORDER', JSON.stringify(o, null, 2));
} catch (e) {
  console.log('getOrder err', e.message);
}

try {
  const trades = await client.getTrades?.({ limit: 20 });
  const list = Array.isArray(trades) ? trades : trades?.data || [];
  console.log('tradesN', list.length);
  for (const t of list.slice(0, 15)) {
    console.log(
      JSON.stringify({
        id: t.id || t.trade_id,
        side: t.side,
        price: t.price,
        size: t.size,
        status: t.status,
        match_time: t.match_time || t.timestamp,
        asset: String(t.asset_id || '').slice(0, 20),
        market: String(t.market || '').slice(0, 24),
      }),
    );
  }
} catch (e) {
  console.log('getTrades err', e.message);
}
