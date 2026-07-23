/**
 * Bootstrap MIDAS Carry V1 canário — budget micro + risk cap independente.
 */

import { createOmsSink } from '../oms/omsSink.js';
import { createLiveTransport } from '../executor/liveTransport.js';
import { createUserChannel } from '../executor/userChannel.js';
import { CANARY_LIMITS, canaryMidasPreset } from '../tfc/preset-midas.js';
import { MIDAS_V1_PRESET_ID, MIDAS_V1_STRATEGY_ID } from '../strategy/midasV1.js';
import { bootstrapEngine } from './bootstrap.js';

/**
 * @param {object} [opts]
 */
export function bootstrapMidasCanaryEngine(opts = {}) {
  const mode = opts.mode ?? 'dry-run';
  const liveEnabled = opts.liveEnabled === true;
  const preset = canaryMidasPreset(opts.preset);
  const cap = Number(opts.maxCanaryBudget ?? CANARY_LIMITS.maxCanaryBudget);

  if (mode === 'live' && !liveEnabled) {
    throw new Error('bootstrapMidasCanaryEngine: mode=live exige liveEnabled=true');
  }

  let transport = opts.transport;
  if (!opts.sink && !transport) {
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
        throw new Error('bootstrapMidasCanaryEngine: live exige client CLOB real');
      }
    }
  }

  const userChannel =
    opts.userChannel ??
    (mode === 'live' && opts.client?.kind === 'mock-clob'
      ? createUserChannel({ kind: 'sim', clock: opts.clock })
      : null);

  const sink =
    opts.sink ??
    createOmsSink({
      mode,
      transport,
      clock: opts.clock,
      userChannel,
      withUserChannel: opts.withUserChannel === true,
    });

  const engine = bootstrapEngine({
    strategyId: opts.strategyId ?? MIDAS_V1_STRATEGY_ID,
    mode,
    preset,
    sink,
    clock: opts.clock,
    liveEnabled,
    riskOpts: {
      ...(opts.riskOpts ?? {}),
      canaryMode: true,
      allowLiveReverse: opts.riskOpts?.allowLiveReverse !== false,
      maxCanaryBudget: cap,
      maxNotionalPerOrder: Math.min(cap, Number(opts.riskOpts?.maxNotionalPerOrder ?? cap)),
      maxNotionalPerEvent: Math.min(cap, Number(opts.riskOpts?.maxNotionalPerEvent ?? cap)),
      maxSlippage: opts.riskOpts?.maxSlippage ?? CANARY_LIMITS.maxSlippage,
      maxAccountExposure: opts.riskOpts?.maxAccountExposure ?? cap * 5,
      maxDailyLoss: opts.riskOpts?.maxDailyLoss ?? cap * 10,
    },
  });

  return Object.assign(engine, {
    canary: { maxCanaryBudget: cap, presetId: `${MIDAS_V1_PRESET_ID}-canary` },
    sink,
  });
}
