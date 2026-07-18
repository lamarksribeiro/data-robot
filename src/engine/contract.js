/**
 * Contrato de estratégia (plugin). O core valida forma; não conhece TFC/Apex.
 *
 * strategy = {
 *   manifest: { id, version, stateVersion, supportedMarkets, capabilities },
 *   validatePreset(preset),
 *   initialize(context, preset),
 *   onSnapshot(context, strategyState),
 *   onExecutionEvent(context, strategyState, executionEvent),
 *   migrateState?.(oldState, fromVersion),
 * }
 */

import { assertStrategyResult } from './schemas.js';

const REQUIRED_MANIFEST = ['id', 'version', 'stateVersion', 'supportedMarkets', 'capabilities'];

/**
 * @param {unknown} strategy
 */
export function assertStrategyContract(strategy) {
  if (!strategy || typeof strategy !== 'object') {
    throw new Error('Strategy inválida');
  }
  const { manifest } = strategy;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Strategy.manifest obrigatório');
  }
  for (const key of REQUIRED_MANIFEST) {
    if (manifest[key] == null) throw new Error(`Strategy.manifest.${key} obrigatório`);
  }
  if (!Array.isArray(manifest.supportedMarkets) || manifest.supportedMarkets.length === 0) {
    throw new Error('Strategy.manifest.supportedMarkets deve ser array não vazio');
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error('Strategy.manifest.capabilities deve ser array');
  }
  for (const fn of ['validatePreset', 'initialize', 'onSnapshot', 'onExecutionEvent']) {
    if (typeof strategy[fn] !== 'function') {
      throw new Error(`Strategy.${fn} deve ser função`);
    }
  }
}

/**
 * Contexto somente leitura entregue à estratégia.
 * @param {object} parts
 */
export function buildStrategyContext(parts) {
  const {
    snapshot,
    position,
    openIntents = [],
    mode,
    clockMs,
    health = { ok: true },
    preset,
    strategyInstanceId,
    allowedExposure = null,
  } = parts;

  return Object.freeze({
    snapshot,
    position,
    openIntents: Object.freeze([...openIntents]),
    mode,
    clockMs,
    health: Object.freeze({ ...health }),
    preset: Object.freeze({ ...preset }),
    strategyInstanceId,
    allowedExposure,
  });
}

/**
 * Normaliza e valida o resultado do plugin.
 * @param {object} raw
 * @param {object} meta
 */
export function normalizeStrategyResult(raw, meta = {}) {
  const result = {
    state: raw?.state ?? {},
    intents: Array.isArray(raw?.intents) ? raw.intents : [],
    diagnostics: raw?.diagnostics ?? {},
  };
  assertStrategyResult(result);
  for (const intent of result.intents) {
    if (meta.strategyInstanceId && intent.strategyInstanceId !== meta.strategyInstanceId) {
      throw new Error('intent.strategyInstanceId diverge da instância');
    }
  }
  return result;
}
