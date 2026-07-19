#!/usr/bin/env node
/**
 * Garante que o core futuro não importe plugins de estratégia.
 * Pastas protegidas: src/engine, src/oms, src/risk, src/journal, src/executor, src/reconciler
 * Não podem importar: src/strategy/*, src/tfc/*
 *
 * ADR: docs/arquitetura/adr-001-engine-strategy-separation.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIRS = ['engine', 'oms', 'risk', 'journal', 'executor', 'reconciler', 'market', 'observability', 'control'];

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function isForbiddenImport(spec) {
  const n = spec.replaceAll('\\', '/');
  if (n.includes('/tfc/') || n.includes('/strategy/')) return true;
  if (/(^|[./])tfc(\/|$)/.test(n)) return true;
  if (/(^|[./])strategy(\/|$)/.test(n)) return true;
  return false;
}

const importRe = /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
let violations = 0;

for (const name of CORE_DIRS) {
  const dir = path.join(root, 'src', name);
  for (const file of listJsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file).replaceAll('\\', '/');
    let match;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(text))) {
      const spec = match[1] ?? match[2] ?? '';
      if (isForbiddenImport(spec)) {
        console.error(`VIOLAÇÃO: ${rel} importa "${spec}"`);
        violations += 1;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n[check-architecture] ${violations} import(s) proibido(s).`);
  process.exit(1);
}

console.log('[check-architecture] OK — core não importa strategy/tfc (ou pastas core ainda vazias).');
