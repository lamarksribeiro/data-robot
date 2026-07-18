/**
 * Estratégia fictícia A — só usa preço (btc vs threshold).
 * Prova que o runtime não precisa de TFC.
 */

import { makeIntentId } from '../../engine/schemas.js';

export function createPriceCrossStrategy() {
  return {
    manifest: {
      id: 'fixture-price-cross',
      version: '1.0.0',
      stateVersion: 1,
      supportedMarkets: ['btc-updown-5m'],
      capabilities: ['price'],
      description: 'ENTER UP quando btc >= threshold; EXIT quando abaixo.',
    },

    validatePreset(preset) {
      if (preset.threshold == null || !Number.isFinite(Number(preset.threshold))) {
        return { ok: false, reason: 'threshold numérico obrigatório' };
      }
      return { ok: true };
    },

    initialize(_ctx, preset) {
      return {
        state: { seq: 0, armed: true },
        diagnostics: { presetThreshold: Number(preset.threshold) },
      };
    },

    onSnapshot(ctx, state) {
      const threshold = Number(ctx.preset.threshold);
      const btc = ctx.snapshot.btc;
      const diagnostics = {
        btc,
        threshold,
        inPosition: ctx.position.qty > 0,
      };
      const intents = [];
      let seq = state.seq ?? 0;

      if (!Number.isFinite(btc)) {
        return { state, intents, diagnostics: { ...diagnostics, skip: 'no-btc' } };
      }

      if (ctx.position.qty <= 0 && btc >= threshold) {
        seq += 1;
        intents.push({
          intentId: makeIntentId({
            strategyInstanceId: ctx.strategyInstanceId,
            marketId: ctx.snapshot.marketId,
            kind: 'ENTER',
            seq,
          }),
          kind: 'ENTER',
          side: 'UP',
          marketId: ctx.snapshot.marketId,
          strategyInstanceId: ctx.strategyInstanceId,
          budget: Number(ctx.preset.budget ?? 1),
          quantity: null,
          maxPrice: Number(ctx.preset.maxPrice ?? 0.99),
          minPrice: null,
          deadlineMs: ctx.clockMs + 5000,
          reason: 'btc_crossed_threshold',
          presetId: 'fixture-price-cross',
        });
      }

      if (ctx.position.qty > 0 && btc < threshold) {
        seq += 1;
        intents.push({
          intentId: makeIntentId({
            strategyInstanceId: ctx.strategyInstanceId,
            marketId: ctx.snapshot.marketId,
            kind: 'EXIT',
            seq,
          }),
          kind: 'EXIT',
          side: ctx.position.side,
          marketId: ctx.snapshot.marketId,
          strategyInstanceId: ctx.strategyInstanceId,
          budget: null,
          quantity: ctx.position.qty,
          maxPrice: null,
          minPrice: Number(ctx.preset.minExitPrice ?? 0.01),
          deadlineMs: ctx.clockMs + 5000,
          reason: 'btc_below_threshold',
          presetId: 'fixture-price-cross',
        });
      }

      return { state: { ...state, seq }, intents, diagnostics };
    },

    onExecutionEvent(_ctx, state, event) {
      return {
        state: {
          ...state,
          lastEventType: event.type,
        },
        intents: [],
        diagnostics: { lastEventType: event.type },
      };
    },
  };
}
