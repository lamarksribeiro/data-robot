/**
 * Engine runtime genérica — lifecycle + intents + sink + risk/persistence P4.
 * Não importa plugins de estratégia.
 */

import { buildStrategyContext, normalizeStrategyResult } from './contract.js';
import { createRiskEngine } from '../risk/createRiskEngine.js';
import {
  ENGINE_STATES,
  EXECUTION_MODES,
  assertMarketSnapshot,
  emptyPosition,
} from './schemas.js';
import { createSinkForMode } from './sinks.js';
import {
  ENGINE_STATE_VERSION,
  buildEngineCheckpoint,
  migrateStrategyState,
} from './persistence.js';

const EXPECTED_POLICY_DENIALS = new Set([
  'ONE_POSITION_PER_INSTANCE',
  'ONE_INTENT_PER_EVENT',
  'CONTROL_WINDOW_LIMIT',
  'BELOW_TACTICAL_FLOOR',
  'CANARY_BUDGET_EXCEEDED',
  'DEADLINE_EXPIRED',
  'LIVE_REVERSE_UNSUPPORTED',
  'OPERATOR_DISARMED',
]);

/**
 * @param {object} opts
 * @param {'dry-run'|'shadow'|'live'} opts.mode
 * @param {object} opts.strategy
 * @param {object} opts.preset
 * @param {string} [opts.strategyInstanceId]
 * @param {object} [opts.sink]
 * @param {object} [opts.risk]
 * @param {() => number} [opts.clock]
 */
