/** Evidência JSONL persistente para decisões e eventos operacionais do serviço. */

import fs from 'node:fs';
import path from 'node:path';

export function createExecutionAudit(opts = {}) {
  const dir = path.resolve(opts.dir ?? path.join('runs', 'execution-audit'));
  const clock = opts.clock ?? (() => Date.now());
  let currentDay = null;
  let currentFile = null;

  function fileForNow() {
    const day = new Date(clock()).toISOString().slice(0, 10);
    if (day !== currentDay) {
      fs.mkdirSync(dir, { recursive: true });
      currentDay = day;
      currentFile = path.join(dir, `engine-${day}.jsonl`);
    }
    return currentFile;
  }

  function append(type, payload = {}) {
    const row = { schemaVersion: 1, tsMs: clock(), type, ...payload };
    fs.appendFileSync(fileForNow(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  }

  function listRecent(limit = 100) {
    const max = Math.min(500, Math.max(1, Number(limit) || 100));
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('engine-') && name.endsWith('.jsonl'))
      .sort()
      .reverse();
    const rows = [];
    for (const name of files) {
      const lines = fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          rows.push({ type: 'audit_parse_error', file: name });
        }
        if (rows.length >= max) return rows;
      }
    }
    return rows;
  }

  return { dir, append, listRecent };
}
