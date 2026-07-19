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
  const orphanOrders = parts.orphanOrders ?? 0;
  const openOrders = parts.openOrders ?? 0;

  const healthy = state !== 'BOOT' && !killActive;
  const ready = ['ARMED', 'POSITION_OPEN', 'OBSERVING', 'ENTRY_PENDING', 'EXIT_PENDING', 'REVERSE_PENDING'].includes(
    state,
  );
  const armed = state === 'ARMED' || state === 'POSITION_OPEN';
  const live = mode === 'live' && ready && !killActive;
  const halted = state === 'HALTED' || killActive;

  return {
    ok: healthy && orphanOrders === 0,
    healthy,
    ready,
    armed,
    live,
    halted,
    feedsOk,
    orphanOrders,
    openOrders,
    availability: parts.availability ?? null,
    state,
    mode,
    killActive,
    tsMs: Date.now(),
  };
}
