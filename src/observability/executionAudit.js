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

  return { dir, append };
}

