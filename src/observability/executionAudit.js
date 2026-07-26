/** Evidência JSONL persistente para decisões e eventos operacionais do serviço. */

import fs from 'node:fs';
import path from 'node:path';

function parseCsv(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeListOpts(limitOrOpts = 100) {
  if (limitOrOpts != null && typeof limitOrOpts === 'object' && !Array.isArray(limitOrOpts)) {
    const opts = limitOrOpts;
    const requested = Number(opts.limit ?? 200);
    return {
      limit: Number.isFinite(requested) ? Math.max(1, Math.min(5000, requested)) : 200,
      types: new Set(parseCsv(opts.types ?? opts.type)),
      excludeTypes: new Set(parseCsv(opts.excludeTypes ?? opts.exclude)),
      action: opts.action != null && opts.action !== '' ? String(opts.action) : null,
      ok:
        opts.ok === true || opts.ok === 'true'
          ? true
          : opts.ok === false || opts.ok === 'false'
            ? false
            : null,
      q: opts.q != null && String(opts.q).trim() !== '' ? String(opts.q).trim().toLowerCase() : null,
    };
  }
  const requested = Number(limitOrOpts ?? 100);
  return {
    limit: Number.isFinite(requested) ? Math.max(1, Math.min(5000, requested)) : 100,
    types: new Set(),
    excludeTypes: new Set(),
    action: null,
    ok: null,
    q: null,
  };
}

function rowMatches(row, filters) {
  const type = String(row?.type ?? '');
  if (filters.types.size && !filters.types.has(type)) return false;
  if (filters.excludeTypes.size && filters.excludeTypes.has(type)) return false;
  if (filters.action != null) {
    if (String(row?.action ?? '') !== filters.action) return false;
  }
  if (filters.ok != null) {
    if (row?.ok !== filters.ok) return false;
  }
  if (filters.q) {
    try {
      if (!JSON.stringify(row).toLowerCase().includes(filters.q)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} dir
 * @param {number} maxDays
 */
function pruneOldAuditFiles(dir, maxDays) {
  const keep = Math.max(1, Number(maxDays) || 3);
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^engine-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();
  for (const name of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* ignore prune race */
    }
  }
}

export function createExecutionAudit(opts = {}) {
  const dir = path.resolve(opts.dir ?? path.join('runs', 'execution-audit'));
  const clock = opts.clock ?? (() => Date.now());
  const maxDays = Math.max(1, Number(opts.maxDays ?? process.env.ENGINE_AUDIT_KEEP_DAYS ?? 3) || 3);
  let currentDay = null;
  let currentFile = null;
  let lastPruneDay = null;

  function fileForNow() {
    const day = new Date(clock()).toISOString().slice(0, 10);
    if (day !== currentDay) {
      fs.mkdirSync(dir, { recursive: true });
      currentDay = day;
      currentFile = path.join(dir, `engine-${day}.jsonl`);
    }
    if (lastPruneDay !== day) {
      pruneOldAuditFiles(dir, maxDays);
      lastPruneDay = day;
    }
    return currentFile;
  }

  function append(type, payload = {}) {
    const row = { schemaVersion: 1, tsMs: clock(), type, ...payload };
    fs.appendFileSync(fileForNow(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  }

  /**
   * @param {number|{limit?:number,types?:string|string[],excludeTypes?:string|string[],action?:string,ok?:boolean|string,q?:string}} [limitOrOpts]
   */
  function listRecent(limitOrOpts = 100) {
    const filters = normalizeListOpts(limitOrOpts);
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
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          row = { type: 'audit_parse_error', file: name };
        }
        if (!rowMatches(row, filters)) continue;
        rows.push(row);
        if (rows.length >= filters.limit) return rows;
      }
    }
    return rows;
  }

  // Limpa retenção ao criar (ex.: restart da engine).
  if (fs.existsSync(dir)) pruneOldAuditFiles(dir, maxDays);

  return { dir, maxDays, append, listRecent, prune: () => pruneOldAuditFiles(dir, maxDays) };
}
