/**
 * Estados de ordem do OMS (Polymarket-aligned, genérico).
 */

export const ORDER_STATES = Object.freeze([
  'CREATED',
  'LIVE',
  'PARTIAL',
  'MATCHED',
  'CANCEL_PENDING',
  'CANCELED',
  'REJECTED',
  'UNKNOWN',
]);

export const TERMINAL_STATES = Object.freeze(['MATCHED', 'CANCELED', 'REJECTED']);

/** Transições permitidas (from → to[]). */
export const ORDER_TRANSITIONS = Object.freeze({
  CREATED: ['LIVE', 'REJECTED', 'UNKNOWN', 'MATCHED', 'PARTIAL'],
  LIVE: ['PARTIAL', 'MATCHED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  PARTIAL: ['PARTIAL', 'MATCHED', 'CANCEL_PENDING', 'CANCELED', 'UNKNOWN'],
  CANCEL_PENDING: ['CANCELED', 'MATCHED', 'PARTIAL', 'UNKNOWN'],
  MATCHED: [],
  CANCELED: [],
  REJECTED: [],
  UNKNOWN: ['LIVE', 'PARTIAL', 'MATCHED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
});

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransition(from, to) {
  if (!ORDER_STATES.includes(from) || !ORDER_STATES.includes(to)) return false;
  if (from === to && (from === 'PARTIAL' || from === 'UNKNOWN')) return true;
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}
