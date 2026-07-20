#!/usr/bin/env node
/**
 * Soak curto (CI) ou longo (ops). Sem CLOB real.
 *
 *   npm run engine:soak
 *   npm run engine:soak -- --iterations=500
 *   npm run engine:soak -- --duration-hours=168 --interval-ms=1000
 */

import { createEngineApp } from '../src/control/engineApp.js';
import { runSoak } from '../src/control/soak.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    iterations: Math.max(1, parseInt(valueOf('--iterations') ?? process.env.ENGINE_SOAK_ITERATIONS ?? '100', 10)),
    durationMs:
      Math.max(0, Number(valueOf('--duration-hours') ?? process.env.ENGINE_SOAK_HOURS ?? 0)) *
      60 *
      60 *
      1000,
    intervalMs: Math.max(0, Number(valueOf('--interval-ms') ?? process.env.ENGINE_SOAK_INTERVAL_MS ?? 0)),
    json: args.includes('--json'),
  };
}

const opts = parseArgs(process.argv);
const app = createEngineApp({
  mode: 'shadow',
  serveHttp: false,
  strategyId: 'fixture-price-cross',
});

await app.start();

const report = await runSoak(app, {
  iterations: opts.iterations,
  durationMs: opts.durationMs,
  intervalMs: opts.intervalMs,
  makeSnapshot: (i) => ({
    marketId: 'soak-mkt',
    nowMs: Date.now() + i,
    secsLeft: 20,
    btc: 100 + (i % 3),
    priceToBeat: 50,
    book: {
      up: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
      down: { bestBid: 0.4, bestAsk: 0.5, bids: [], asks: [] },
    },
    feeds: { healthy: true },
  }),
});

await app.stop();

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`=== soak ${opts.iterations} iterações ===`);
  console.log(`ok=${report.ok} divergences=${report.divergences} orphans=${report.orphans}`);
  console.log(`slos.ok=${report.slos.ok}`);
}

process.exit(report.ok ? 0 : 1);
