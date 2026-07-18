/**
 * Composition root — único lugar que liga engine ↔ plugins.
 * O core (src/engine) não importa src/strategy.
 */

import { createEngine } from '../engine/runtime.js';
import { StrategyRegistry } from '../engine/registry.js';
import { createSinkForMode } from '../engine/sinks.js';
import { createBasicRisk } from '../engine/risk.js';
import { createPriceCrossStrategy } from '../strategy/fixtures/priceCross.js';
import { createSpreadWideStrategy } from '../strategy/fixtures/spreadWide.js';

/**
 * Registry com estratégias fictícias (prova P1) e hooks para plugins reais depois.
 */
export function createDefaultRegistry() {
  const registry = new StrategyRegistry();
  registry.register(createPriceCrossStrategy());
  registry.register(createSpreadWideStrategy());
  return registry;
}

/**
 * @param {object} opts
 * @param {string} opts.strategyId
 * @param {object} [opts.preset]
 * @param {'dry-run'|'shadow'|'live'} [opts.mode]
 * @param {import('../engine/registry.js').StrategyRegistry} [opts.registry]
 * @param {object} [opts.sink]
 * @param {object} [opts.risk]
 * @param {() => number} [opts.clock]
 */
export function bootstrapEngine(opts) {
  const registry = opts.registry ?? createDefaultRegistry();
  const strategy = registry.resolve(opts.strategyId);
  const mode = opts.mode ?? 'dry-run';
  const preset = opts.preset ?? {};

  return createEngine({
    mode,
    strategy,
    preset,
    strategyInstanceId: opts.strategyInstanceId,
    sink: opts.sink ?? createSinkForMode(mode),
    risk: opts.risk ?? createBasicRisk(opts.riskOpts),
    clock: opts.clock,
  });
}
