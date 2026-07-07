#!/usr/bin/env node
/**
 * Mede latência round-trip CLOB: ping → create → getOpenOrders → cancel.
 * Ordem postOnly a 1¢ (não deve executar). Sempre cancela.
 *
 * Compare local (VPN) vs servidor de produção com --label:
 *   npm run tfc:latency -- --label=local
 *   npm run tfc:latency -- --label=giovanna --repeat=3
 *
 * Uso:
 *   npm run tfc:latency
 *   npm run tfc:latency -- --json
 *   npm run tfc:latency:compare
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { OrderType, Side } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import { collectRunMeta, measureClobPing } from '../../src/tfc/runMeta.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    json: args.includes('--json'),
    label: valueOf('--label') ?? process.env.TFC_RUN_LABEL ?? 'local',
    repeat: Math.max(1, parseInt(valueOf('--repeat') ?? '1', 10)),
    outDir: valueOf('--out') ?? 'runs',
    noSave: args.includes('--no-save'),
    note: valueOf('--note'),
  };
}

async function timed(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  return { label, ms: Math.round(performance.now() - t0), result };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function runOnce(client, event) {
  const price = 0.01;
  const size = 5;

  const clobPing = await measureClobPing();

  const create = await timed('createAndPostOrder', () =>
    client.createAndPostOrder(
      { tokenID: event.upTokenId, price, side: Side.BUY, size },
      undefined,
      OrderType.GTC,
      true,
      false,
    ),
  );

  const orderId = create.result?.orderID;
  if (!create.result?.success || !orderId) {
    throw new Error(create.result?.errorMsg || 'Falha ao criar ordem');
  }

  const getOpen = await timed('getOpenOrders', () => client.getOpenOrders());
  const visible = getOpen.result?.some?.((o) => o.id === orderId) ?? false;

  const cancel = await timed('cancelOrder', () => client.cancelOrder({ orderID: orderId }));

  return {
    orderId,
    price,
    size,
    postOnly: true,
    clobPingMs: clobPing.ms,
    clobPingOk: clobPing.ok,
    timingsMs: {
      create: create.ms,
      getOpen: getOpen.ms,
      cancel: cancel.ms,
      total: create.ms + getOpen.ms + cancel.ms,
    },
    visibleInGetOpenOrders: visible,
    canceled: cancel.result?.canceled?.includes?.(orderId) ?? cancel.result?.success === true,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });
  const event = await findActiveBtc5mEvent();
  if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

  const attempts = [];
  for (let i = 0; i < opts.repeat; i++) {
    attempts.push(await runOnce(client, event));
    if (i < opts.repeat - 1) await new Promise((r) => setTimeout(r, 500));
  }

  const last = attempts[attempts.length - 1];
  const aggregate = {
    repeat: opts.repeat,
    clobPingMs: median(attempts.map((a) => a.clobPingMs)),
    create: median(attempts.map((a) => a.timingsMs.create)),
    getOpen: median(attempts.map((a) => a.timingsMs.getOpen)),
    cancel: median(attempts.map((a) => a.timingsMs.cancel)),
    total: median(attempts.map((a) => a.timingsMs.total)),
  };

  const summary = {
    meta: collectRunMeta({ label: opts.label, kind: 'latency', note: opts.note }),
    event: event.title,
    attempts,
    aggregateMs: aggregate,
    last,
  };

  const runId = `latency-${opts.label}-${Date.now()}`;
  const outFile = path.join(opts.outDir, `${runId}.json`);

  if (!opts.noSave) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
    summary.outFile = outFile;
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`=== TFC latency [${opts.label}] ===`);
    console.log(`Host:     ${summary.meta.hostname} (${summary.meta.platform})`);
    if (opts.repeat > 1) {
      console.log(`Mediana (${opts.repeat}x): ping=${aggregate.clobPingMs} create=${aggregate.create} getOpen=${aggregate.getOpen} cancel=${aggregate.cancel} total=${aggregate.total} ms`);
    } else {
      console.log(`clobPing: ${last.clobPingMs} ms`);
      console.log(`create:   ${last.timingsMs.create} ms`);
      console.log(`getOpen:  ${last.timingsMs.getOpen} ms (visible=${last.visibleInGetOpenOrders})`);
      console.log(`cancel:   ${last.timingsMs.cancel} ms`);
      console.log(`total:    ${last.timingsMs.total} ms`);
    }
    if (summary.outFile) console.log(`Salvo:    ${summary.outFile}`);
    console.log('');
    console.log('Compare: npm run tfc:latency:compare');
  }
}

main().catch((err) => {
  console.error(`[tfc:latency] ${err.message}`);
  process.exit(1);
});
