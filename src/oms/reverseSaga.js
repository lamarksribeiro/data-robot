/**
 * Saga REVERSE: SELL posição atual → reconcile flat → BUY lado oposto.
 * O intent pai não vai ao CLOB como ordem única; pernas filhas atualizam o OMS.
 *
 * Perna EXIT (GTC protetora): post → waitForFinal com cancel-on-timeout →
 * até 2 retries com reprice → cancel residual se incomplete. Sem ENTER se não flat.
 */

import { isTerminal } from './states.js';

const DEFAULT_EXIT_RETRIES = 2;
const DEFAULT_FLOOR = 0.05;
const DEFAULT_REPRICE_SLIP = 0.02;
const DEFAULT_TIMEOUT_BUFFER_MS = 500;

/**
 * @param {object} opts
 * @param {object} opts.intent — TradeIntent REVERSE
 * @param {object} opts.oms
 * @param {(intent: object) => Promise<object>} opts.executeIntent
 * @param {(intentId: string, waitOpts?: object) => Promise<object>} [opts.waitForFinal]
 * @param {(intentId: string, reason?: string) => Promise<object>} [opts.cancelOrder]
 * @param {(args: { attempt: number, minPrice: number, intent: object, exitSide: string }) =>
 *   Promise<{ minPrice?: number }|{ minPrice?: number }>} [opts.refreshExitQuote]
 * @param {() => number} [opts.clock]
 * @param {number} [opts.legTimeoutMs]
 * @param {number} [opts.exitRetries]
 */
export async function executeReverseSaga(opts) {
  const intent = opts.intent;
  const oms = opts.oms;
  const executeIntent = opts.executeIntent;
  const waitForFinal = opts.waitForFinal;
  const cancelOrder = opts.cancelOrder;
  const refreshExitQuote = opts.refreshExitQuote;
  const clock = opts.clock ?? (() => Date.now());
  const legTimeoutMs = Number(opts.legTimeoutMs ?? 8_000);
  const exitRetries = Math.max(0, Number(opts.exitRetries ?? DEFAULT_EXIT_RETRIES));

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

  // Pernas independentes de propósito: exit (vender o lado velho) é protetora
  // e usa exitOrderType; enter (comprar o lado novo) segue a política normal de
  // entrada. Nunca reusar o mesmo orderType nas duas — GTC na saída não deve
  // "vazar" para a compra do lado oposto.
  const enterOrderType = intent.orderType ?? 'FAK';
  const exitOrderType = intent.exitOrderType ?? enterOrderType;

  let currentMinPrice = Number(intent.minPrice);
  if (!Number.isFinite(currentMinPrice)) currentMinPrice = DEFAULT_FLOOR;

  const exitAttemptIds = [];
  let exitFilled = 0;
  let exitPrice = currentMinPrice;
  let exitResult = null;
  let exitFlat = false;

  const maxAttempts = 1 + exitRetries;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await cancelExitAttempts(exitAttemptIds, cancelOrder, waitForFinal, clock);
      const refreshed = await resolveRefreshQuote({
        refreshExitQuote,
        attempt,
        minPrice: currentMinPrice,
        intent,
        exitSide,
      });
      if (Number.isFinite(refreshed)) currentMinPrice = refreshed;
    }

    const remaining = oms.position(intent.strategyInstanceId);
    const qtyLeft = Number(remaining?.qty) || 0;
    if (!(qtyLeft > 0)) {
      exitFlat = true;
      break;
    }

    const exitIntentId =
      attempt === 0 ? `${intent.intentId}:exit` : `${intent.intentId}:exit:${attempt}`;
    exitAttemptIds.push(exitIntentId);

    const exitIntent = {
      intentId: exitIntentId,
      kind: 'EXIT',
      side: exitSide,
      marketId: intent.marketId,
      strategyInstanceId: intent.strategyInstanceId,
      budget: null,
      quantity: qtyLeft,
      maxPrice: null,
      minPrice: currentMinPrice,
      deadlineMs: intent.deadlineMs,
      reason: `${intent.reason ?? 'late_flip_reverse'}:exit`,
      presetId: intent.presetId ?? null,
      orderType: exitOrderType,
      tokenId: intent.exitTokenId ?? null,
    };

    exitResult = await executeIntent(exitIntent);
    if (waitForFinal) {
      await waitForFinal(exitIntentId, {
        timeoutMs: computeLegTimeoutMs(intent, legTimeoutMs, clock),
        killOnTimeout: true,
        notify: false,
      });
    }

    const afterExit = oms.position(intent.strategyInstanceId);
    const exitOrder = oms.getOrder(exitIntentId);
    const filledNow = Number(exitOrder?.qtyFilled) || 0;
    exitFilled += filledNow;
    exitPrice =
      exitResult.events?.find((e) => e.type === 'FILL' || e.type === 'PARTIAL')?.price ??
      exitOrder?.price ??
      currentMinPrice;

    if ((!(afterExit.qty > 0) && filledNow > 0) || (!(afterExit.qty > 0) && exitFilled > 0)) {
      exitFlat = true;
      break;
    }
  }

  if (!exitFlat) {
    await cancelExitAttempts(exitAttemptIds, cancelOrder, waitForFinal, clock);
    const residual = oms.position(intent.strategyInstanceId);
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
          residualQty: residual.qty,
        },
      ],
    };
  }

  if (exitResult?.accepted === false && exitFilled <= 0) {
    await cancelExitAttempts(exitAttemptIds, cancelOrder, waitForFinal, clock);
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
          residualQty: oms.position(intent.strategyInstanceId).qty,
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
    orderType: enterOrderType,
    tokenId: intent.tokenId ?? null,
  };

  const enterResult = await executeIntent(enterIntent);
  if (waitForFinal) {
    await waitForFinal(enterIntent.intentId, {
      timeoutMs: computeLegTimeoutMs(intent, legTimeoutMs, clock),
      // ENTER FAK: kill on timeout (comportamento histórico via omsSink.submit).
      killOnTimeout: true,
      notify: false,
    });
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

function computeLegTimeoutMs(intent, legTimeoutMs, clock) {
  const bufferMs = DEFAULT_TIMEOUT_BUFFER_MS;
  let timeoutMs = legTimeoutMs;
  const secsLeftMs = Number(intent?.secsLeftMs);
  if (Number.isFinite(secsLeftMs) && secsLeftMs > 0) {
    timeoutMs = Math.min(timeoutMs, Math.max(500, secsLeftMs - bufferMs));
  }
  return Math.max(500, timeoutMs);
}

async function resolveRefreshQuote({ refreshExitQuote, attempt, minPrice, intent, exitSide }) {
  if (typeof refreshExitQuote === 'function') {
    const q = await refreshExitQuote({ attempt, minPrice, intent, exitSide });
    if (q && Number.isFinite(Number(q.minPrice))) return Number(q.minPrice);
  }
  return Math.max(DEFAULT_FLOOR, Number(minPrice) - DEFAULT_REPRICE_SLIP);
}

async function cancelExitAttempts(intentIds, cancelOrder, waitForFinal, clock) {
  for (const intentId of intentIds) {
    if (typeof cancelOrder === 'function') {
      try {
        await cancelOrder(intentId, 'reverse_exit_residual_canceled');
      } catch {
        /* best-effort */
      }
      continue;
    }
    if (typeof waitForFinal === 'function') {
      try {
        await waitForFinal(intentId, {
          timeoutMs: 0,
          killOnTimeout: true,
          notify: false,
        });
      } catch {
        /* best-effort */
      }
    }
  }
  void clock;
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
