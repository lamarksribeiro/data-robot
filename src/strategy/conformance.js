/**
 * Suíte de conformidade — qualquer strategy plugável deve passar.
 * Usada pelos fixtures P1 e, depois, por TFC/Apex.
 */

import { assertStrategyContract, buildStrategyContext, normalizeStrategyResult } from '../engine/contract.js';
import { emptyPosition } from '../engine/schemas.js';

/**
 * @param {object} strategy
 * @param {object} [opts]
 * @param {object} [opts.preset]
 * @param {object} [opts.snapshot]
 */
export function runConformanceSuite(strategy, opts = {}) {
  const errors = [];
  const ok = (name) => ({ name, pass: true });
  const fail = (name, message) => {
    errors.push({ name, message });
    return { name, pass: false, message };
  };

  const checks = [];

  try {
    assertStrategyContract(strategy);
    checks.push(ok('contract'));
  } catch (err) {
    checks.push(fail('contract', err.message));
    return { pass: false, checks, errors };
  }

  const preset = opts.preset ?? {};
  let validation;
  try {
    validation = strategy.validatePreset(preset);
    if (validation?.ok === false) {
      checks.push(fail('validatePreset', validation.reason ?? 'ok=false'));
    } else {
      checks.push(ok('validatePreset'));
    }
  } catch (err) {
    checks.push(fail('validatePreset', err.message));
  }

  const snapshot = opts.snapshot ?? {
    marketId: 'conformance-mkt',
    nowMs: 1_700_000_000_000,
    secsLeft: 20,
    btc: 100,
    priceToBeat: 99,
    book: {
      up: { bestBid: 0.5, bestAsk: 0.52, bids: [{ size: 1 }], asks: [{ size: 1 }] },
      down: { bestBid: 0.48, bestAsk: 0.5, bids: [{ size: 1 }], asks: [{ size: 1 }] },
    },
    feeds: { healthy: true },
    acceptingOrders: true,
  };

  const baseCtx = buildStrategyContext({
    snapshot,
    position: emptyPosition({ marketId: snapshot.marketId }),
    mode: 'shadow',
    clockMs: snapshot.nowMs,
    preset,
    strategyInstanceId: `${strategy.manifest.id}:conformance`,
  });

  let state = {};
  try {
    const init = strategy.initialize(baseCtx, preset);
    state = init?.state ?? {};
    if (!state || typeof state !== 'object') {
      checks.push(fail('initialize', 'state deve ser objeto'));
    } else {
      checks.push(ok('initialize'));
    }
  } catch (err) {
    checks.push(fail('initialize', err.message));
  }

  try {
    const raw = strategy.onSnapshot(baseCtx, state);
    const normalized = normalizeStrategyResult(raw, {
      strategyInstanceId: baseCtx.strategyInstanceId,
    });
    state = normalized.state;
    checks.push(ok('onSnapshot'));
  } catch (err) {
    checks.push(fail('onSnapshot', err.message));
  }

  try {
    const raw = strategy.onExecutionEvent(baseCtx, state, {
      eventId: 'conf-1',
      type: 'ACK',
      intentId: null,
      side: null,
      qty: 0,
      price: null,
      reason: 'conformance',
      tsMs: snapshot.nowMs,
    });
    normalizeStrategyResult(raw, { strategyInstanceId: baseCtx.strategyInstanceId });
    checks.push(ok('onExecutionEvent'));
  } catch (err) {
    checks.push(fail('onExecutionEvent', err.message));
  }

  // JSON-serializable state
  try {
    JSON.stringify(state);
    checks.push(ok('stateSerializable'));
  } catch (err) {
    checks.push(fail('stateSerializable', err.message));
  }

  // Reject empty preset if strategy requires fields — soft check via validatePreset({})
  try {
    const emptyValidation = strategy.validatePreset({});
    checks.push(
      ok(
        emptyValidation?.ok === false
          ? 'validatePresetRejectsEmpty'
          : 'validatePresetAllowsEmpty',
      ),
    );
  } catch (err) {
    checks.push(fail('validatePresetEmpty', err.message));
  }

  return {
    pass: errors.length === 0,
    strategyId: strategy.manifest.id,
    checks,
    errors,
  };
}
