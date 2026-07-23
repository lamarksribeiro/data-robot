/**
 * Risk engine P4 — pre-trade fail-closed + limites locais/globais + audit.
 */

import { assertTradeIntent } from '../engine/schemas.js';
import { createAccountRiskBook } from './accountBook.js';
import { createRiskAudit } from './audit.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { createKillSwitch } from './killSwitch.js';
import { createPreflight } from './preflight.js';
import { RISK_REASON } from './reasons.js';

function intentNotional(intent) {
  if (intent.budget != null) return Number(intent.budget);
  if (intent.quantity != null && intent.maxPrice != null) {
    return Number(intent.quantity) * Number(intent.maxPrice);
  }
  return null;
}

/**
 * @param {object} [opts]
 */
export function createRiskEngine(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const limits = {
    maxNotionalPerOrder: opts.maxNotionalPerOrder ?? opts.maxNotionalPerIntent ?? 50,
    maxNotionalPerEvent: opts.maxNotionalPerEvent ?? 50,
    maxAccountExposure: opts.maxAccountExposure ?? 100,
    maxDailyLoss: opts.maxDailyLoss ?? 50,
    maxOrdersPerMinute: opts.maxOrdersPerMinute ?? 30,
    tacticalFloorSec: opts.tacticalFloorSec ?? 4,
    onePositionPerInstance: opts.onePositionPerInstance !== false,
    oneIntentPerEvent: opts.oneIntentPerEvent !== false,
    maxEntriesPerControlWindow: Math.max(0, Number(opts.maxEntriesPerControlWindow ?? 0)),
    controlWindowMs: Math.max(1, Number(opts.controlWindowMs ?? 24 * 60 * 60 * 1000)),
    maxSlippage: opts.maxSlippage ?? null,
    /** Cap P7 — se setado (ou canaryMode), bloqueia notional acima deste valor. */
    maxCanaryBudget: opts.maxCanaryBudget ?? null,
    canaryMode: opts.canaryMode === true,
    allowLiveReverse: opts.allowLiveReverse === true,
  };

  const accountBook = opts.accountBook ?? createAccountRiskBook({
    maxAccountExposure: limits.maxAccountExposure,
  });
  const audit = opts.audit ?? createRiskAudit({ clock });
  const preflight = opts.preflight ?? createPreflight({
    liveEnabled: opts.liveEnabled === true,
    checks: opts.preflightChecks,
  });
  const circuit = opts.circuitBreaker ?? createCircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 5,
    cooldownMs: opts.cooldownMs ?? 60_000,
    clock,
  });
  const killSwitch = opts.killSwitch ?? createKillSwitch({ clock });

  /** @type {Map<string, number>} eventKey → notional no evento */
  const eventNotional = new Map();
  /** @type {number[]} */
  const orderTimestamps = [];
  /** Eventos que já consumiram a única entrada permitida da instância. */
  const enteredEvents = new Set();
  /** Timestamps de ENTER aceitos; persistidos para limitar o canário entre restarts. */
  const entryTimestamps = [];
  let dailyRealizedPnl = opts.dailyRealizedPnl ?? 0;

  function deny(reasonCode, detail, meta = {}) {
    const decision = { allow: false, reasonCode, detail };
    audit.record({
      allow: false,
      reasonCode,
      intentId: meta.intentId,
      strategyInstanceId: meta.strategyInstanceId,
      detail,
    });
    return decision;
  }

  function allow(meta = {}) {
    const decision = { allow: true, reasonCode: RISK_REASON.OK };
    audit.record({
      allow: true,
      reasonCode: RISK_REASON.OK,
      intentId: meta.intentId,
      strategyInstanceId: meta.strategyInstanceId,
    });
    return decision;
  }

  function runPreflight(ctx = {}) {
    return preflight.run(ctx);
  }

  /**
   * @param {import('../engine/schemas.js').TradeIntent} intent
   * @param {object} [ctx]
   */
  function evaluate(intent, ctx = {}) {
    assertTradeIntent(intent);
    const meta = {
      intentId: intent.intentId,
      strategyInstanceId: intent.strategyInstanceId,
    };

    if (ctx.halted || killSwitch.active) {
      return deny(RISK_REASON.KILL_SWITCH, { killReason: killSwitch.reason }, meta);
    }

    const circuitEval = circuit.evaluate();
    if (!circuitEval.allow) {
      return deny(RISK_REASON.CIRCUIT_OPEN, circuitEval.detail, meta);
    }

    if (ctx.health && ctx.health.ok === false) {
      return deny(RISK_REASON.HEALTH_BLOCK, ctx.health, meta);
    }

    if (ctx.mode === 'live' && !preflight.liveEnabled) {
      return deny(RISK_REASON.LIVE_DISABLED, { liveEnabled: false }, meta);
    }

    if (intent.deadlineMs != null && clock() >= Number(intent.deadlineMs)) {
      return deny(
        RISK_REASON.DEADLINE_EXPIRED,
        { deadlineMs: Number(intent.deadlineMs), nowMs: clock() },
        meta,
      );
    }

    if (ctx.mode === 'live' && intent.kind === 'REVERSE' && !limits.allowLiveReverse) {
      return deny(
        RISK_REASON.LIVE_REVERSE_UNSUPPORTED,
        { reason: 'reverse exige saga SELL -> reconcile -> BUY' },
        meta,
      );
    }

    // Ação tática abaixo do piso — só CANCEL passa
    const secsLeft = ctx.snapshot?.secsLeft;
    if (
      secsLeft != null &&
      secsLeft < limits.tacticalFloorSec &&
      intent.kind !== 'CANCEL'
    ) {
      return deny(
        RISK_REASON.BELOW_TACTICAL_FLOOR,
        { secsLeft, floor: limits.tacticalFloorSec },
        meta,
      );
    }

    if (ctx.eligibility && ctx.eligibility.eligible === false && intent.kind !== 'CANCEL') {
      return deny(RISK_REASON.PREFLIGHT_ELIGIBILITY, ctx.eligibility, meta);
    }

    // Perda diária
    if (dailyRealizedPnl <= -Math.abs(limits.maxDailyLoss)) {
      return deny(
        RISK_REASON.MAX_DAILY_LOSS,
        { dailyRealizedPnl, maxDailyLoss: limits.maxDailyLoss },
        meta,
      );
    }

    // Rate limit
    const now = clock();
    while (orderTimestamps.length && now - orderTimestamps[0] > 60_000) {
      orderTimestamps.shift();
    }
    while (entryTimestamps.length && now - entryTimestamps[0] >= limits.controlWindowMs) {
      entryTimestamps.shift();
    }
    if (
      (intent.kind === 'ENTER' || intent.kind === 'REVERSE') &&
      orderTimestamps.length >= limits.maxOrdersPerMinute
    ) {
      return deny(
        RISK_REASON.MAX_ORDERS_PER_MINUTE,
        { count: orderTimestamps.length, max: limits.maxOrdersPerMinute },
        meta,
      );
    }

    const position = ctx.position;
    if (
      limits.onePositionPerInstance &&
      intent.kind === 'ENTER' &&
      position &&
      position.qty > 0
    ) {
      return deny(RISK_REASON.ONE_POSITION_PER_INSTANCE, { qty: position.qty }, meta);
    }

    if (
      limits.oneIntentPerEvent &&
      intent.kind === 'ENTER' &&
      (enteredEvents.has(`${intent.strategyInstanceId}:${intent.marketId}`) ||
        (Array.isArray(ctx.openIntents) &&
          ctx.openIntents.some((i) => i.marketId === intent.marketId && i.kind === 'ENTER')))
    ) {
      return deny(RISK_REASON.ONE_INTENT_PER_EVENT, { marketId: intent.marketId }, meta);
    }

    if (
      intent.kind === 'ENTER' &&
      limits.maxEntriesPerControlWindow > 0 &&
      entryTimestamps.length >= limits.maxEntriesPerControlWindow
    ) {
      return deny(
        RISK_REASON.CONTROL_WINDOW_LIMIT,
        {
          count: entryTimestamps.length,
          max: limits.maxEntriesPerControlWindow,
          controlWindowMs: limits.controlWindowMs,
        },
        meta,
      );
    }

    const notional = intentNotional(intent);

    if (intent.kind === 'ENTER' || intent.kind === 'REVERSE') {
      const canaryCap =
        limits.maxCanaryBudget != null
          ? Number(limits.maxCanaryBudget)
          : limits.canaryMode
            ? 0.1
            : null;
      if (canaryCap != null && notional != null && notional > canaryCap) {
        return deny(
          RISK_REASON.CANARY_BUDGET_EXCEEDED,
          { notional, maxCanaryBudget: canaryCap },
          meta,
        );
      }

      if (notional != null && notional > limits.maxNotionalPerOrder) {
        return deny(
          RISK_REASON.MAX_NOTIONAL_ORDER,
          { notional, max: limits.maxNotionalPerOrder },
          meta,
        );
      }

      const eventKey = `${intent.strategyInstanceId}:${intent.marketId}`;
      const eventUsed = eventNotional.get(eventKey) ?? 0;
      if (notional != null && eventUsed + notional > limits.maxNotionalPerEvent) {
        return deny(
          RISK_REASON.MAX_NOTIONAL_EVENT,
          { eventUsed, notional, max: limits.maxNotionalPerEvent },
          meta,
        );
      }

      if (notional != null) {
        if (accountBook.wouldExceed(notional)) {
          return deny(
            RISK_REASON.MAX_ACCOUNT_EXPOSURE,
            {
              total: accountBook.totalExposure(),
              max: accountBook.maxAccountExposure,
              wouldBe: accountBook.totalExposure() + notional,
            },
            meta,
          );
        }
      }

      if (limits.maxSlippage != null && intent.maxPrice != null && ctx.snapshot) {
        const ask =
          intent.side === 'UP'
            ? ctx.snapshot.book?.up?.bestAsk
            : ctx.snapshot.book?.down?.bestAsk;
        if (ask != null && intent.maxPrice - ask > limits.maxSlippage + 1e-9) {
          return deny(
            RISK_REASON.SLIPPAGE_CAP,
            { maxPrice: intent.maxPrice, ask, maxSlippage: limits.maxSlippage },
            meta,
          );
        }
      }
    }

    return allow(meta);
  }

  /**
   * Chamado após intent aceito/enviado.
   */
  function recordAccepted(intent) {
    const notional = intentNotional(intent);
    orderTimestamps.push(clock());
    if ((intent.kind === 'ENTER' || intent.kind === 'REVERSE') && notional != null) {
      accountBook.tryReserve(intent.strategyInstanceId, notional);
      const eventKey = `${intent.strategyInstanceId}:${intent.marketId}`;
      eventNotional.set(eventKey, (eventNotional.get(eventKey) ?? 0) + notional);
    }
    if (intent.kind === 'ENTER') {
      enteredEvents.add(`${intent.strategyInstanceId}:${intent.marketId}`);
      entryTimestamps.push(clock());
    }
    circuit.recordSuccess();
  }

  function recordFailure(reasonCode) {
    circuit.recordFailure();
    audit.record({ allow: false, reasonCode: reasonCode ?? RISK_REASON.CIRCUIT_OPEN });
  }

  function recordPnl(delta) {
    dailyRealizedPnl += Number(delta) || 0;
  }

  function tripKill(reason = 'kill') {
    return killSwitch.trip(reason);
  }

  function snapshot() {
    return {
      stateVersion: 1,
      limits,
      dailyRealizedPnl,
      eventNotional: Object.fromEntries(eventNotional),
      orderTimestamps: [...orderTimestamps],
      enteredEvents: [...enteredEvents],
      entryTimestamps: [...entryTimestamps],
      accountBook: accountBook.snapshot(),
      circuit: circuit.snapshot(),
      killSwitch: killSwitch.snapshot(),
      auditMetrics: audit.metrics(),
    };
  }

  function restore(snap) {
    if (!snap) return;
    dailyRealizedPnl = snap.dailyRealizedPnl ?? 0;
    eventNotional.clear();
    for (const [k, v] of Object.entries(snap.eventNotional ?? {})) {
      eventNotional.set(k, Number(v) || 0);
    }
    orderTimestamps.length = 0;
    orderTimestamps.push(...(snap.orderTimestamps ?? []));
    enteredEvents.clear();
    for (const key of snap.enteredEvents ?? []) enteredEvents.add(String(key));
    entryTimestamps.length = 0;
    entryTimestamps.push(...(snap.entryTimestamps ?? []).map(Number).filter(Number.isFinite));
    accountBook.restore(snap.accountBook);
    circuit.restore(snap.circuit);
    killSwitch.restore(snap.killSwitch);
  }

  return {
    limits,
    accountBook,
    audit,
    preflight,
    circuit,
    killSwitch,
    evaluate,
    runPreflight,
    recordAccepted,
    recordFailure,
    recordPnl,
    tripKill,
    snapshot,
    restore,
    RISK_REASON,
  };
}

/** Compat P1: wrapper fino. */
export function createBasicRisk(opts = {}) {
  const engine = createRiskEngine(opts);
  return {
    evaluate: (intent, ctx) => engine.evaluate(intent, ctx),
    _engine: engine,
  };
}
