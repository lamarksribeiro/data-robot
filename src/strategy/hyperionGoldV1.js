/**
 * Plugin de Estratégia Hyperion Gold V1 (hyperion-gold-v1).
 * Unifica o Binance Lead-Lag, MIDAS High-Ask Carry e a gestão E-Gold em um plugin autônomo e desacoplado.
 */

import { makeIntentId } from '../engine/schemas.js';
import {
  HYPERION_GOLD_V1,
  resolveHyperionEntryBudget,
} from '../tfc/preset-hyperion-gold.js';
import {
  evaluateBinanceLeadGate,
  evaluateHighAskEnvelope,
  evaluateHyperionOddsShockExit,
  signedDistance,
} from '../tfc/hyperionGoldEvaluate.js';
import { sizeCanaryBuy } from '../tfc/sizeCanaryBuy.js';

export const HYPERION_GOLD_V1_STRATEGY_ID = 'hyperion-gold-v1';
export const HYPERION_GOLD_V1_PRESET_ID = 'btc-hyperion-gold-v1';

const HISTORY_MAX = 600;

function mergePreset(preset = {}) {
  return { ...HYPERION_GOLD_V1, ...preset };
}

function resolveTokenId(snapshot, side) {
  const identity = snapshot?.identity ?? {};
  if (side === 'UP') return identity.upTokenId ?? null;
  if (side === 'DOWN') return identity.downTokenId ?? null;
  return null;
}

function buildEnterIntent(ctx, snapshot, params, state, side, ask, budget, reason) {
  const slippage = Number(params.entrySlippageMax ?? 0.02);
  const maxPrice = Math.min(0.99, ask + slippage);
  const orderType = params.entryOrderType ?? 'FAK';
  
  const sized = sizeCanaryBuy({
    ask,
    maxPrice,
    entryBudget: Number(budget),
    minShares: 1,
    minNotional: orderType === 'FAK' || orderType === 'FOK' ? undefined : 0,
  });

  state.seq = (state.seq ?? 0) + 1;
  state.lastIntentKind = 'ENTER';

  return {
    intentId: makeIntentId({
      strategyInstanceId: ctx.strategyInstanceId,
      marketId: snapshot.marketId,
      kind: 'ENTER',
      seq: state.seq,
    }),
    kind: 'ENTER',
    side,
    marketId: snapshot.marketId,
    strategyInstanceId: ctx.strategyInstanceId,
    budget: sized.notional,
    quantity: sized.quantity,
    maxPrice,
    minPrice: null,
    deadlineMs: ctx.clockMs + 5000,
    reason,
    presetId: HYPERION_GOLD_V1_PRESET_ID,
    orderType,
    tokenId: resolveTokenId(snapshot, side),
  };
}

function buildExitIntent(ctx, snapshot, params, state, side, bid, reason) {
  state.seq = (state.seq ?? 0) + 1;
  state.lastIntentKind = 'EXIT';
  const orderType = params.exitOrderType ?? 'GTC';
  const floor = Number(params.stopMinBid ?? 0.05);
  const minPrice = Math.max(floor, bid - 0.02);

  return {
    intentId: makeIntentId({
      strategyInstanceId: ctx.strategyInstanceId,
      marketId: snapshot.marketId,
      kind: 'EXIT',
      seq: state.seq,
    }),
    kind: 'EXIT',
    side,
    marketId: snapshot.marketId,
    strategyInstanceId: ctx.strategyInstanceId,
    budget: 0,
    quantity: null,
    maxPrice: null,
    minPrice,
    deadlineMs: ctx.clockMs + 5000,
    reason,
    presetId: HYPERION_GOLD_V1_PRESET_ID,
    orderType,
    tokenId: resolveTokenId(snapshot, side),
  };
}

