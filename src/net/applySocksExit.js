/**
 * Roteia HTTP(S) do processo pelo SOCKS (ex.: ssh -D 1080 Giovanna).
 * Axios (CLOB) + fetch nativo (ping/mercados) passam pelo exit do servidor.
 */
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

let applied = null;

export function applySocksExit(socksUrl = process.env.GIOVANNA_SOCKS || 'socks5h://127.0.0.1:1080') {
  if (applied === socksUrl) return applied;

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
      timeout: 60_000,
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
