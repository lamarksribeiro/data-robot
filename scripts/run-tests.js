#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = globSync('test/**/*.test.js', { cwd: root })
  .map((f) => path.join(root, f))
  .sort();

if (files.length === 0) {
  console.error('[test] Nenhum arquivo test/**/*.test.js encontrado.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
