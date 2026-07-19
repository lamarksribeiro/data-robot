/**
 * Execution sinks — mesmo pipeline; só o destino muda.
 * P3+: dry-run / shadow / live passam pelo OMS (createOmsSink).
 * Helpers legados mantidos para testes unitários pontuais.
 */

import { createOmsSink } from '../oms/omsSink.js';

/**
 * @typedef {object} SinkResult
 * @property {boolean} accepted
 * @property {import('./schemas.js').ExecutionEvent[]} events
 */

export function createDryRunSink(opts = {}) {
  return createOmsSink({ mode: 'dry-run', ...opts });
}

export function createShadowSink(opts = {}) {
  return createOmsSink({ mode: 'shadow', simBehavior: opts.behavior, ...opts });
}

/** Live stub via OMS — não chama CLOB real. */
export function createLiveStubSink(opts = {}) {
  return createOmsSink({ mode: 'live', ...opts });
}

/**
 * @param {'dry-run'|'shadow'|'live'} mode
 * @param {object} [opts]
 */
export function createSinkForMode(mode, opts = {}) {
  if (mode === 'dry-run') return createDryRunSink(opts);
  if (mode === 'shadow') return createShadowSink(opts);
  if (mode === 'live') return createLiveStubSink(opts);
  throw new Error(`mode inválido: ${mode}`);
}
