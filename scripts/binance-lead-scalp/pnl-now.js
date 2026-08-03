#!/usr/bin/env node
import 'dotenv/config';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';

const e = await findActiveBtc5mEvent();
const c = buildClobClient({ wallet: createSigner(process.env.POLYMARKET_PRIVATE_KEY) });
const up = await c.getOrderBook(e.upTokenId);
const dn = await c.getOrderBook(e.downTokenId);
const end = e.eventEnd instanceof Date ? e.eventEnd.getTime() : Number(e.eventEnd);
const tau = Math.floor((end - Date.now()) / 1000);
const sh = 16.67;
const entry = 0.6;
const cost = sh * entry;
const bid = Number(up.bids?.[0]?.price);
const ask = Number(up.asks?.[0]?.price);
console.log(
  JSON.stringify(
    {
      slug: e.slug,
      tau,
      upBid: bid,
      upAsk: ask,
      dnBid: Number(dn.bids?.[0]?.price),
      dnAsk: Number(dn.asks?.[0]?.price),
      cost,
      ifDumpNow: Math.round((bid * sh - cost) * 100) / 100,
      ifRescueFill061: Math.round((0.61 * sh - cost) * 100) / 100,
      ifSettle0: Math.round((0 - cost) * 100) / 100,
      ifSettle1: Math.round((1 * sh - cost) * 100) / 100,
    },
    null,
    2,
  ),
);
