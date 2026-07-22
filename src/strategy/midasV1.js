/**
 * Plugin MIDAS Carry V1 — contrato genérico da engine.
 * Núcleo TFC V7 (evaluate.js) + envelope high-ask + tier de budget.
 * Sem SDK, process.env, rede ou filesystem.
 */

import { makeIntentId } from '../engine/schemas.js';
import { MIDAS_V1, resolveMidasEntryBudget } from '../tfc/preset-midas.js';
import {
  evaluateDangerExit,
  evaluateEntryGates,
  evaluateLateFlipAction,
} from '../tfc/evaluate.js';

export const MIDAS_V1_STRATEGY_ID = 'midas-carry-v1';
export const MIDAS_V1_PRESET_ID = 'btc-champion-v1';

const HISTORY_MAX = 600;

function mergePreset(preset = {}) {
  return { ...MIDAS_V1, ...preset };
}

function appendHistory(history, snapshot) {
  const next = [...(history ?? [])];
  if (Number.isFinite(snapshot.btc) && Number.isFinite(snapshot.nowMs)) {
    next.push({ ts: snapshot.nowMs, btc: snapshot.btc });
  }
  if (next.length > HISTORY_MAX) next.splice(0, next.length - HISTORY_MAX);
  return next;
}

function feedsHealthy(snapshot) {
  return snapshot?.feeds?.healthy !== false;
}

function tacticalFloorSec(params) {
  return Number(params.lateFlipMinSec ?? params.dangerExitFloorSec ?? 4);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.defaultPreset]
 */
