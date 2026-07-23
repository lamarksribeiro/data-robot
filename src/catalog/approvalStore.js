/** Catálogo persistente de plugins e gates de promoção. */

import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_STATES = Object.freeze([
  'registered',
  'shadow-approved',
  'canary-approved',
  'live-approved',
  'blocked',
]);

const RANK = Object.freeze({
  registered: 0,
  'shadow-approved': 1,
  'canary-approved': 2,
  'live-approved': 3,
  blocked: -1,
});

function requiredApproval(mode) {
  if (mode === 'live') return 'canary-approved';
  if (mode === 'shadow') return 'shadow-approved';
  return 'registered';
}

function validateCatalog(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.strategies)) {
    throw new Error('catálogo inválido: strategies[] obrigatório');
  }
  const keys = new Set();
  for (const entry of data.strategies) {
    if (!entry?.strategyId || !entry?.version || !entry?.presetId) {
      throw new Error('catálogo inválido: strategyId/version/presetId obrigatórios');
    }
    if (!APPROVAL_STATES.includes(entry.approval)) {
      throw new Error(`catálogo inválido: approval ${entry.approval}`);
    }
    if (!Array.isArray(entry.marketScope) || entry.marketScope.length === 0) {
      throw new Error(`catálogo inválido: marketScope vazio para ${entry.strategyId}`);
    }
    const key = `${entry.strategyId}:${entry.version}:${entry.presetId}`;
    if (keys.has(key)) throw new Error(`catálogo duplicado: ${key}`);
    keys.add(key);
  }
  return data;
}

export function createApprovalStore(opts = {}) {
  const file = path.resolve(opts.file ?? path.join('config', 'strategy-catalog.json'));

  function load() {
    if (!fs.existsSync(file)) throw new Error(`catálogo não encontrado: ${file}`);
    return validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  function save(catalog) {
    const valid = validateCatalog(catalog);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ ...valid, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(temp, file);
    return load();
  }

  function resolve(query) {
    return (
      load().strategies.find(
        (entry) =>
          entry.strategyId === query.strategyId &&
          entry.version === query.version &&
          entry.presetId === query.presetId,
      ) ?? null
    );
  }

  function assertApproved(query) {
    const entry = resolve(query);
    if (!entry) {
      throw new Error(
        `deployment não registrado: ${query.strategyId}:${query.version}:${query.presetId}`,
      );
    }
    if (!entry.marketScope.includes(query.marketScope)) {
      throw new Error(`marketScope não aprovado: ${query.marketScope}`);
    }
    const required = requiredApproval(query.mode);
    if (entry.approval === 'blocked' || RANK[entry.approval] < RANK[required]) {
      throw new Error(`aprovação insuficiente: ${entry.approval}; exige ${required}`);
    }
    return { ...entry, requiredApproval: required };
  }

  return { file, load, save, resolve, assertApproved };
}

