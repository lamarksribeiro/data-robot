/**
 * Plugin Apex Triad V1 — edge antecipado + núcleo terminal TFC.
 * Sem SDK, process.env, rede ou filesystem.
 */

import { makeIntentId } from '../engine/schemas.js';
import { APEX_TRIAD_V1 } from '../tfc/preset-apex.js';
import {
  evaluateApexDangerExit,
  evaluateApexReverse,
  evaluateEdgeEntry,
  evaluateEdgeExits,
  evaluateTerminalEntry,
  signedDistance,
} from '../tfc/apexEvaluate.js';
import { sizeCanaryBuy } from '../tfc/sizeCanaryBuy.js';

export const APEX_TRIAD_V1_STRATEGY_ID = 'apex-triad-v1';
export const APEX_TRIAD_V1_PRESET_ID = 'btc-candidate-v1';

const HISTORY_MAX = 600;

function mergePreset(preset = {}) {
  return { ...APEX_TRIAD_V1, ...preset };
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
  return Number(params.dangerExitFloorSec ?? 4);
}

function resolveTokenId(snapshot, side) {
  const identity = snapshot?.identity ?? {};
  if (side === 'UP') return identity.upTokenId ?? null;
  if (side === 'DOWN') return identity.downTokenId ?? null;
  return null;
}

