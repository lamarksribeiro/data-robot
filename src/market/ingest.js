/**
 * Entrega snapshot à engine já filtrado por capabilities da strategy.
 */

import { filterSnapshotForCapabilities, assertCapabilitiesHonored } from './capabilities.js';
import { evaluateSnapshotEligibility } from './eligibility.js';

/**
 * @param {object} engine — createEngine/bootstrapEngine
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {string[]} [opts.capabilities] — default: engine strategy manifest via opts
 * @param {boolean} [opts.requireEligible=true]
 */
export async function ingestFilteredSnapshot(engine, snapshot, opts = {}) {
  const requireEligible = opts.requireEligible !== false;
  const capabilities = opts.capabilities ?? opts.strategyCapabilities ?? [];

  if (requireEligible) {
    const gate = snapshot.eligibility ?? evaluateSnapshotEligibility(snapshot);
    if (!gate.eligible) {
      return { skipped: true, reason: 'NOT_ELIGIBLE', reasons: gate.reasons };
    }
  }

  const filtered = filterSnapshotForCapabilities(snapshot, capabilities);
  assertCapabilitiesHonored(filtered, capabilities);

  // Engine schemas não conhecem identity/health extras — ok (campos extras ignorados)
  const result = await engine.ingestSnapshot(filtered);
  return { skipped: false, filtered, result };
}
