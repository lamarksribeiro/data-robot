#!/usr/bin/env node
/** Re-posta rescue SELL GTC no evento ativo. */
import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';

const side = (process.argv[2] || 'UP').toUpperCase();
const px = Number(process.argv[3] || 0.61);
const sh = Number(process.argv[4] || 16.67);

const event = await findActiveBtc5mEvent();
const tokenId = side === 'UP' ? event.upTokenId : event.downTokenId;
console.log('slug', event.slug, 'side', side, 'px', px, 'sh', sh);

const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
const client = buildClobClient({ wallet, throwOnError: true });

const resp = await client.createAndPostOrder(
  {
    tokenID: tokenId,
    price: Math.round(px * 100) / 100,
    side: Side.SELL,
    size: Math.round(sh * 100) / 100,
  },
  undefined,
  OrderType.GTC,
  false,
  false,
);
console.log({
  success: resp?.success,
  orderID: resp?.orderID,
  status: resp?.status,
  errorMsg: resp?.errorMsg,
});
