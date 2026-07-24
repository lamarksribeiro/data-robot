/**
 * Normaliza estado legado de feeds → MarketSnapshot do engine.
 */

import { bookView } from '../feeds/marketState.js';
import { evaluateFeedHealth } from './health.js';

/**
 * @param {object} event — retorno de findActiveBtc5mEvent
 */
export function marketIdFromEvent(event) {
  if (!event) return null;
  return event.slug || event.conditionId || null;
}

/**
 * @param {object} opts
 * @param {ReturnType<import('../feeds/marketState.js').createMarketState>} opts.state
 * @param {object} opts.event
 * @param {number} [opts.nowMs]
 * @param {number|null} [opts.serverNowMs]
 * @param {object} [opts.healthLimits]
 */
export function buildMarketSnapshot(opts) {
  const { state, event } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const marketId = marketIdFromEvent(event);
  if (!marketId) {
    throw new Error('event sem slug/conditionId');
  }

  const secsLeft =
    event.eventEnd instanceof Date
      ? (event.eventEnd.getTime() - nowMs) / 1000
      : null;

  const clobHasBook = Boolean(
    (state.up?.bestAsk != null || state.up?.bestBid != null) &&
      (state.down?.bestAsk != null || state.down?.bestBid != null),
  );
  const feeds = {
    rtdsConnected: Boolean(state.wsRtdsConnected),
    clobConnected: Boolean(state.wsClobConnected),
    rtdsLagMs: state.rtdsReceivedAt != null ? nowMs - state.rtdsReceivedAt : null,
    clobLagMs: state.clobLastAt != null ? nowMs - state.clobLastAt : null,
    rtdsTs: state.rtdsTs ?? null,
    clobHasBook,
  };

  // Trading: estrito (elegibilidade de entrada).
  const health = evaluateFeedHealth(feeds, opts.healthLimits, { mode: 'trading', nowMs });
  // Processo: tolerante (engine ok / degraded).
  const processHealth = evaluateFeedHealth(feeds, opts.healthLimits, {
    mode: 'process',
    nowMs,
    connectedSinceMs: {
      rtds: state.rtdsConnectedAt ?? null,
      clob: state.clobConnectedAt ?? null,
    },
  });
  feeds.healthy = health.ok;
  feeds.processHealthy = processHealth.ok;

  return {
    marketId,
    nowMs,
    secsLeft,
    btc: state.btc,
    priceToBeat: state.priceToBeat,
    book: bookView(state),
    feeds,
    acceptingOrders: event.acceptingOrders === true,
    identity: {
      slug: event.slug ?? null,
      conditionId: event.conditionId ?? null,
      upTokenId: event.upTokenId ?? null,
      downTokenId: event.downTokenId ?? null,
      eventStartMs: event.eventStart instanceof Date ? event.eventStart.getTime() : null,
      eventEndMs: event.eventEnd instanceof Date ? event.eventEnd.getTime() : null,
    },
    health,
    processHealth,
    serverNowMs: opts.serverNowMs ?? null,
  };
}
