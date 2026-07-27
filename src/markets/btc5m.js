import { findActiveCrypto5mEvent } from './crypto5m.js';

/** @deprecated Prefer findActiveCrypto5mEvent('btc') */
export async function findActiveBtc5mEvent(now = new Date()) {
  return findActiveCrypto5mEvent('btc', now);
}
