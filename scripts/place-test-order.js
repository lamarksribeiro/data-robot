#!/usr/bin/env node
/**
 * place-test-order.js — envia ordem limite pequena em mercado BTC 5m ativo.
 *
 * Uso:
 *   npm run test:order -- --wait 15          # deixa aberta 15s (ver UI)
 *   npm run test:order -- --cancel           # cancela após enviar
 *   npm run test:order -- --wait 15 --cancel
 */

import 'dotenv/config';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../src/clob/buildClient.js';
import { createSigner } from '../src/clob/wallet.js';

const GAMMA = 'https://gamma-api.polymarket.com';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    cancel: args.includes('--cancel'),
    waitSec: parseInt(valueOf('--wait') ?? '0', 10),
    price: parseFloat(valueOf('--price') ?? '0.01'),
    size: parseInt(valueOf('--size') ?? '5', 10),
    json: args.includes('--json'),
    postOnly: !args.includes('--no-post-only'),
  };
}

async function findActiveBtc5mEvent() {
  const url = `${GAMMA}/events?active=true&closed=false&limit=20&order=endDate&ascending=true`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
  const events = await res.json();
  const now = Date.now();
  const btc = (Array.isArray(events) ? events : [])
    .filter((e) => /bitcoin up or down/i.test(e.title || '') && /5m|5 min/i.test(e.title || ''))
    .filter((e) => new Date(e.endDate).getTime() > now + 30_000)
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  const event = btc[0];
  if (!event) return null;

  const market = event.markets?.[0];
  const tokens = typeof market?.clobTokenIds === 'string'
    ? JSON.parse(market.clobTokenIds)
    : market?.clobTokenIds;

  return {
    title: event.title,
    conditionId: market?.conditionId,
    upTokenId: tokens?.[0],
    downTokenId: tokens?.[1],
    endDate: event.endDate,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });

  const event = await findActiveBtc5mEvent();
  if (!event?.upTokenId) throw new Error('Nenhum evento BTC 5m ativo encontrado.');

  const resp = await client.createAndPostOrder(
    { tokenID: event.upTokenId, price: opts.price, side: Side.BUY, size: opts.size },
    undefined,
    OrderType.GTC,
    opts.postOnly,
    false,
  );

  const orderId = resp?.orderID;
  if (!resp?.success || !orderId) {
    throw new Error(resp?.errorMsg || 'Ordem rejeitada');
  }

  const summary = {
    event: event.title,
    orderId,
    status: resp.status,
    price: opts.price,
    size: opts.size,
    postOnly: opts.postOnly,
    apiKeyPrefix: process.env.POLYMARKET_API_KEY?.slice(0, 8),
  };

  if (opts.waitSec > 0) {
    for (let s = 1; s <= opts.waitSec; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      const open = await client.getOpenOrders();
      const live = open.filter((o) => o.id === orderId).length;
      if (!opts.json) console.log(`[${s}s] openOrders=${open.length} targetLive=${live > 0}`);
    }
    summary.waitSec = opts.waitSec;
    summary.message = 'Verifique polymarket.com/portfolio?tab=open';
  }

  if (opts.cancel) {
    const cancel = await client.cancelOrder({ orderID: orderId });
    summary.canceled = cancel?.canceled?.includes?.(orderId) ?? cancel?.success === true;
  } else {
    summary.canceled = false;
    summary.note = 'Ordem mantida aberta';
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== test order ===');
    console.log(`Evento:  ${summary.event}`);
    console.log(`OrderId: ${summary.orderId}`);
    console.log(`Status:  ${summary.status}`);
    if (summary.canceled) console.log('Cancelada após teste.');
    else console.log('Ordem ABERTA — confira a UI.');
  }
}

main().catch((err) => {
  console.error(`[test:order] ${err.message}`);
  process.exit(1);
});
