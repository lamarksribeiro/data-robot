/**
 * Estratégia fictícia B — usa book (spread).
 * Diferente da price-cross para provar registry multi-estratégia.
 */

import { makeIntentId } from '../../engine/schemas.js';

function midSpread(book) {
  const upAsk = book?.up?.bestAsk;
  const upBid = book?.up?.bestBid;
  if (upAsk == null || upBid == null) return null;
  return upAsk - upBid;
}

export function createSpreadWideStrategy() {
  return {
    manifest: {
      id: 'fixture-spread-wide',
      version: '1.0.0',
      stateVersion: 1,
      supportedMarkets: ['btc-updown-5m'],
      capabilities: ['price', 'book'],
      description: 'ENTER DOWN quando spread UP >= minSpread (fade).',
    },

    validatePreset(preset) {
      if (preset.minSpread == null || !Number.isFinite(Number(preset.minSpread))) {
        return { ok: false, reason: 'minSpread numérico obrigatório' };
      }
      return { ok: true };
    },

    initialize(_ctx, preset) {
      return {
        state: { seq: 0 },
        diagnostics: { minSpread: Number(preset.minSpread) },
      };
    },

    onSnapshot(ctx, state) {
      const minSpread = Number(ctx.preset.minSpread);
      const spread = midSpread(ctx.snapshot.book);
      const diagnostics = { spread, minSpread, qty: ctx.position.qty };
      const intents = [];
      let seq = state.seq ?? 0;

      if (spread == null) {
        return { state, intents, diagnostics: { ...diagnostics, skip: 'no-book' } };
      }

      if (ctx.position.qty <= 0 && spread >= minSpread) {
        seq += 1;
        intents.push({
          intentId: makeIntentId({
            strategyInstanceId: ctx.strategyInstanceId,
            marketId: ctx.snapshot.marketId,
            kind: 'ENTER',
            seq,
          }),
          kind: 'ENTER',
          side: 'DOWN',
          marketId: ctx.snapshot.marketId,
          strategyInstanceId: ctx.strategyInstanceId,
          budget: Number(ctx.preset.budget ?? 1),
          quantity: Number(ctx.preset.quantity ?? 5),
          maxPrice: ctx.snapshot.book?.down?.bestAsk ?? 0.5,
          minPrice: null,
          deadlineMs: ctx.clockMs + 3000,
          reason: 'spread_wide',
          presetId: 'fixture-spread-wide',
        });
      }

      return { state: { ...state, seq }, intents, diagnostics };
    },

    onExecutionEvent(_ctx, state, event) {
      return {
        state: { ...state, lastEventType: event.type },
        intents: [],
        diagnostics: { lastEventType: event.type },
      };
    },
  };
}
