/**
 * Engine runtime genérica — lifecycle + intents + sink.
 * Não importa plugins de estratégia.
 */

import { buildStrategyContext, normalizeStrategyResult } from './contract.js';
import { createBasicRisk } from './risk.js';
import {
  ENGINE_STATES,
  EXECUTION_MODES,
  assertMarketSnapshot,
  emptyPosition,
} from './schemas.js';
import { createSinkForMode } from './sinks.js';

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
  const risk = opts.risk ?? createBasicRisk();
  const clock = opts.clock ?? (() => Date.now());

  let state = 'BOOT';
  let strategyState = {};
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
      if (position.avgPrice != null && price != null) {
        const dir = position.side === 'UP' ? 1 : -1;
        // Em tokens binários o PnL real depende da resolução; aqui só marca mark-to-exit shadow.
        position.realizedPnl += dir * (price - position.avgPrice) * closeQty;
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
    const decision = risk.evaluate(intent, {
      health: lastSnapshot?.feeds?.healthy === false ? { ok: false } : { ok: true },
      mode,
    });
    journal.push({
      type: 'risk',
      intentId: intent.intentId,
      decision,
      tsMs: clock(),
    });
    if (!decision.allow) return;

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

    for (const event of result.events ?? []) {
      await ingestExecutionEvent(event);
    }
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

  return {
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

    start() {
      if (state !== 'BOOT' && state !== 'HALTED') {
        throw new Error(`start inválido em ${state}`);
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
      return this.getStatus();
    },

    halt(reason = 'halt') {
      haltReason = reason;
      transition('HALTED', reason);
      pendingIntents.clear();
      return this.getStatus();
    },

    /**
     * @param {import('./schemas.js').MarketSnapshot} snapshot
     */
    async ingestSnapshot(snapshot) {
      if (state === 'HALTED') {
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

      // Anexa seq determinística se o plugin omitiu intentId completo
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
      };
    },
  };
}
