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
    const kind = pending?.kind ?? 'ENTER';

    if (kind === 'ENTER' || kind === 'REVERSE') {
      if (kind === 'REVERSE' && position.qty > 0 && position.side && position.side !== side) {
        position = emptyPosition({ marketId: position.marketId });
      }
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
        const dir = position.side === 'UP' ? 1 : -1;
        pnlDelta = dir * (price - position.avgPrice) * closeQty;
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
      if (typeof riskEngine.recordFailure === 'function') {
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
      accepted: result.accepted,
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
    journal.push({ type: 'execution', event, tsMs: clock() });
    applyFill(event);

    if (event.type === 'FILL' || event.type === 'CANCEL' || event.type === 'REJECT') {
      if (event.intentId) pendingIntents.delete(event.intentId);
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
    pendingIntents.clear();

    let canceled = [];
    if (typeof sink.cancelOnDisconnect === 'function') {
      const r = sink.cancelOnDisconnect();
      canceled = r?.canceled ?? [];
    } else if (typeof sink.dispose === 'function') {
      sink.dispose();
    }

    journal.push({ type: 'shutdown', reason, canceled, tsMs: clock() });
    return { state, haltReason, canceled };
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

    start() {
      if (state !== 'BOOT' && state !== 'HALTED') {
        throw new Error(`start inválido em ${state}`);
      }

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
      journal.push({
        type: 'restore',
        from: cp.savedAtMs,
        engineState: cp.engineState,
        tsMs: clock(),
      });

      return api.getStatus();
    },

    getStatus() {
      return {
        state,
        mode,
        haltReason,
        strategyId: strategy.manifest.id,
        strategyVersion: strategy.manifest.version,
        strategyInstanceId,
        position: { ...position },
        pendingIntentCount: pendingIntents.size,
        lastMarketId: lastSnapshot?.marketId ?? null,
        diagnostics: { ...lastDiagnostics },
        journalLength: journal.length,
        killActive: Boolean(riskEngine.killSwitch?.active),
        riskMetrics: typeof riskEngine.audit?.metrics === 'function' ? riskEngine.audit.metrics() : {},
      };
    },
  };

  return api;
}
