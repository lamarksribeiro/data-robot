#!/usr/bin/env node
/**
 * Sobe UI + Engine juntas no PC (shadow/local).
 *
 *   npm run local
 *
 * UI:     http://localhost:${PORT:-3200}
 * Engine: http://127.0.0.1:${ENGINE_PORT:-3201}
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiPort = Number(process.env.PORT || 3200);
const enginePort = Number(process.env.ENGINE_PORT || 3201);
// Local: engine em loopback (sem token público). UI ainda pode escutar em 0.0.0.0 via HOST/PORT.
const engineHost = process.env.ENGINE_HOST || '127.0.0.1';
const engineUrlRaw = process.env.ENGINE_INTERNAL_URL || `http://127.0.0.1:${enginePort}`;
const engineUrl = engineUrlRaw.includes('data-robot-engine')
  ? `http://127.0.0.1:${enginePort}`
  : engineUrlRaw;
// Token compartilhado UI↔engine (obrigatório se a engine não for só localhost)
const opsToken = process.env.ENGINE_OPS_TOKEN || 'local-dev-ops-token';

// Defaults locais: BTC 5m + shadow. Estratégia: active-strategy.json (UI) → env → midas.
const localEngineDefaults = {
  ENGINE_MODE: process.env.ENGINE_MODE || 'shadow',
  ENGINE_SNAPSHOT_SOURCE: process.env.ENGINE_SNAPSHOT_SOURCE || 'btc5m',
  ENGINE_STRATEGY_ID: process.env.ENGINE_STRATEGY_ID || 'midas-carry-v1',
};

const children = [];
let shuttingDown = false;

function prefixLines(prefix, chunk, write) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length) write(`${prefix}${line}\n`);
  }
}

function start(name, scriptRel) {
  const child = spawn(process.execPath, [path.join(root, scriptRel)], {
    cwd: root,
    env: {
      ...process.env,
      ...localEngineDefaults,
      ENGINE_INTERNAL_URL: engineUrl,
      ENGINE_PORT: String(enginePort),
      ENGINE_HOST: engineHost,
      ENGINE_OPS_TOKEN: opsToken,
      PORT: String(uiPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ name, child });

  const tag = `[${name}] `;
  child.stdout.on('data', (chunk) => prefixLines(tag, chunk, (s) => process.stdout.write(s)));
  child.stderr.on('data', (chunk) => prefixLines(tag, chunk, (s) => process.stderr.write(s)));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[local] ${name} saiu (code=${code} signal=${signal || '-'}) — encerrando o resto`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  // Windows: garante saída se algum filho prender
  setTimeout(() => process.exit(code), 800).unref?.();
}

console.log('[local] subindo engine + UI…');
console.log(`[local] dashboard → http://localhost:${uiPort}`);
console.log(`[local] engine    → http://127.0.0.1:${enginePort}`);
console.log(
  `[local] source=${localEngineDefaults.ENGINE_SNAPSHOT_SOURCE} · mode=${localEngineDefaults.ENGINE_MODE} · strategy=active-strategy.json|env|midas`,
);
console.log(`[local] login: DASHBOARD_USER / DASHBOARD_PASSWORD do .env`);
console.log('[local] Ctrl+C para parar os dois\n');

start('engine', 'scripts/engine-serve.js');
start('ui', 'scripts/ui-server.js');

process.on('SIGINT', () => {
  console.log('\n[local] SIGINT — parando…');
  shutdown(0);
});
process.on('SIGTERM', () => {
  console.log('\n[local] SIGTERM — parando…');
  shutdown(0);
});
