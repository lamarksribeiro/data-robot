/**
 * Status de saúde da engine para probes e UI ops.
 */

/**
 * @param {object} parts
 */
export function buildHealthReport(parts) {
  const engineStatus = parts.engineStatus ?? {};
  const state = engineStatus.state ?? 'BOOT';
  const killActive = Boolean(engineStatus.killActive);
  const mode = engineStatus.mode ?? parts.mode ?? 'dry-run';

  const feedsOk = parts.feedsOk !== false;
  const recoveryOk = parts.recoveryOk !== false;
  const userChannelOk = parts.userChannelOk !== false;
  const orphanOrders = parts.orphanOrders ?? 0;
  const openOrders = parts.openOrders ?? 0;

  const healthy = state !== 'BOOT' && !killActive;
  const dependenciesOk = feedsOk && recoveryOk && userChannelOk && orphanOrders === 0;
  const ready =
    dependenciesOk &&
    ['ARMED', 'POSITION_OPEN', 'OBSERVING', 'ENTRY_PENDING', 'EXIT_PENDING', 'REVERSE_PENDING'].includes(
      state,
    );
  const armed = dependenciesOk && (state === 'ARMED' || state === 'POSITION_OPEN');
  const live = mode === 'live' && ready && !killActive;
  const halted = state === 'HALTED' || killActive;

  return {
    ok: healthy && dependenciesOk,
    healthy,
    ready,
    armed,
    live,
    halted,
    feedsOk,
    recoveryOk,
    userChannelOk,
    orphanOrders,
    openOrders,
    availability: parts.availability ?? null,
    state,
    operatorState: engineStatus.operatorState ?? null,
    entryEnabled: engineStatus.entryEnabled !== false,
    mode,
    killActive,
    tsMs: Date.now(),
  };
}
