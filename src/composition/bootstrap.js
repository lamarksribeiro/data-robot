/**
 * Composition root — único lugar que liga engine ↔ plugins.
 * O core (src/engine) não importa src/strategy.
 */

import { createEngine } from '../engine/runtime.js';
import { StrategyRegistry } from '../engine/registry.js';
import { createSinkForMode } from '../engine/sinks.js';
import { createRiskEngine } from '../risk/createRiskEngine.js';
import { createAccountRiskBook } from '../risk/accountBook.js';
import { ingestFilteredSnapshot } from '../market/ingest.js';
import { createPriceCrossStrategy } from '../strategy/fixtures/priceCross.js';
import { createSpreadWideStrategy } from '../strategy/fixtures/spreadWide.js';
import { createTfcV7Strategy } from '../strategy/tfcV7.js';
import { defaultPresetFor } from './presets.js';

/**
 * Registry com fixtures (P1) + TFC V7 (P6).
 */
export function createDefaultRegistry() {
  const registry = new StrategyRegistry();
  registry.register(createPriceCrossStrategy());
  registry.register(createSpreadWideStrategy());
  registry.register(createTfcV7Strategy());
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
 * @param {object} [opts.accountBook]
 * @param {() => number} [opts.clock]
 * @param {boolean} [opts.liveEnabled]
 */
export function bootstrapEngine(opts) {
  const registry = opts.registry ?? createDefaultRegistry();
  const strategy = registry.resolve(opts.strategyId);
  const mode = opts.mode ?? 'dry-run';
  const preset = opts.preset ?? defaultPresetFor(opts.strategyId);
  const clock = opts.clock;

  const risk =
    opts.risk ??
    createRiskEngine({
      clock,
      liveEnabled: opts.liveEnabled === true,
      accountBook: opts.accountBook,
      ...(opts.riskOpts ?? {}),
    });

  const engine = createEngine({
    mode,
    strategy,
    preset,
    strategyInstanceId: opts.strategyInstanceId,
    sink: opts.sink ?? createSinkForMode(mode, { clock }),
    risk,
    clock,
    liveEnabled: opts.liveEnabled === true,
    accountBook: opts.accountBook,
  });

  return Object.assign(engine, {
    strategyCapabilities: [...strategy.manifest.capabilities],
    /**
     * Ingest com filtro de capabilities + gate de elegibilidade.
     * @param {object} snapshot
     * @param {object} [gateOpts]
     */
    async ingestMarketSnapshot(snapshot, gateOpts = {}) {
      return ingestFilteredSnapshot(engine, snapshot, {
        capabilities: strategy.manifest.capabilities,
        requireEligible: gateOpts.requireEligible,
      });
    },
  });
}

export { createAccountRiskBook, createRiskEngine };
export { defaultPresetFor } from './presets.js';