export function createHyperionGoldV1Strategy(ctx = {}, options = {}) {
  const defaultParams = mergePreset(options.preset);
  let state = { seq: 0, history: [] };

  const strategyObj = {
    manifest: {
      id: HYPERION_GOLD_V1_STRATEGY_ID,
      version: '1.0.0',
      stateVersion: 1,
      supportedMarkets: ['btc-updown-5m'],
      capabilities: ['price', 'book'],
      description: 'Nova Estratégia Autônoma Hyperion Gold V1 — Binance Lead + MIDAS High-Ask + E-Gold.',
      presetId: HYPERION_GOLD_V1_PRESET_ID,
    },

    strategyId: HYPERION_GOLD_V1_STRATEGY_ID,

    validatePreset(preset) {
      const p = mergePreset(preset);
      return { ok: true, params: p };
    },

    initialize(_initCtx, preset) {
      const p = mergePreset(preset);
      state = { seq: 0, history: [] };
      return { state, params: p };
    },

    onSnapshot(engineCtx, engineState) {
      const currentSnapshot = engineCtx.snapshot;
      const currentPos = engineCtx.position ? { side: engineCtx.position.side, quantity: engineCtx.position.qty, entryPrice: engineCtx.position.avgPrice } : null;
      const evalRes = strategyObj.evaluate(currentSnapshot, currentPos);
      return { state: evalRes.nextState, intents: evalRes.intents, diagnostics: {} };
    },

    onExecutionEvent(_engineCtx, engineState, _event) {
      return { state: engineState, intents: [], diagnostics: {} };
    },

    reset() {
      state = { seq: 0, history: [] };
    },

    evaluate(snapshot, position) {
      if (snapshot?.feeds?.healthy === false) {
        return { intents: [], nextState: state };
      }

      const nowMs = snapshot.nowMs ?? ctx?.clockMs ?? Date.now();
      const currentBtc = snapshot.btc;

      // Atualiza histórico spot e oppAsk
      const oppSide = position?.side === 'UP' ? 'down' : 'up';
      const oppAsk = snapshot.book?.[oppSide]?.asks?.[0]?.price;

      if (Number.isFinite(currentBtc)) {
        state.history.push({ ts: nowMs, btc: currentBtc, oppAsk });
        if (state.history.length > HISTORY_MAX) {
          state.history.splice(0, state.history.length - HISTORY_MAX);
        }
      }

      // 1. SE EM POSIÇÃO: AVALIA SAÍDAS PROTETORAS (Odds Shock)
      if (position && Number(position.quantity) > 0) {
        const shockEval = evaluateHyperionOddsShockExit(snapshot, position, defaultParams, state.history);
        if (shockEval.trigger) {
          const exitIntent = buildExitIntent(
            ctx,
            snapshot,
            defaultParams,
            state,
            position.side,
            shockEval.bid,
            shockEval.reason
          );
          return { intents: [exitIntent], nextState: state };
        }
        return { intents: [], nextState: state };
      }

      // 2. SE FLAT: AVALIA ENTRADAS DEDICADAS HYPERION GOLD
      const secondsLeft = snapshot.secondsLeft;
      const strikeUsd = snapshot.strikeUsd;
      const upAsk = snapshot.book?.up?.asks?.[0]?.price;
      const downAsk = snapshot.book?.down?.asks?.[0]?.price;

      if (!Number.isFinite(secondsLeft) || !Number.isFinite(strikeUsd) || !Number.isFinite(currentBtc)) {
        return { intents: [], nextState: state };
      }

      // Identifica o lado candidato (o favorito do momento)
      let side = null;
      let ask = null;

      if (Number.isFinite(upAsk) && upAsk >= defaultParams.minAsk && upAsk <= defaultParams.maxAsk) {
        side = 'UP';
        ask = upAsk;
      } else if (Number.isFinite(downAsk) && downAsk >= defaultParams.minAsk && downAsk <= defaultParams.maxAsk) {
        side = 'DOWN';
        ask = downAsk;
      }

      if (!side || !ask) {
        return { intents: [], nextState: state };
      }

      const dist = signedDistance(currentBtc, strikeUsd, side);
      const envelopeCheck = evaluateHighAskEnvelope(ask, dist, secondsLeft, defaultParams);
      if (!envelopeCheck.ok) {
        return { intents: [], nextState: state };
      }

      const leadCheck = evaluateBinanceLeadGate(snapshot, side, defaultParams, state.history);
      if (!leadCheck.ok) {
        return { intents: [], nextState: state };
      }

      // Se passou nos envelopes, dimensiona o budget E-Gold e gera intenção
      const budget = resolveHyperionEntryBudget(ask, defaultParams);
      const enterIntent = buildEnterIntent(
        ctx,
        snapshot,
        defaultParams,
        state,
        side,
        ask,
        budget,
        `HYPERION_GOLD_ENTRY:${leadCheck.reason}`
      );

      return { intents: [enterIntent], nextState: state };
    },

    describe() {
      return {
        strategyId: HYPERION_GOLD_V1_STRATEGY_ID,
        presetId: HYPERION_GOLD_V1_PRESET_ID,
        description: 'Nova Estratégia Autônoma Hyperion Gold V1 — Binance Lead + MIDAS High-Ask + E-Gold.',
      };
    },
  };

  return strategyObj;
}
