/**
 * Persistência / recovery da engine (checkpoint + restore).
 * stateVersion permite migrateState da strategy.
 */

export const ENGINE_STATE_VERSION = 1;

/**
 * @param {object} engineApi — campos internos expostos via getPersistenceHooks
 * @param {object} [opts]
 */
export function buildEngineCheckpoint(parts) {
  return {
    schemaVersion: ENGINE_STATE_VERSION,
    savedAtMs: parts.clock?.() ?? Date.now(),
    mode: parts.mode,
    engineState: parts.engineState,
    haltReason: parts.haltReason,
    strategyId: parts.strategyId,
    strategyVersion: parts.strategyVersion,
    strategyInstanceId: parts.strategyInstanceId,
    strategyStateVersion: parts.strategyStateVersion ?? 1,
    strategyState: parts.strategyState ?? {},
    position: parts.position ?? {},
    intentSeq: parts.intentSeq ?? 0,
    pendingIntents: parts.pendingIntents ?? [],
    lastSnapshot: parts.lastSnapshot ?? null,
    risk: parts.riskSnapshot ?? null,
    oms: parts.omsCheckpoint ?? null,
    journalTail: parts.journalTail ?? [],
  };
}

/**
 * Migração de state de strategy entre versões.
 * @param {object} state
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {object} [strategy] — se tiver migrateState
 */
export function migrateStrategyState(state, fromVersion, toVersion, strategy) {
  if (fromVersion === toVersion) return state ?? {};
  if (typeof strategy?.migrateState === 'function') {
    return strategy.migrateState(state ?? {}, fromVersion, toVersion);
  }
  // default: aceita forward compat shallow
  return { ...(state ?? {}), _migratedFrom: fromVersion, _migratedTo: toVersion };
}
