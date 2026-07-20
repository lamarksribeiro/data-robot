#!/usr/bin/env node
/**
 * Processo da engine (separado da UI sirv :3200).
 * Default: shadow + fixture-price-cross, control HTTP :3201.
 *
 *   npm run engine:serve
 *   ENGINE_PORT=3201 npm run engine:serve
 *
 * Não envia ordens reais (live stub / shadow only unless ENGINE_MODE=live + ENGINE_LIVE_ENABLED=1).
 */

import 'dotenv/config';
import { createEngineApp } from '../src/control/engineApp.js';

const mode = process.env.ENGINE_MODE || 'shadow';
const liveEnabled = process.env.ENGINE_LIVE_ENABLED === '1';
const host = process.env.ENGINE_HOST || '0.0.0.0';
const opsToken = process.env.ENGINE_OPS_TOKEN;

if (mode === 'live' && !liveEnabled) {
  console.error('[engine:serve] Recusa: ENGINE_MODE=live exige ENGINE_LIVE_ENABLED=1');
  process.exit(2);
}

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !opsToken) {
  console.error('[engine:serve] Recusa: ENGINE_OPS_TOKEN é obrigatório fora de localhost');
  process.exit(2);
}

const app = createEngineApp({
  mode,
  liveEnabled,
  strategyId: process.env.ENGINE_STRATEGY_ID || 'fixture-price-cross',
  port: Number(process.env.ENGINE_PORT || 3201),
  host,
  opsToken,
  serveHttp: true,
  restoreOnStart: true,
  persistOnStop: true,
  autoCheckpointMs: Number(process.env.ENGINE_CHECKPOINT_MS || 30_000),
});

await app.start();
console.log(`[engine:serve] mode=${mode} strategy=${process.env.ENGINE_STRATEGY_ID || 'fixture-price-cross'} port=${app.httpServer.port}`);

async function shutdown(signal) {
  console.log(`[engine:serve] ${signal} — shutdown`);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