export function createMidasV1Strategy(opts = {}) {
  const defaultPreset = mergePreset(opts.defaultPreset);

  return {
    manifest: {
      id: MIDAS_V1_STRATEGY_ID,
      version: '1.0.0',
      stateVersion: 1,
      supportedMarkets: ['btc-updown-5m'],
      capabilities: ['price', 'book'],
      description: 'MIDAS Carry V1 — Tiered High-Ask Terminal Carry (plugin).',
      presetId: MIDAS_V1_PRESET_ID,
    },

    validatePreset(preset) {
      const p = mergePreset(preset);
      const required = [
        'minSecondsLeft',
        'maxSecondsLeft',
        'maxDistAbs',
        'minAsk',
        'maxAsk',
        'entryBudget',
        'tierAskThreshold',
        'tierAskBudgetFactor',
        'lateFlipExitSec',
        'lateFlipMinSec',
        'dangerExitK',
        'dangerExitFloorSec',
      ];
      for (const key of required) {
        if (!Number.isFinite(Number(p[key]))) {
          return { ok: false, reason: `${key} numérico obrigatório` };
        }
      }
      return { ok: true };
    },

    initialize(_ctx, preset) {
      const p = mergePreset(preset);
      return {
        state: {
          seq: 0,
          history: [],
          marketId: null,
          reversed: false,
          closed: false,
          lastIntentKind: null,
          entryBudgetUsed: null,
        },
        diagnostics: {
          presetId: MIDAS_V1_PRESET_ID,
          entryBudget: p.entryBudget,
          tierAskThreshold: p.tierAskThreshold,
          tierAskBudgetFactor: p.tierAskBudgetFactor,
        },
      };
    },

    migrateState(oldState) {
      return {
        seq: oldState?.seq ?? 0,
        history: Array.isArray(oldState?.history) ? oldState.history : [],
        marketId: oldState?.marketId ?? null,
        reversed: Boolean(oldState?.reversed),
        closed: Boolean(oldState?.closed),
        lastIntentKind: oldState?.lastIntentKind ?? null,
        entryBudgetUsed:
          oldState?.entryBudgetUsed == null ? null : Number(oldState.entryBudgetUsed),
      };
    },

    onSnapshot(ctx, state) {
      const params = mergePreset(ctx.preset);
      const snapshot = ctx.snapshot;
      let next = { ...state };
      const history = appendHistory(next.history, snapshot);
      next.history = history;

      if (next.marketId !== snapshot.marketId) {
        next = {
          ...next,
          marketId: snapshot.marketId,
          reversed: false,
          closed: false,
          lastIntentKind: null,
          entryBudgetUsed: null,
        };
      }

      const diagnostics = {
        secsLeft: snapshot.secsLeft,
        inPosition: ctx.position.qty > 0,
        reversed: next.reversed,
        closed: next.closed,
        feedsHealthy: feedsHealthy(snapshot),
      };
      const intents = [];

      if (!feedsHealthy(snapshot)) {
        return {
          state: next,
          intents,
          diagnostics: { ...diagnostics, skip: 'feed_unhealthy' },
        };
      }

      const floor = tacticalFloorSec(params);
      const secsLeft = snapshot.secsLeft;
      if (secsLeft != null && secsLeft < floor) {
        return {
          state: next,
          intents,
          diagnostics: { ...diagnostics, skip: 'below_tactical_floor' },
        };
      }

      if (ctx.position.qty > 0 && ctx.position.side && !next.closed) {
        const danger = evaluateDangerExit(snapshot, params, ctx.position.side, history);
        diagnostics.danger = danger;
        if (danger.active && !next.reversed) {
          next.seq = (next.seq ?? 0) + 1;
          next.lastIntentKind = 'EXIT';
          intents.push({
            intentId: makeIntentId({
              strategyInstanceId: ctx.strategyInstanceId,
              marketId: snapshot.marketId,
              kind: 'EXIT',
              seq: next.seq,
            }),
            kind: 'EXIT',
            side: ctx.position.side,
            marketId: snapshot.marketId,
            strategyInstanceId: ctx.strategyInstanceId,
            budget: null,
            quantity: ctx.position.qty,
            maxPrice: null,
            minPrice: params.stopMinBid ?? 0.05,
            deadlineMs: ctx.clockMs + 3000,
            reason: 'danger_exit',
            presetId: MIDAS_V1_PRESET_ID,
          });
          return { state: next, intents, diagnostics };
        }

        const late = evaluateLateFlipAction(snapshot, params, ctx.position.side, next);
        diagnostics.lateFlip = late;
        if (late.action === 'REVERSE') {
          next.seq = (next.seq ?? 0) + 1;
          next.lastIntentKind = 'REVERSE';
          const reverseBudget = Number(
            next.entryBudgetUsed ?? resolveMidasEntryBudget(params, late.oppAsk),
          );
          intents.push({
            intentId: makeIntentId({
              strategyInstanceId: ctx.strategyInstanceId,
              marketId: snapshot.marketId,
              kind: 'REVERSE',
              seq: next.seq,
            }),
            kind: 'REVERSE',
            side: late.oppSide,
            marketId: snapshot.marketId,
            strategyInstanceId: ctx.strategyInstanceId,
            budget: reverseBudget,
            quantity: null,
            maxPrice: late.oppAsk + Number(params.entrySlippageMax ?? 0.02),
            minPrice: late.exitBid,
            deadlineMs: ctx.clockMs + 3000,
            reason: 'late_flip_reverse',
            presetId: MIDAS_V1_PRESET_ID,
          });
          return { state: next, intents, diagnostics };
        }

        if (late.action === 'EXIT') {
          next.seq = (next.seq ?? 0) + 1;
          next.lastIntentKind = 'EXIT';
          intents.push({
            intentId: makeIntentId({
              strategyInstanceId: ctx.strategyInstanceId,
              marketId: snapshot.marketId,
              kind: 'EXIT',
              seq: next.seq,
            }),
            kind: 'EXIT',
            side: ctx.position.side,
            marketId: snapshot.marketId,
            strategyInstanceId: ctx.strategyInstanceId,
            budget: null,
            quantity: ctx.position.qty,
            maxPrice: null,
            minPrice: params.stopMinBid ?? 0.05,
            deadlineMs: ctx.clockMs + 3000,
            reason: 'late_flip_exit',
            presetId: MIDAS_V1_PRESET_ID,
          });
          return { state: next, intents, diagnostics };
        }

        return { state: next, intents, diagnostics };
      }

      if (ctx.position.qty <= 0 && !next.closed) {
        const entry = evaluateEntryGates(snapshot, params, history);
        diagnostics.entry = {
          ok: entry.ok,
          fav: entry.fav,
          ask: entry.ask,
          gates: entry.gates,
        };
        if (entry.ok && entry.fav && entry.ask != null) {
          next.seq = (next.seq ?? 0) + 1;
          next.lastIntentKind = 'ENTER';
          const slippage = Number(params.entrySlippageMax ?? 0.02);
          const identity = snapshot.identity ?? {};
          const tokenId =
            entry.fav === 'UP' ? identity.upTokenId ?? null : identity.downTokenId ?? null;
          const maxPrice = entry.ask + slippage;
          const minShares = Math.max(1, Number(params.minShares ?? 1));
          const entryBudgetUsed = resolveMidasEntryBudget(params, entry.ask);
          next.entryBudgetUsed = entryBudgetUsed;
          const sized =
            Number.isFinite(entryBudgetUsed) && entry.ask > 0
              ? Math.floor(entryBudgetUsed / entry.ask)
              : 0;
          const quantity = Math.max(minShares, sized);
          const notional = quantity * maxPrice;
          diagnostics.tier = {
            ask: entry.ask,
            entryBudgetUsed,
            tierApplied: entry.ask >= Number(params.tierAskThreshold),
          };
          intents.push({
            intentId: makeIntentId({
              strategyInstanceId: ctx.strategyInstanceId,
              marketId: snapshot.marketId,
              kind: 'ENTER',
              seq: next.seq,
            }),
            kind: 'ENTER',
            side: entry.fav,
            marketId: snapshot.marketId,
            strategyInstanceId: ctx.strategyInstanceId,
            budget: notional,
            quantity,
            maxPrice,
            minPrice: null,
            deadlineMs: ctx.clockMs + 5000,
            reason: 'midas_core_entry',
            presetId: MIDAS_V1_PRESET_ID,
            orderType: params.entryOrderType ?? 'GTC',
            tokenId,
          });
        }
      }

      return { state: next, intents, diagnostics };
    },

    onExecutionEvent(_ctx, state, event) {
      const next = { ...state };
      if (event.type === 'FILL' || event.type === 'PARTIAL') {
        if (state.lastIntentKind === 'REVERSE') next.reversed = true;
        if (state.lastIntentKind === 'EXIT') next.closed = true;
      }
      if (event.type === 'REJECT' || event.type === 'CANCEL') {
        next.lastIntentKind = null;
      }
      return {
        state: next,
        intents: [],
        diagnostics: { lastEventType: event.type },
      };
    },
  };
}

export { mergePreset as mergeMidasV1Preset };
