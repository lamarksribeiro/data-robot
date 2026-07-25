/**
 * Valor mark-to-market das posições abertas via Data API pública.
 * A Polymarket monta o portfolio como cash CLOB + este valor.
 */

/**
 * @param {{ funderAddress: string, fetchFn?: typeof fetch, dataApiBase?: string, timeoutMs?: number }} opts
 * @returns {Promise<number|null>}
 */
export async function fetchPositionsValueUsd(opts) {
  const funder = String(opts?.funderAddress ?? '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(funder)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const base = String(opts.dataApiBase ?? 'https://data-api.polymarket.com').replace(/\/$/, '');
  try {
    const response = await fetchFn(`${base}/value?user=${encodeURIComponent(funder)}`, {
      signal: AbortSignal.timeout(Number(opts.timeoutMs ?? 5000)),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const row = Array.isArray(body) ? body[0] : body;
    const value = Number(row?.value);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
