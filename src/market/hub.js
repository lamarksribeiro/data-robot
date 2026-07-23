/**
 * Hub de mercado: monta snapshots, aplica elegibilidade e rotação.
 * Não conhece estratégias concretas.
 */

import { findActiveBtc5mEvent } from '../markets/btc5m.js';
import { fetchPriceToBeat } from '../markets/priceToBeat.js';
import { createMarketState } from '../feeds/marketState.js';
import { evaluateSnapshotEligibility } from './eligibility.js';
import { buildMarketSnapshot, marketIdFromEvent } from './normalize.js';
import { BTC5M_STALENESS } from './health.js';

/**
 * @param {object} [opts]
 * @param {() => Promise<object|null>} [opts.resolveEvent]
 * @param {(start: Date, end: Date) => Promise<number|null>} [opts.fetchPtb]
 * @param {object} [opts.healthLimits]
 * @param {() => number} [opts.clock]
 */
export function createMarketHub(opts = {}) {
  const resolveEvent = opts.resolveEvent ?? findActiveBtc5mEvent;
  const fetchPtb = opts.fetchPtb ?? fetchPriceToBeat;
  const healthLimits = opts.healthLimits ?? BTC5M_STALENESS;
  const clock = opts.clock ?? (() => Date.now());

  const state = opts.state ?? createMarketState();
  let event = null;
  let expected = {
    marketId: null,
    upTokenId: null,
    downTokenId: null,
  };

  const stats = {
    ticks: 0,
    eligible: 0,
    rejected: 0,
    rotations: 0,
    rejectReasons: /** @type {Record<string, number>} */ ({}),
  };

  function noteReject(reasons) {
    stats.rejected += 1;
    for (const r of reasons) {
      stats.rejectReasons[r] = (stats.rejectReasons[r] ?? 0) + 1;
    }
  }

  function bindEvent(next) {
    const prevId = expected.marketId;
    event = next;
    state.event = next;
    expected = {
      marketId: marketIdFromEvent(next),
      upTokenId: next?.upTokenId ?? null,
      downTokenId: next?.downTokenId ?? null,
    };
    if (prevId && expected.marketId && prevId !== expected.marketId) {
      stats.rotations += 1;
      // limpa book ao rotacionar (resync esperado no feed)
      state.up = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      state.down = { bestBid: null, bestAsk: null, bids: [], asks: [] };
      state.clobLastAt = null;
    }
    return { rotated: Boolean(prevId && prevId !== expected.marketId), marketId: expected.marketId };
  }

  return {
    state,
    get event() {
      return event;
    },
    get expected() {
      return { ...expected };
    },
    get stats() {
      return {
        ...stats,
        rejectReasons: { ...stats.rejectReasons },
        availability:
          stats.ticks > 0 ? stats.eligible / stats.ticks : null,
      };
    },

    /**
     * Descobre / atualiza evento BTC 5m e PTB.
     */
    async syncMarket(now = new Date(clock())) {
      const next = await resolveEvent(now);
      if (!next) {
        event = null;
        expected = { marketId: null, upTokenId: null, downTokenId: null };
        return { ok: false, reason: 'NO_ACTIVE_EVENT' };
      }
      const previousMarketId = expected.marketId;
      const rotation = bindEvent(next);
      const marketChanged = previousMarketId !== expected.marketId;
      if (next.eventStart && next.eventEnd && (marketChanged || state.priceToBeat == null)) {
        state.priceToBeat = await fetchPtb(next.eventStart, next.eventEnd);
      }
      return { ok: true, ...rotation, event: next, priceToBeat: state.priceToBeat };
    },

    /**
     * Força evento (útil em testes / replay de identidade).
     */
    setEvent(next) {
      return bindEvent(next);
    },

    /**
     * Monta snapshot + elegibilidade. Não entrega snapshot stale como elegível.
     * @param {object} [gateOpts]
     */
    capture(gateOpts = {}) {
      stats.ticks += 1;
      if (!event) {
        noteReject(['NO_EVENT']);
        return { eligible: false, reasons: ['NO_EVENT'], snapshot: null };
      }

      const snapshot = buildMarketSnapshot({
        state,
        event,
        nowMs: clock(),
        serverNowMs: gateOpts.serverNowMs ?? null,
        healthLimits,
      });

      const gate = evaluateSnapshotEligibility(snapshot, {
        expectedMarketId: expected.marketId,
        expectedUpTokenId: expected.upTokenId,
        expectedDownTokenId: expected.downTokenId,
        requireAcceptingOrders: gateOpts.requireAcceptingOrders,
        minSecsLeft: gateOpts.minSecsLeft,
        healthLimits,
      });

      snapshot.eligibility = {
        eligible: gate.eligible,
        reasons: gate.reasons,
      };

      if (!gate.eligible) {
        noteReject(gate.reasons);
        return { eligible: false, reasons: gate.reasons, snapshot };
      }

      stats.eligible += 1;
      return { eligible: true, reasons: [], snapshot };
    },
  };
}
