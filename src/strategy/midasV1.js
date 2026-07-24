/**
 * Plugin MIDAS Carry V1 — contrato genérico da engine.
 * Núcleo TFC V7 (evaluate.js) + envelope high-ask + tier/sigma/scoop/exits lab.
 * Sem SDK, process.env, rede ou filesystem.
 *
 * Ordem de decisão (paridade strategy.gls midas-carry-v1):
 * Em posição: danger contínuo → early-warn → danger V7 → late flip reverse/exit
 * Flat: core entry (gates + minEntryZ + sigma/tier budget) → scoop entry
 */

import { makeIntentId } from '../engine/schemas.js';
import {
  MIDAS_V1,
  resolveMidasEntryBudget,
  resolveMidasScoopBudget,
} from '../tfc/preset-midas.js';
import {
  evaluateDangerExit,
  evaluateDangerExitContinuous,
  evaluateEarlyWarnExit,
  evaluateEntryGates,
  evaluateLateFlipAction,
  evaluateScoopEntry,
  physicalZScore,
  signedDistance,
} from '../tfc/evaluate.js';
import { sizeCanaryBuy } from '../tfc/sizeCanaryBuy.js';

export const MIDAS_V1_STRATEGY_ID = 'midas-carry-v1';
export const MIDAS_V1_PRESET_ID = 'btc-micro-aggressive-v1';

const HISTORY_MAX = 600;

/** Soma sizes dos asks do lado (paridade GLS minLiquidityRatio). */
function askLiquidity(book, side, levels = 5) {
  const asks = book?.[String(side).toLowerCase()]?.asks ?? [];
  let sum = 0;
  for (let i = 0; i < Math.min(levels, asks.length); i++) {
    sum += Number(asks[i]?.size) || 0;
  }
  return sum;
}

function mergePreset(preset = {}) {
  return { ...MIDAS_V1, ...preset };
}

function resolveTokenId(snapshot, side) {
  const identity = snapshot?.identity ?? {};
  if (side === 'UP') return identity.upTokenId ?? null;
  if (side === 'DOWN') return identity.downTokenId ?? null;
  return null;
}

/** Campos comuns de EXIT (tokenId + orderType + piso de preço). */
function buildExitOrderFields(params, snapshot, side, bid) {
  const orderType = params.exitOrderType ?? params.entryOrderType ?? 'GTC';
  const floor = Number(params.stopMinBid ?? 0.05);
  const slip = Number(params.entrySlippageMax ?? 0.02);
  let minPrice = floor;
  if (Number.isFinite(bid)) {
    minPrice =
      orderType === 'FAK' || orderType === 'FOK'
        ? Math.max(floor, bid - (Number.isFinite(slip) ? slip : 0))
        : Math.max(floor, bid);
  }
  return {
    tokenId: resolveTokenId(snapshot, side),
    orderType,
    minPrice,
  };
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

function budgetOpts(ctx, params, extra = {}) {
  return {
    accountEquityUsd: ctx.accountEquityUsd,
    realizedPnl: ctx.position?.realizedPnl,
    ...extra,
  };
}

function pushExitIntent(next, ctx, snapshot, params, side, bid, reason) {
  next.seq = (next.seq ?? 0) + 1;
  next.lastIntentKind = 'EXIT';
  const exitFields = buildExitOrderFields(params, snapshot, side, bid);
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
    minPrice: exitFields.minPrice,
    deadlineMs: ctx.clockMs + 3000,
    reason,
    presetId: MIDAS_V1_PRESET_ID,
    orderType: exitFields.orderType,
    tokenId: exitFields.tokenId,
  };
}

