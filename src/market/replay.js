/**
 * Replay determinístico de MarketSnapshots (sem estratégia).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Campos omitidos do canonical (não afetam decisão / não-determinísticos locais). */
const DROP_FROM_CANONICAL = new Set([]);

/**
 * Serialização canônica: chaves ordenadas, estável para byte-compare.
 * @param {unknown} value
 */
export function canonicalize(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (DROP_FROM_CANONICAL.has(key)) continue;
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Remove campos voláteis de runtime antes de gravar/comparar.
 * @param {object} snapshot
 */
export function toReplayRecord(snapshot) {
  const { health, ...rest } = snapshot;
  // health é derivado — recalculável; gravamos feeds + identity
  return sortKeys({
    ...rest,
    // preserva reasons se já veio de eligibility (opcional)
    health: health
      ? {
          ok: health.ok,
          reasons: [...(health.reasons ?? [])].sort(),
          rtdsLagMs: health.rtdsLagMs ?? null,
          clobLagMs: health.clobLagMs ?? null,
        }
      : undefined,
  });
}

export function createReplayRecorder() {
  const records = [];
  return {
    push(snapshot) {
      records.push(toReplayRecord(snapshot));
    },
    get records() {
      return records.map((r) => structuredClone(r));
    },
    clear() {
      records.length = 0;
    },
    /**
     * @param {string} filePath
     */
    writeJsonl(filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const body = records.map((r) => canonicalize(r)).join('\n') + (records.length ? '\n' : '');
      fs.writeFileSync(filePath, body, 'utf8');
      return filePath;
    },
  };
}

/**
 * @param {string} filePath
 * @returns {object[]}
 */
export function loadReplayJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Re-serializa e compara byte-a-byte o canonical form.
 * @param {object[]} records
 */
export function assertReplayDeterministic(records) {
  const a = records.map((r) => canonicalize(toReplayRecord(r))).join('\n');
  const b = records.map((r) => canonicalize(toReplayRecord(JSON.parse(canonicalize(toReplayRecord(r)))))).join('\n');
  if (a !== b) {
    throw new Error('replay não é determinístico sob canonicalize');
  }
  return true;
}

/**
 * Itera records e chama onSnapshot(record) — sem engine/estratégia.
 * @param {object[]} records
 * @param {(snap: object, index: number) => void|Promise<void>} onSnapshot
 */
export async function replaySnapshots(records, onSnapshot) {
  let i = 0;
  for (const record of records) {
    await onSnapshot(structuredClone(record), i);
    i += 1;
  }
  return { count: i };
}
