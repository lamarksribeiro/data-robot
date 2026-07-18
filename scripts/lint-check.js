#!/usr/bin/env node
/**
 * Lint mínimo: syntax check de todos os .js do projeto (exceto node_modules).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'runs', 'public']);

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = listJs(root);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    const rel = path.relative(root, file);
    console.error(`FAIL ${rel}`);
    const msg = err.stderr?.toString?.() || err.message;
    console.error(msg);
  }
}

if (failed > 0) {
  console.error(`\n[lint] ${failed}/${files.length} arquivo(s) com erro de sintaxe.`);
  process.exit(1);
}

console.log(`[lint] OK — ${files.length} arquivo(s) Node --check`);