function buildEnterIntent(ctx, snapshot, params, next, side, ask, budget, reason) {
  const slippage = Number(params.entrySlippageMax ?? 0.02);
  const maxPrice = ask + slippage;
  const orderType = params.entryOrderType ?? 'GTC';
  const sized = sizeCanaryBuy({
    ask,
    maxPrice,
    entryBudget: Number(budget),
    minShares: params.minShares ?? 1,
    minNotional: orderType === 'FAK' || orderType === 'FOK' ? undefined : 0,
  });
  next.seq = (next.seq ?? 0) + 1;
  next.lastIntentKind = 'ENTER';
  return {
    intentId: makeIntentId({
      strategyInstanceId: ctx.strategyInstanceId,
      marketId: snapshot.marketId,
      kind: 'ENTER',
      seq: next.seq,
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
    presetId: APEX_TRIAD_V1_PRESET_ID,
    orderType,
    tokenId: resolveTokenId(snapshot, side),
  };
}

function buildExitIntent(ctx, snapshot, params, next, side, bid, reason) {
  next.seq = (next.seq ?? 0) + 1;
  next.lastIntentKind = 'EXIT';
  return {
    intentId: makeIntentId({
      strategyInstanceId: ctx.strategyInstanceId,
      marketId: snapshot.marketId,
      kind: 'EXIT',
      seq: next.seq,
    }),
    kind: 'EXIT',
    side,
    marketId: snapshot.marketId,
    strategyInstanceId: ctx.strategyInstanceId,
    budget: null,
    quantity: ctx.position.qty,
    maxPrice: null,
    minPrice: params.stopMinBid ?? 0.05,
    deadlineMs: ctx.clockMs + 3000,
    reason,
    presetId: APEX_TRIAD_V1_PRESET_ID,
  };
}

function buildReverseIntent(ctx, snapshot, params, next, reverse) {
  next.seq = (next.seq ?? 0) + 1;
  next.lastIntentKind = 'REVERSE';
  return {
    intentId: makeIntentId({
      strategyInstanceId: ctx.strategyInstanceId,
      marketId: snapshot.marketId,
      kind: 'REVERSE',
      seq: next.seq,
    }),
    kind: 'REVERSE',
    side: reverse.oppSide,
    marketId: snapshot.marketId,
    strategyInstanceId: ctx.strategyInstanceId,
    budget: Number(reverse.budget),
    quantity: null,
    maxPrice: reverse.oppAsk + Number(params.entrySlippageMax ?? 0.02),
    minPrice: reverse.exitBid ?? params.stopMinBid ?? 0.05,
    deadlineMs: ctx.clockMs + 3000,
    reason: reverse.reason,
    presetId: APEX_TRIAD_V1_PRESET_ID,
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.defaultPreset]
 */
export function createApexTriadV1Strategy(opts = {}) {
  const defaultPreset = mergePreset(opts.defaultPreset);

  return {
    manifest: {
      id: APEX_TRIAD_V1_STRATEGY_ID,
      version: '1.0.0',
      stateVersion: 1,
      supportedMarkets: ['btc-updown-5m'],
      capabilities: ['price', 'book'],
      description: 'Apex Triad V1 — edge + terminal TFC (plugin).',
      presetId: APEX_TRIAD_V1_PRESET_ID,
    },

    validatePreset(preset) {
      const p = mergePreset(preset);
      const required = [
        'baseBudget',
        'edgeWindowStart',
        'edgeWindowEnd',
        'terminalMinSecondsLeft',
        'terminalMaxSecondsLeft',
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
          entered: false,
          closed: false,
          entryMode: '',
          reversed: false,
          reverseCount: 0,
          maxBid: 0,
          entryCost: Number(p.baseBudget),
          lastIntentKind: null,
        },
        diagnostics: { presetId: APEX_TRIAD_V1_PRESET_ID, baseBudget: p.baseBudget },
      };
    },

    migrateState(oldState) {
      return {
        seq: oldState?.seq ?? 0,
        history: Array.isArray(oldState?.history) ? oldState.history : [],
        marketId: oldState?.marketId ?? null,
        entered: Boolean(oldState?.entered),
        closed: Boolean(oldState?.closed),
        entryMode: oldState?.entryMode ?? '',
        reversed: Boolean(oldState?.reversed),
        reverseCount: Number(oldState?.reverseCount ?? 0),
        maxBid: Number(oldState?.maxBid ?? 0),
        entryCost: Number(oldState?.entryCost ?? 0),
        lastIntentKind: oldState?.lastIntentKind ?? null,
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
          entered: false,
          closed: false,
          entryMode: '',
          reversed: false,
          reverseCount: 0,
          maxBid: 0,
          entryCost: Number(params.baseBudget),
          lastIntentKind: null,
        };
      }

      const diagnostics = {
        secsLeft: snapshot.secsLeft,
        inPosition: ctx.position.qty > 0,
        entryMode: next.entryMode,
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
        const side = ctx.position.side;
        const bid = snapshot.book?.[side.toLowerCase()]?.bestBid;
        if (Number.isFinite(bid) && bid > next.maxBid) next.maxBid = bid;

        const reverse = evaluateApexReverse(snapshot, params, side, next);
        diagnostics.reverse = reverse;
        if (reverse.action === 'REVERSE') {
          intents.push(buildReverseIntent(ctx, snapshot, params, next, reverse));
          return { state: next, intents, diagnostics };
        }

        const edgeExit = evaluateEdgeExits(snapshot, params, side, next);
        diagnostics.edgeExit = edgeExit;
        if (edgeExit.action === 'EXIT') {
          intents.push(buildExitIntent(ctx, snapshot, params, next, side, edgeExit.bid, edgeExit.reason));
          return { state: next, intents, diagnostics };
        }

        const danger = evaluateApexDangerExit(snapshot, params, side, history);
        diagnostics.danger = danger;
        if (danger.active && !next.reversed) {
          intents.push(buildExitIntent(ctx, snapshot, params, next, side, danger.bid, 'apex_danger_exit'));
          return { state: next, intents, diagnostics };
        }

        return { state: next, intents, diagnostics };
      }

      if (ctx.position.qty <= 0 && !next.entered && !next.closed) {
        const edge = evaluateEdgeEntry(snapshot, params, history);
        diagnostics.edge = edge;
        if (edge.ok && edge.side && edge.ask != null) {
          next.entered = true;
          next.entryMode = 'edge';
          next.entryCost = edge.budget;
          next.maxBid = snapshot.book?.[edge.side.toLowerCase()]?.bestBid ?? 0;
          intents.push(
            buildEnterIntent(ctx, snapshot, params, next, edge.side, edge.ask, edge.budget, edge.reason),
          );
          return { state: next, intents, diagnostics };
        }

        const terminal = evaluateTerminalEntry(snapshot, params, history);
        diagnostics.terminal = terminal;
        if (terminal.ok && terminal.side && terminal.ask != null) {
          next.entered = true;
          next.entryMode = 'terminal';
          next.entryCost = terminal.budget;
          next.maxBid = snapshot.book?.[terminal.side.toLowerCase()]?.bestBid ?? 0;
          intents.push(
            buildEnterIntent(
              ctx,
              snapshot,
              params,
              next,
              terminal.side,
              terminal.ask,
              terminal.budget,
              terminal.reason,
            ),
          );
        }
      }

      return { state: next, intents, diagnostics };
    },

    onExecutionEvent(_ctx, state, event) {
      const next = { ...state };
      if (event.type === 'FILL' || event.type === 'PARTIAL') {
        if (state.lastIntentKind === 'REVERSE') {
          next.reversed = true;
          next.reverseCount = (next.reverseCount ?? 0) + 1;
        }
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

export { mergePreset as mergeApexTriadV1Preset };
