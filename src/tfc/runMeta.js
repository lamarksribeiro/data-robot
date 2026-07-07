import os from 'node:os';
import config from '../config.js';

/**
 * Metadados do ambiente de execução — usado para comparar local (VPN) vs servidor.
 */
export function collectRunMeta(overrides = {}) {
  const label = overrides.label
    ?? process.env.TFC_RUN_LABEL
    ?? process.env.TFC_RUN_ENV
    ?? 'local';

  return {
    kind: overrides.kind ?? 'latency',
    label,
    ts: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${process.platform}/${os.arch()}`,
    node: process.version,
    clobHttpUrl: config.clobHttpUrl,
    note: overrides.note ?? null,
  };
}

export async function measureClobPing() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${config.clobHttpUrl}/time`, {
      headers: { Accept: 'application/json', 'User-Agent': 'GoldenLens-DataRobot/1.1' },
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ms, ok: false, status: res.status };
    const body = await res.json();
    return { ms, ok: true, serverTime: body };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), ok: false, error: err.message };
  }
}
