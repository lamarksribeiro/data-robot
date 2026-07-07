import config from '../config.js';

const HEADERS = { 'User-Agent': 'GoldenLens-DataRobot/1.1', Accept: 'application/json' };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, retries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

export async function fetchPriceToBeat(eventStart, eventEnd) {
  try {
    const startIso = eventStart.toISOString().replace('.000Z', 'Z');
    const endIso = eventEnd.toISOString().replace('.000Z', 'Z');
    const params = new URLSearchParams({
      symbol: 'BTC',
      eventStartTime: startIso,
      variant: 'fiveminute',
      endDate: endIso,
    });
    const data = await fetchJsonWithRetry(`${config.polymarketCryptoPrice}?${params}`);
    if (data.openPrice != null) return parseFloat(data.openPrice);
  } catch { /* ignore */ }
  return null;
}
