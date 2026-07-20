/**
 * Bootstrap TFC V7 canário (P7) — budget micro + risk cap independente.
 */

import { createOmsSink } from '../oms/omsSink.js';
import { createLiveTransport } from '../executor/liveTransport.js';
import { createLiveTransportStub } from '../executor/transport.js';
import { CANARY_LIMITS, canaryPreset } from '../tfc/preset-v7.js';
import { TFC_V7_STRATEGY_ID } from '../strategy/tfcV7.js';
import { bootstrapEngine } from './bootstrap.js';

/**
 * @param {object} [opts]
 * @param {'dry-run'|'shadow'|'live'} [opts.mode]
 * @param {boolean} [opts.liveEnabled]
 * @param {object} [opts.preset]
 * @param {object} [opts.client] — ClobClient real ou mock
 * @param {object} [opts.Side]
 * @param {object} [opts.OrderType]
 * @param {object} [opts.transport] — override total
 * @param {object} [opts.riskOpts]
 * @param {() => number} [opts.clock]
 * @param {boolean} [opts.cancelOnComplete] — não usado aqui; script decide
 */
export function bootstrapTfcCanaryEngine(opts = {}) {
  const mode = opts.mode ?? 'dry-run';
  const liveEnabled = opts.liveEnabled === true;
  const preset = canaryPreset(opts.preset);
  const cap = Number(opts.maxCanaryBudget ?? CANARY_LIMITS.maxCanaryBudget);

  if (mode === 'live' && !liveEnabled) {
    throw new Error('bootstrapTfcCanaryEngine: mode=live exige liveEnabled=true');
  }

  let transport = opts.transport;
  if (!transport) {
    if (mode === 'live') {
      if (opts.client && opts.Side && opts.OrderType) {
        transport = createLiveTransport({
          client: opts.client,
          Side: opts.Side,
          OrderType: opts.OrderType,
          clock: opts.clock,
          postOnly: opts.postOnly === true,
        });
      } else {
        transport = createLiveTransportStub();
      }
    }
  }

  const sink =
    opts.sink ??
    createOmsSink({
      mode,
      transport,
      clock: opts.clock,
      withUserChannel: opts.withUserChannel === true,
    });

  const engine = bootstrapEngine({
    strategyId: opts.strategyId ?? TFC_V7_STRATEGY_ID,
    mode,
    preset,
    sink,
    clock: opts.clock,
    liveEnabled,
    riskOpts: {
      canaryMode: true,
      maxCanaryBudget: cap,
      maxNotionalPerOrder: Math.min(cap, Number(opts.riskOpts?.maxNotionalPerOrder ?? cap)),
      maxNotionalPerEvent: Math.min(cap, Number(opts.riskOpts?.maxNotionalPerEvent ?? cap)),
      maxSlippage: opts.riskOpts?.maxSlippage ?? CANARY_LIMITS.maxSlippage,
      maxAccountExposure: opts.riskOpts?.maxAccountExposure ?? cap * 5,
      maxDailyLoss: opts.riskOpts?.maxDailyLoss ?? cap * 10,
      ...(opts.riskOpts ?? {}),
      canaryMode: true,
      maxCanaryBudget: cap,
    },
  });

  return Object.assign(engine, {
    canary: { maxCanaryBudget: cap, presetId: 'btc-champion-v7-canary' },
    sink,
  });
}
