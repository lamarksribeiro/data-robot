/**
 * Roteia HTTP(S) do processo pelo SOCKS (ex.: ssh -D 1080 Giovanna).
 * Axios (CLOB) + fetch nativo (ping/mercados) passam pelo exit do servidor.
 */
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** Timeout padrão para fetch via proxy — compatível com janelas de 5 min. */
export const DEFAULT_SOCKS_FETCH_TIMEOUT_MS = 10_000;

let applied = null;
let nativeFetch = globalThis.fetch?.bind(globalThis) ?? null;

export function isSocksExitActive() {
  return applied != null;
}

export function getSocksExitUrl() {
  return applied;
}

export function assertSocksExitActive(context = 'request') {
  if (!isSocksExitActive()) {
    throw new Error(`SOCKS_EXIT_REQUIRED:${context}`);
  }
}

/**
 * @param {string} [socksUrl]
 * @param {object} [opts]
 * @param {number} [opts.fetchTimeoutMs]
 */
export function applySocksExit(
  socksUrl = process.env.GIOVANNA_SOCKS || 'socks5h://127.0.0.1:1080',
  opts = {},
) {
  if (applied === socksUrl) return applied;

  if (!nativeFetch) {
    nativeFetch = globalThis.fetch?.bind(globalThis) ?? null;
  }

  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_SOCKS_FETCH_TIMEOUT_MS;
  const agent = new SocksProxyAgent(socksUrl);
  axios.defaults.httpAgent = agent;
  axios.defaults.httpsAgent = agent;
  axios.defaults.proxy = false;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers
      ? Object.fromEntries(new Headers(init.headers).entries())
      : undefined;
    const callerSignal = init.signal;

    const res = await axios({
      url,
      method,
      headers,
      data: init.body,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      transformResponse: [(d) => d],
      signal: callerSignal ?? undefined,
      timeout: callerSignal ? undefined : fetchTimeoutMs,
    });

    const hdrs = new Headers();
    for (const [k, v] of Object.entries(res.headers || {})) {
      if (v == null) continue;
      hdrs.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }

    return new Response(res.data, { status: res.status, statusText: res.statusText, headers: hdrs });
  };

  applied = socksUrl;
  return applied;
}

export async function probeExitIdentity(socksUrl) {
  applySocksExit(socksUrl);
  const geo = await axios.get('https://polymarket.com/api/geoblock', {
    httpAgent: axios.defaults.httpAgent,
    httpsAgent: axios.defaults.httpsAgent,
    proxy: false,
    timeout: 20_000,
  });
  return geo.data;
}
