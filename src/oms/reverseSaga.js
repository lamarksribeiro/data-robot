/**
 * Saga REVERSE: SELL posição atual → reconcile flat → BUY lado oposto.
 * O intent pai não vai ao CLOB como ordem única; pernas filhas atualizam o OMS.
 */

import { isTerminal } from './states.js';

/**
 * @param {object} opts
 * @param {object} opts.intent — TradeIntent REVERSE
 * @param {object} opts.oms
 * @param {(intent: object) => Promise<object>} opts.executeIntent
 * @param {(intentId: string, waitOpts?: object) => Promise<object>} [opts.waitForFinal]
 * @param {() => number} [opts.clock]
 * @param {number} [opts.legTimeoutMs]
 */
export async function executeReverseSaga(opts) {
  const intent = opts.intent;
  const oms = opts.oms;
  const executeIntent = opts.executeIntent;
  const waitForFinal = opts.waitForFinal;
  const clock = opts.clock ?? (() => Date.now());
  const legTimeoutMs = Number(opts.legTimeoutMs ?? 8_000);

  if (!intent || intent.kind !== 'REVERSE') {
    throw new Error('executeReverseSaga: intent REVERSE obrigatório');
  }

  const { order: parent, deduped } = oms.registerIntent(intent);
  if (deduped) {
    return { accepted: true, deduped: true, events: [] };
  }
  if (parent.state === 'REJECTED') {
    return {
      accepted: false,
      deduped: false,
      events: [
        {
          eventId: `rev-rej-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'REJECT',
          side: intent.side,
          qty: 0,
          price: null,
          reason: parent.reason ?? 'INVALID_SIZE_OR_PRICE',
          tsMs: clock(),
        },
      ],
    };
  }

  const pos = oms.position(intent.strategyInstanceId);
  const exitSide = intent.exitSide ?? pos.side;
  const exitQty = Number(intent.exitQuantity ?? pos.qty);
  if (!(exitQty > 0) || !exitSide) {
    markParent(oms, intent.intentId, 'REJECTED', 'NO_POSITION_TO_REVERSE');
    return reject(intent, 'NO_POSITION_TO_REVERSE', clock);
  }

  const orderType = intent.orderType ?? 'FAK';
  const exitIntent = {
    intentId: `${intent.intentId}:exit`,
    kind: 'EXIT',
    side: exitSide,
    marketId: intent.marketId,
    strategyInstanceId: intent.strategyInstanceId,
    budget: null,
    quantity: exitQty,
    maxPrice: null,
    minPrice: intent.minPrice,
    deadlineMs: intent.deadlineMs,
    reason: `${intent.reason ?? 'late_flip_reverse'}:exit`,
    presetId: intent.presetId ?? null,
    orderType,
    tokenId: intent.exitTokenId ?? null,
  };

  const exitResult = await executeIntent(exitIntent);
  if (waitForFinal) {
    await waitForFinal(exitIntent.intentId, { timeoutMs: legTimeoutMs });
  }

  const afterExit = oms.position(intent.strategyInstanceId);
  const exitOrder = oms.getOrder(exitIntent.intentId);
  const exitFilled = Number(exitOrder?.qtyFilled) || 0;
  const exitPrice =
    exitResult.events?.find((e) => e.type === 'FILL' || e.type === 'PARTIAL')?.price ??
    exitOrder?.price ??
    intent.minPrice;

  if (afterExit.qty > 0 || exitFilled <= 0 || exitResult.accepted === false) {
    markParent(oms, intent.intentId, 'REJECTED', 'REVERSE_EXIT_INCOMPLETE');
    return {
      accepted: false,
      deduped: false,
      events: [
        {
          eventId: `rev-exit-fail-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'REJECT',
          side: intent.side,
          qty: 0,
          price: null,
          reason: 'REVERSE_EXIT_INCOMPLETE',
          tsMs: clock(),
          exitFilled,
          residualQty: afterExit.qty,
        },
      ],
    };
  }

  const enterIntent = {
    intentId: `${intent.intentId}:enter`,
    kind: 'ENTER',
    side: intent.side,
    marketId: intent.marketId,
    strategyInstanceId: intent.strategyInstanceId,
    budget: intent.budget,
    quantity: intent.quantity ?? null,
    maxPrice: intent.maxPrice,
    minPrice: null,
    deadlineMs: intent.deadlineMs,
    reason: `${intent.reason ?? 'late_flip_reverse'}:enter`,
    presetId: intent.presetId ?? null,
    orderType,
    tokenId: intent.tokenId ?? null,
  };

  const enterResult = await executeIntent(enterIntent);
  if (waitForFinal) {
    await waitForFinal(enterIntent.intentId, { timeoutMs: legTimeoutMs });
  }

  const enterOrder = oms.getOrder(enterIntent.intentId);
  const enterFilled = Number(enterOrder?.qtyFilled) || 0;
  const enterPrice =
    enterResult.events?.find((e) => e.type === 'FILL' || e.type === 'PARTIAL')?.price ??
    enterOrder?.price ??
    intent.maxPrice;

  if (enterFilled <= 0 || enterResult.accepted === false) {
    // Flat após SELL — seguro, sem exposição residual; estratégia marca reversed só no FILL.
    markParent(oms, intent.intentId, 'REJECTED', 'REVERSE_ENTER_FAILED');
    return {
      accepted: false,
      deduped: false,
      events: [
        {
          eventId: `rev-enter-fail-${intent.intentId}`,
          intentId: intent.intentId,
          type: 'REJECT',
          kind: 'REVERSE',
          side: intent.side,
          qty: 0,
          price: null,
          reason: 'REVERSE_ENTER_FAILED',
          tsMs: clock(),
          exitSide,
          exitQty: exitFilled,
          exitPrice,
        },
      ],
    };
  }

  markParent(oms, intent.intentId, 'MATCHED', 'reverse_complete');

  return {
    accepted: true,
    deduped: false,
    events: [
      {
        eventId: `rev-ack-${intent.intentId}`,
        intentId: intent.intentId,
        type: 'ACK',
        kind: 'REVERSE',
        side: intent.side,
        qty: 0,
        price: null,
        reason: intent.reason,
        tsMs: clock(),
      },
      {
        eventId: `rev-fill-${intent.intentId}`,
        intentId: intent.intentId,
        type: 'FILL',
        kind: 'REVERSE',
        side: intent.side,
        qty: enterFilled,
        price: enterPrice,
        reason: intent.reason,
        tsMs: clock(),
        exitSide,
        exitQty: exitFilled,
        exitPrice,
      },
    ],
  };
}

function markParent(oms, intentId, state, reason) {
  const raw = oms.getOrderRaw?.(intentId);
  if (!raw || isTerminal(raw.state)) return;
  raw.state = state;
  raw.reason = reason;
  raw.updatedAtMs = Date.now();
  raw.timeline = [...(raw.timeline ?? []), { state, tsMs: raw.updatedAtMs, reason }];
}

function reject(intent, reason, clock) {
  return {
    accepted: false,
    deduped: false,
    events: [
      {
        eventId: `rev-rej-${intent.intentId}-${reason}`,
        intentId: intent.intentId,
        type: 'REJECT',
        kind: 'REVERSE',
        side: intent.side,
        qty: 0,
        price: null,
        reason,
        tsMs: clock(),
      },
    ],
  };
}