function tryEnter({
  next,
  ctx,
  snapshot,
  params,
  side,
  ask,
  entryBudgetUsed,
  reason,
  diagnostics,
  mode,
}) {
  const slippage = Number(params.entrySlippageMax ?? 0.02);
  const maxPrice = ask + slippage;
  const orderType = params.entryOrderType ?? 'GTC';
  const sized = sizeCanaryBuy({
    ask,
    maxPrice,
    entryBudget: entryBudgetUsed,
    minShares: params.minShares ?? 1,
    minNotional: orderType === 'FAK' || orderType === 'FOK' ? undefined : 0,
  });
  const quantity = sized.quantity;
  const notional = sized.notional;
  const minLiq = Number(params.minLiquidityRatio ?? 0);
  const liq = askLiquidity(snapshot.book, side, params.obiLevels ?? 5);
  const liqOk =
    !Number.isFinite(minLiq) ||
    minLiq <= 0 ||
    !(quantity > 0) ||
    liq >= quantity * minLiq;
  diagnostics.liquidity = { liq, quantity, minRatio: minLiq, ok: liqOk };
  diagnostics.tier = {
    ask,
    entryBudgetUsed,
    tierApplied: ask >= Number(params.tierAskThreshold),
    mode,
  };
  if (!liqOk || !(quantity > 0) || !(notional > 0)) {
    return { ok: false, skip: !liqOk ? 'min_liquidity_ratio' : 'size_zero' };
  }
  next.seq = (next.seq ?? 0) + 1;
  next.lastIntentKind = 'ENTER';
  next.entryBudgetUsed = entryBudgetUsed;
  next.entryMode = mode;
  return {
    ok: true,
    intent: {
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
      budget: notional,
      quantity,
      maxPrice,
      minPrice: null,
      deadlineMs: ctx.clockMs + 5000,
      reason,
      presetId: MIDAS_V1_PRESET_ID,
      orderType,
      tokenId: resolveTokenId(snapshot, side),
    },
  };
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
      description:
        'MIDAS Carry V1 — Tiered High-Ask Terminal Carry + sigma/scoop/danger-cont/early-warn (plugin).',
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
          entryMode: null,
        },
        diagnostics: {
          presetId: MIDAS_V1_PRESET_ID,
          entryBudget: p.entryBudget,
          tierAskThreshold: p.tierAskThreshold,
          tierAskBudgetFactor: p.tierAskBudgetFactor,
          sigmaSizingEnabled: p.sigmaSizingEnabled,
          scoopEnabled: p.scoopEnabled,
          dangerContinuousEnabled: p.dangerContinuousEnabled,
          earlyWarnEnabled: p.earlyWarnEnabled,
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
        entryMode: oldState?.entryMode ?? null,
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
          entryMode: null,
        };
      }

      const distAbs =
        Number.isFinite(snapshot.btc) && Number.isFinite(snapshot.priceToBeat)
          ? Math.abs(snapshot.btc - snapshot.priceToBeat)
          : null;
      const { z } = physicalZScore(
        distAbs ?? 0,
        history,
        params,
        snapshot.secsLeft,
        snapshot.nowMs,
      );

      const diagnostics = {
        secsLeft: snapshot.secsLeft,
        btc: Number.isFinite(snapshot.btc) ? snapshot.btc : null,
        priceToBeat: Number.isFinite(snapshot.priceToBeat) ? snapshot.priceToBeat : null,
        inPosition: ctx.position.qty > 0,
        reversed: next.reversed,
        closed: next.closed,
        feedsHealthy: feedsHealthy(snapshot),
        z,
        accountEquityUsd: ctx.accountEquityUsd,
      };
      const intents = [];

      // Sempre avalia gates de entrada para o dashboard (mesmo em posição = watch-only).
      if (feedsHealthy(snapshot)) {
        const entryWatch = evaluateEntryGates(snapshot, params, history);
        diagnostics.entry = {
          ok: entryWatch.ok,
          fav: entryWatch.fav,
          ask: entryWatch.ask,
          bid: entryWatch.bid,
          dist: entryWatch.dist,
          z: entryWatch.z,
          gates: entryWatch.gates,
          blockedByPosition: ctx.position.qty > 0,
          watchOnly: ctx.position.qty > 0,
        };
        if (params.scoopEnabled === true || params.scoopEnabled === 1) {
          const scoopWatch = evaluateScoopEntry(snapshot, params, history);
          diagnostics.scoop = {
            ok: scoopWatch.ok,
            fav: scoopWatch.fav,
            ask: scoopWatch.ask,
            z: scoopWatch.z,
            reason: scoopWatch.reason,
            blockedByPosition: ctx.position.qty > 0,
            watchOnly: ctx.position.qty > 0,
          };
        }
      }

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
        // 1) Danger contínuo (z-based, janela [floor, start])
        const dangerCont = evaluateDangerExitContinuous(
          snapshot,
          params,
          ctx.position.side,
          history,
        );
        diagnostics.dangerContinuous = dangerCont;
        if (dangerCont.active && !next.reversed) {
          intents.push(
            pushExitIntent(
              next,
              ctx,
              snapshot,
              params,
              ctx.position.side,
              dangerCont.bid,
              'danger_exit_continuous',
            ),
          );
          return { state: next, intents, diagnostics };
        }

        // 2) Early-warn (ask do oposto reprecifica)
        const signedDist = signedDistance(
          ctx.position.side,
          snapshot.btc,
          snapshot.priceToBeat,
        );
        const earlyWarn = evaluateEarlyWarnExit(
          snapshot,
          params,
          ctx.position.side,
          signedDist,
        );
        diagnostics.earlyWarn = earlyWarn;
        if (earlyWarn.active && !next.reversed) {
          intents.push(
            pushExitIntent(
              next,
              ctx,
              snapshot,
              params,
              ctx.position.side,
              earlyWarn.bid,
              'early_warn_exit',
            ),
          );
          return { state: next, intents, diagnostics };
        }

        // 3) Danger V7 (janela de 1s no piso)
        const danger = evaluateDangerExit(snapshot, params, ctx.position.side, history);
        diagnostics.danger = danger;
        if (danger.active && !next.reversed) {
          intents.push(
            pushExitIntent(
              next,
              ctx,
              snapshot,
              params,
              ctx.position.side,
              danger.bid,
              'danger_exit',
            ),
          );
          return { state: next, intents, diagnostics };
        }

        // 4) Late flip reverse / exit
        const late = evaluateLateFlipAction(snapshot, params, ctx.position.side, next);
        diagnostics.lateFlip = late;
        if (late.action === 'REVERSE') {
          next.seq = (next.seq ?? 0) + 1;
          next.lastIntentKind = 'REVERSE';
          const factor = Number(params.lateFlipReverseBudgetFactor ?? 1);
          const baseBudget = Number(
            next.entryBudgetUsed ??
              resolveMidasEntryBudget(params, late.oppAsk, budgetOpts(ctx, params, { z })),
          );
          const reverseBudget =
            baseBudget * (Number.isFinite(factor) && factor > 0 ? factor : 1);
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
            tokenId: resolveTokenId(snapshot, late.oppSide),
            exitTokenId: resolveTokenId(snapshot, ctx.position.side),
            exitSide: ctx.position.side,
            exitQuantity: ctx.position.qty,
            orderType: params.exitOrderType ?? params.entryOrderType ?? 'GTC',
          });
          return { state: next, intents, diagnostics };
        }

        if (late.action === 'EXIT') {
          intents.push(
            pushExitIntent(
              next,
              ctx,
              snapshot,
              params,
              ctx.position.side,
              late.exitBid ?? late.bid,
              'late_flip_exit',
            ),
          );
          return { state: next, intents, diagnostics };
        }

        return { state: next, intents, diagnostics };
      }

      if (ctx.position.qty <= 0 && !next.closed) {
        // Core entry
        const entry = diagnostics.entry;
        if (entry?.ok && entry.fav && entry.ask != null) {
          const entryBudgetUsed = resolveMidasEntryBudget(
            params,
            entry.ask,
            budgetOpts(ctx, params, { z: entry.z ?? z }),
          );
          diagnostics.budget = {
            mode: 'core',
            entryBudgetUsed,
            z: entry.z ?? z,
            sigmaSizing: params.sigmaSizingEnabled === true || params.sigmaSizingEnabled === 1,
            equityScale: params.equityScaleEnabled === true || params.equityScaleEnabled === 1,
          };
          const entered = tryEnter({
            next,
            ctx,
            snapshot,
            params,
            side: entry.fav,
            ask: entry.ask,
            entryBudgetUsed,
            reason: 'midas_core_entry',
            diagnostics,
            mode: 'core',
          });
          if (entered.ok) {
            intents.push(entered.intent);
            return { state: next, intents, diagnostics };
          }
          // core falhou sizing/liq — não bloqueia scoop (paridade lab !entered)
          if (entered.skip) {
            diagnostics.coreSkip = entered.skip;
          }
        }

        // Scoop — só se core não entrou
        const scoop = evaluateScoopEntry(snapshot, params, history);
        diagnostics.scoop = {
          ...(diagnostics.scoop || {}),
          ...scoop,
          blockedByPosition: false,
          watchOnly: false,
        };
        if (scoop.ok && scoop.fav && scoop.ask != null) {
          const entryBudgetUsed = resolveMidasScoopBudget(
            params,
            budgetOpts(ctx, params),
          );
          diagnostics.budget = {
            mode: 'scoop',
            entryBudgetUsed,
            z: scoop.z,
          };
          const entered = tryEnter({
            next,
            ctx,
            snapshot,
            params,
            side: scoop.fav,
            ask: scoop.ask,
            entryBudgetUsed,
            reason: 'midas_scoop_entry',
            diagnostics,
            mode: 'scoop',
          });
          if (entered.ok) {
            intents.push(entered.intent);
            return { state: next, intents, diagnostics };
          }
          if (entered.skip) {
            return {
              state: next,
              intents,
              diagnostics: { ...diagnostics, skip: entered.skip },
            };
          }
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