export function createEngine(opts) {
  const mode = opts.mode ?? 'dry-run';
  if (!EXECUTION_MODES.includes(mode)) {
    throw new Error(`mode inválido: ${mode}`);
  }

  const strategy = opts.strategy;
  if (!strategy) throw new Error('strategy obrigatória');

  const preset = opts.preset ?? {};
  const validation = strategy.validatePreset(preset);
  if (validation && validation.ok === false) {
    throw new Error(`preset inválido: ${validation.reason ?? 'validatePreset failed'}`);
  }

  const strategyInstanceId =
    opts.strategyInstanceId ?? `${strategy.manifest.id}:${strategy.manifest.version}:0`;
  const sink = opts.sink ?? createSinkForMode(mode);
  const clock = opts.clock ?? (() => Date.now());
  /** Saldo real opcional (USD) para equity scale — sem walletSize de lab. */
  const getAccountEquityUsd =
    typeof opts.getAccountEquityUsd === 'function' ? opts.getAccountEquityUsd : null;
  let accountEquityUsd =
    opts.accountEquityUsd == null || !Number.isFinite(Number(opts.accountEquityUsd))
      ? null
      : Number(opts.accountEquityUsd);

  function resolveAccountEquityUsd() {
    if (getAccountEquityUsd) {
      try {
        const v = getAccountEquityUsd();
        if (v != null && Number.isFinite(Number(v))) return Number(v);
      } catch {
        /* ignore provider errors */
      }
    }
    return accountEquityUsd;
  }

  const risk =
    opts.risk ??
    createRiskEngine({
      clock,
      liveEnabled: opts.liveEnabled === true,
      accountBook: opts.accountBook,
      ...opts.riskOpts,
    });

  // Compat: createBasicRisk devolve { evaluate, _engine }
  const riskEngine = risk._engine ?? risk;

  let state = 'BOOT';
  let strategyState = {};
  let strategyStateVersion = strategy.manifest.stateVersion ?? 1;
  let position = emptyPosition();
  let lastSnapshot = null;
  let lastDiagnostics = {};
  let haltReason = null;
  let intentSeq = 0;
  let restored = false;
  const journal = [];
  const pendingIntents = new Map();

  function transition(next, reason = null) {
    if (!ENGINE_STATES.includes(next)) {
      throw new Error(`estado inválido: ${next}`);
    }
    const from = state;
    state = next;
    journal.push({
      type: 'transition',
      from,
      to: next,
      reason,
      tsMs: clock(),
    });
  }

  function applyFill(event) {
    if (event.type !== 'FILL' && event.type !== 'PARTIAL') return;

    const qty = Number(event.qty) || 0;
    const price = event.price != null ? Number(event.price) : null;
    const side = event.side;

    if (qty <= 0 || !side) return;

    const pending = event.intentId ? pendingIntents.get(event.intentId) : null;
    const kind = event.kind ?? pending?.kind ?? 'ENTER';

    if (kind === 'REVERSE') {
      const exitQty = Number(event.exitQty) || position.qty;
      const exitPrice = event.exitPrice != null ? Number(event.exitPrice) : null;
      if (position.qty > 0 && exitPrice != null && position.avgPrice != null) {
        const closeQty = Math.min(position.qty, exitQty > 0 ? exitQty : position.qty);
        const pnlDelta = (exitPrice - position.avgPrice) * closeQty;
        position.realizedPnl += pnlDelta;
        if (pnlDelta !== 0 && typeof riskEngine.recordPnl === 'function') {
          riskEngine.recordPnl(pnlDelta);
        }
      }
      position = emptyPosition({
        marketId: lastSnapshot?.marketId ?? position.marketId,
        realizedPnl: position.realizedPnl,
      });
      const prevQty = 0;
      const prevAvg = price;
      const newQty = prevQty + qty;
      position = {
        marketId: lastSnapshot?.marketId ?? position.marketId,
        side,
        qty: newQty,
        avgPrice: price,
        realizedPnl: position.realizedPnl,
      };
      if (state === 'ENTRY_PENDING' || state === 'REVERSE_PENDING' || state === 'ARMED') {
        transition('POSITION_OPEN', event.type);
      }
      return;
    }

    if (kind === 'ENTER') {
      const prevQty = position.qty;
      const prevAvg = position.avgPrice ?? price;
      const newQty = prevQty + qty;
      const avgPrice =
        price != null && prevAvg != null && newQty > 0
          ? (prevAvg * prevQty + price * qty) / newQty
          : price;
      position = {
        marketId: lastSnapshot?.marketId ?? position.marketId,
        side,
        qty: newQty,
        avgPrice,
        realizedPnl: position.realizedPnl,
      };
      if (state === 'ENTRY_PENDING' || state === 'REVERSE_PENDING' || state === 'ARMED') {
        transition('POSITION_OPEN', event.type);
      }
    } else if (kind === 'EXIT') {
      const closeQty = Math.min(position.qty, qty);
      let pnlDelta = 0;
      if (position.avgPrice != null && price != null) {
        pnlDelta = (price - position.avgPrice) * closeQty;
        position.realizedPnl += pnlDelta;
      }
      if (pnlDelta !== 0 && typeof riskEngine.recordPnl === 'function') {
        riskEngine.recordPnl(pnlDelta);
      }
      position = {
        ...position,
        qty: Math.max(0, position.qty - closeQty),
        side: position.qty - closeQty <= 0 ? null : position.side,
        avgPrice: position.qty - closeQty <= 0 ? null : position.avgPrice,
      };
      if (position.qty <= 0) {
        position = emptyPosition({ marketId: position.marketId, realizedPnl: position.realizedPnl });
        transition('ARMED', 'flat');
      }
    }
  }

  async function dispatchIntent(intent) {
    const decision = riskEngine.evaluate(intent, {
      health: lastSnapshot?.feeds?.healthy === false ? { ok: false } : { ok: true },
      mode,
      halted: state === 'HALTED',
      snapshot: lastSnapshot,
      position: { ...position },
      openIntents: [...pendingIntents.values()],
      eligibility: lastSnapshot?.eligibility,
    });
    journal.push({
      type: 'risk',
      intentId: intent.intentId,
      decision,
      tsMs: clock(),
    });
    if (!decision.allow) {
      // Uma negação esperada de policy (cap, idempotência, janela, piso) já foi
      // auditada pelo risk engine e não é falha de transporte. Não deve abrir
      // o circuit breaker e bloquear um EXIT protetivo posterior.
      if (
        typeof riskEngine.recordFailure === 'function' &&
        !EXPECTED_POLICY_DENIALS.has(decision.reasonCode)
      ) {
        riskEngine.recordFailure(decision.reasonCode);
      }
      return { allowed: false, decision };
    }

    if (typeof riskEngine.recordAccepted === 'function') {
      riskEngine.recordAccepted(intent);
    }

    pendingIntents.set(intent.intentId, intent);

    if (intent.kind === 'ENTER') transition('ENTRY_PENDING', intent.reason);
    if (intent.kind === 'EXIT') transition('EXIT_PENDING', intent.reason);
    if (intent.kind === 'REVERSE') transition('REVERSE_PENDING', intent.reason);

    const result = await sink.submit(intent);
    journal.push({
      type: 'sink',
      intentId: intent.intentId,
      intent: {
        kind: intent.kind,
        side: intent.side,
        budget: intent.budget,
        quantity: intent.quantity ?? null,
        maxPrice: intent.maxPrice,
        minPrice: intent.minPrice ?? null,
        deadlineMs: intent.deadlineMs ?? null,
        orderType: intent.orderType ?? null,
        reason: intent.reason,
        presetId: intent.presetId ?? null,
        marketId: intent.marketId,
        tokenId: intent.tokenId ?? null,
      },
      accepted: result.accepted,
      events: result.events ?? [],
      eventCount: result.events?.length ?? 0,
      tsMs: clock(),
    });

    if (result.accepted === false && typeof riskEngine.recordFailure === 'function') {
      riskEngine.recordFailure(result.events?.[0]?.reason ?? 'SINK_REJECT');
    }

    for (const event of result.events ?? []) {
      await ingestExecutionEvent(event);
    }
    return { allowed: true, decision, result };
  }

  async function ingestExecutionEvent(event) {
    const pendingBefore = event.intentId ? pendingIntents.get(event.intentId) : null;
    journal.push({ type: 'execution', event, tsMs: clock() });
    applyFill(event);

    if (event.type === 'FILL' || event.type === 'CANCEL' || event.type === 'REJECT') {
      if (event.intentId) pendingIntents.delete(event.intentId);
    }

    if (
      pendingBefore &&
      (event.type === 'FILL' || event.type === 'CANCEL' || event.type === 'REJECT') &&
      typeof riskEngine.accountBook?.set === 'function'
    ) {
      const openNotional =
        position.qty > 0 && position.avgPrice != null ? position.qty * position.avgPrice : 0;
      riskEngine.accountBook.set(strategyInstanceId, openNotional);
    }

    if (state === 'HALTED') return;

    const ctx = buildStrategyContext({
      snapshot: lastSnapshot,
      position: { ...position },
      openIntents: [...pendingIntents.values()],
      mode,
      clockMs: clock(),
      health: { ok: state !== 'HALTED' },
      preset,
      strategyInstanceId,
      accountEquityUsd: resolveAccountEquityUsd(),
    });

    const raw = strategy.onExecutionEvent(ctx, strategyState, event);
    const normalized = normalizeStrategyResult(raw, { strategyInstanceId });
    strategyState = normalized.state;
    lastDiagnostics = normalized.diagnostics;
    for (const intent of normalized.intents) {
      await dispatchIntent(intent);
    }
  }

  async function safeShutdown(reason = 'shutdown') {
    haltReason = reason;
    if (state !== 'HALTED') transition('HALTED', reason);

    let canceled = [];
    if (typeof sink.cancelOpenOrders === 'function') {
      const r = await sink.cancelOpenOrders(reason);
      canceled = r?.canceled ?? [];
    } else if (typeof sink.cancelOnDisconnect === 'function') {
      const r = await sink.cancelOnDisconnect();
      canceled = r?.canceled ?? [];
    } else if (typeof sink.dispose === 'function') {
      sink.dispose();
    }

    pendingIntents.clear();
    if (typeof riskEngine.accountBook?.set === 'function') {
      const openNotional =
        position.qty > 0 && position.avgPrice != null ? position.qty * position.avgPrice : 0;
      riskEngine.accountBook.set(strategyInstanceId, openNotional);
    }

    journal.push({ type: 'shutdown', reason, canceled, tsMs: clock() });
    return { state, haltReason, canceled };
  }

  /**
   * Settlement por expiração (binary $0/$1) — limpa posição sem ordem CLOB.
   * @param {{ price: number, reason?: string, marketId?: string }} opts
   */
  function settlePosition(opts = {}) {
    const price = Number(opts.price);
    if (!Number.isFinite(price) || price < 0 || price > 1) {
      throw new Error('settlePosition: price inválido');
    }
    if (!(position.qty > 0)) {
      return { settled: false, reason: 'FLAT' };
    }
    const qty = position.qty;
    const avg = position.avgPrice;
    const side = position.side;
    const marketId = position.marketId;
    let pnlDelta = 0;
    if (avg != null) pnlDelta = (price - avg) * qty;
    if (pnlDelta !== 0 && typeof riskEngine.recordPnl === 'function') {
      riskEngine.recordPnl(pnlDelta);
    }
    const realizedPnl = (position.realizedPnl ?? 0) + pnlDelta;
    position = emptyPosition({ marketId: null, realizedPnl });
    pendingIntents.clear();
    haltReason = null;
    if (state === 'HALTED' || state === 'POSITION_OPEN' || state === 'EXIT_PENDING') {
      transition('ARMED', opts.reason ?? 'settlement');
    }
    if (typeof riskEngine.accountBook?.set === 'function') {
      riskEngine.accountBook.set(strategyInstanceId, 0);
    }
    if (typeof sink.oms?.settlePosition === 'function') {
      sink.oms.settlePosition({
        strategyInstanceId,
        price,
        marketId: marketId ?? opts.marketId,
        reason: opts.reason ?? 'settlement',
      });
    }
    const result = {
      settled: true,
      side,
      qty,
      avgPrice: avg,
      settlementPrice: price,
      pnlDelta,
      realizedPnl,
      marketId,
      reason: opts.reason ?? 'settlement',
    };
    journal.push({ type: 'settlement', ...result, tsMs: clock() });
    return result;
  }

  const api = {
    get state() {
      return state;
    },
    get mode() {
      return mode;
    },
    get position() {
      return { ...position };
    },
    get diagnostics() {
      return { ...lastDiagnostics };
    },
    get journal() {
      return [...journal];
    },
    get strategyInstanceId() {
      return strategyInstanceId;
    },
    get strategyId() {
      return strategy.manifest.id;
    },
    get risk() {
      return riskEngine;
    },
    settlePosition,
    getLastSnapshot() {
      return lastSnapshot ? structuredClone(lastSnapshot) : null;
    },
    async submitOperatorIntent(intent) {
      if (!intent || typeof intent !== 'object') throw new Error('operator intent obrigatório');
      return dispatchIntent({
        ...intent,
        strategyInstanceId,
        intentId:
          intent.intentId ??
          `${strategyInstanceId}:${intent.marketId ?? lastSnapshot?.marketId}:operator:${intent.kind}:${++intentSeq}`,
      });
    },

    start() {
      if (state !== 'BOOT' && state !== 'HALTED') {
        throw new Error(`start inválido em ${state}`);
      }

      if (mode === 'live' && typeof sink.assertReady === 'function') sink.assertReady();

      if (typeof riskEngine.runPreflight === 'function') {
        const pf = riskEngine.runPreflight({ mode });
        if (!pf.ok) {
          const first = pf.failures[0];
          throw new Error(`preflight fail-closed: ${first?.reasonCode ?? 'PREFLIGHT'}`);
        }
      }

      if (riskEngine.killSwitch?.active) {
        riskEngine.killSwitch.reset();
      }

      haltReason = null;
      if (!restored) {
        const init = strategy.initialize(
          buildStrategyContext({
            snapshot: lastSnapshot ?? {
              marketId: 'bootstrap',
              nowMs: clock(),
              secsLeft: null,
              btc: null,
              priceToBeat: null,
              book: {},
            },
            position: { ...position },
            mode,
            clockMs: clock(),
            preset,
            strategyInstanceId,
          }),
          preset,
        );
        strategyState = init?.state ?? {};
        lastDiagnostics = init?.diagnostics ?? {};
      }
      restored = false;
      transition('ACCOUNT_READY', 'start');
      transition('MARKET_SYNCING', 'start');
      transition('OBSERVING', 'start');
      transition('ARMED', 'start');
      return api.getStatus();
    },

    halt(reason = 'halt') {
      return safeShutdown(reason);
    },

    kill(reason = 'kill') {
      if (typeof riskEngine.tripKill === 'function') {
        riskEngine.tripKill(reason);
      }
      return safeShutdown(reason);
    },

    safeShutdown,

    /**
     * @param {import('./schemas.js').MarketSnapshot} snapshot
     */
    async ingestSnapshot(snapshot) {
      if (state === 'HALTED' || riskEngine.killSwitch?.active) {
        return { skipped: true, reason: 'HALTED' };
      }
      if (state === 'BOOT') {
        throw new Error('Engine não iniciada — chame start()');
      }

      assertMarketSnapshot(snapshot);
      lastSnapshot = snapshot;

      if (state === 'MARKET_SYNCING' || state === 'OBSERVING') {
        transition('ARMED', 'snapshot');
      }

      const ctx = buildStrategyContext({
        snapshot,
        position: { ...position },
        openIntents: [...pendingIntents.values()],
        mode,
        clockMs: clock(),
        health: {
          ok: snapshot.feeds?.healthy !== false,
        },
        preset,
        strategyInstanceId,
        accountEquityUsd: resolveAccountEquityUsd(),
      });

      const raw = strategy.onSnapshot(ctx, strategyState);
      const normalized = normalizeStrategyResult(raw, { strategyInstanceId });
      strategyState = normalized.state;
      lastDiagnostics = normalized.diagnostics;

      const intents = normalized.intents.map((intent) => {
        if (intent.intentId) return intent;
        intentSeq += 1;
        return {
          ...intent,
          intentId: `${strategyInstanceId}:${snapshot.marketId}:${intent.kind}:${intentSeq}`,
        };
      });

      for (const intent of intents) {
        if (!intent.intentId) {
          intentSeq += 1;
          intent.intentId = `${strategyInstanceId}:${snapshot.marketId}:${intent.kind}:${intentSeq}`;
        }
        await dispatchIntent(intent);
      }

      return {
        skipped: false,
        state,
        intentCount: intents.length,
        diagnostics: lastDiagnostics,
        position: { ...position },
      };
    },

    ingestExecutionEvent,

    checkpoint() {
      if (typeof sink.oms?.checkpoint === 'function') {
        sink.oms.checkpoint();
      }
      const omsJournal =
        typeof sink.oms?.journal?.snapshot === 'function' ? sink.oms.journal.snapshot() : null;
      const cp = buildEngineCheckpoint({
        clock,
        mode,
        engineState: state,
        haltReason,
        strategyId: strategy.manifest.id,
        strategyVersion: strategy.manifest.version,
        strategyInstanceId,
        strategyStateVersion,
        strategyState,
        position,
        intentSeq,
        pendingIntents: [...pendingIntents.values()],
        lastSnapshot,
        riskSnapshot: typeof riskEngine.snapshot === 'function' ? riskEngine.snapshot() : null,
        omsCheckpoint: null,
        journalTail: journal.slice(-50),
      });
      cp.omsJournal = omsJournal;
      journal.push({ type: 'checkpoint', tsMs: clock(), schemaVersion: ENGINE_STATE_VERSION });
      return cp;
    },

    /**
     * @param {object} cp
     */
    restore(cp) {
      if (!cp || typeof cp !== 'object') throw new Error('checkpoint inválido');
      if (cp.strategyId && cp.strategyId !== strategy.manifest.id) {
        throw new Error(
          `checkpoint de outra strategy: ${cp.strategyId}; esperado ${strategy.manifest.id}`,
        );
      }
      if (cp.strategyInstanceId && cp.strategyInstanceId !== strategyInstanceId) {
        throw new Error(
          `checkpoint de outra instância: ${cp.strategyInstanceId}; esperado ${strategyInstanceId}`,
        );
      }
      if (cp.mode && cp.mode !== mode) {
        throw new Error(`checkpoint de outro modo: ${cp.mode}; esperado ${mode}`);
      }

      const fromVer = cp.strategyStateVersion ?? 1;
      const toVer = strategy.manifest.stateVersion ?? 1;
      strategyState = migrateStrategyState(cp.strategyState, fromVer, toVer, strategy);
      strategyStateVersion = toVer;

      position = { ...emptyPosition(), ...(cp.position ?? {}) };
      intentSeq = cp.intentSeq ?? 0;
      haltReason = cp.haltReason ?? null;
      lastSnapshot = cp.lastSnapshot ?? null;
      pendingIntents.clear();
      for (const intent of cp.pendingIntents ?? []) {
        pendingIntents.set(intent.intentId, intent);
      }

      if (cp.risk && typeof riskEngine.restore === 'function') {
        riskEngine.restore(cp.risk);
      }

      if (cp.omsJournal && sink.oms && typeof sink.oms.restoreFromJournal === 'function') {
        sink.oms.restoreFromJournal(cp.omsJournal);
      }

      state = cp.engineState === 'HALTED' ? 'HALTED' : 'BOOT';
      restored = true;
      journal.push({
        type: 'restore',
        from: cp.savedAtMs,
        engineState: cp.engineState,
        tsMs: clock(),
      });

      return api.getStatus();
    },

    /**
     * Atualiza saldo de conta em USD (preflight/CLOB) para equity scale no plugin.
     * @param {number|null} usd
     */
    setAccountEquityUsd(usd) {
      if (usd == null || !Number.isFinite(Number(usd))) {
        accountEquityUsd = null;
        return null;
      }
      accountEquityUsd = Number(usd);
      return accountEquityUsd;
    },

    getStatus() {
      return {
        state,
        mode,
        haltReason,
        strategyId: strategy.manifest.id,
        strategyVersion: strategy.manifest.version,
        strategyInstanceId,
        accountEquityUsd: resolveAccountEquityUsd(),
        position: { ...position },
        pendingIntentCount: pendingIntents.size,
        lastMarketId: lastSnapshot?.marketId ?? null,
        // Preços do último snapshot (para UI/gráficos; independente de diagnostics de evento).
        lastSpot:
          lastSnapshot && Number.isFinite(Number(lastSnapshot.btc))
            ? {
                btc: Number(lastSnapshot.btc),
                priceToBeat: Number.isFinite(Number(lastSnapshot.priceToBeat))
                  ? Number(lastSnapshot.priceToBeat)
                  : null,
                secsLeft: Number.isFinite(Number(lastSnapshot.secsLeft))
                  ? Number(lastSnapshot.secsLeft)
                  : null,
                nowMs: lastSnapshot.nowMs ?? null,
                marketId: lastSnapshot.marketId ?? null,
                book: {
                  upAsk: Number.isFinite(Number(lastSnapshot.book?.up?.bestAsk))
                    ? Number(lastSnapshot.book.up.bestAsk)
                    : null,
                  upBid: Number.isFinite(Number(lastSnapshot.book?.up?.bestBid))
                    ? Number(lastSnapshot.book.up.bestBid)
                    : null,
                  downAsk: Number.isFinite(Number(lastSnapshot.book?.down?.bestAsk))
                    ? Number(lastSnapshot.book.down.bestAsk)
                    : null,
                  downBid: Number.isFinite(Number(lastSnapshot.book?.down?.bestBid))
                    ? Number(lastSnapshot.book.down.bestBid)
                    : null,
                },
              }
            : null,
        diagnostics: { ...lastDiagnostics },
        journalLength: journal.length,
        killActive: Boolean(riskEngine.killSwitch?.active),
        riskMetrics: typeof riskEngine.audit?.metrics === 'function' ? riskEngine.audit.metrics() : {},
        entryEnabled: riskEngine.entryEnabled !== false,
      };
    },
  };

  if (typeof sink.onExecutionEvent === 'function') {
    sink.onExecutionEvent((event) => ingestExecutionEvent(event));
  }
  if (typeof sink.onCritical === 'function') {
    sink.onCritical((detail) => {
      if (state !== 'HALTED') return safeShutdown(detail?.reason ?? 'sink-critical');
      return null;
    });
  }

  return api;
}
