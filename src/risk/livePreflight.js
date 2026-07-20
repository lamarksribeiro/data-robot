import { AssetType } from '@polymarket/clob-client-v2';

function normalizeServerTimeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function parseCollateral(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

function validAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value ?? '').trim());
}

/**
 * Executa checks read-only reais antes de construir uma engine live.
 * O retorno é injetado no preflight síncrono da engine para que nenhum
 * fallback permissivo exista no caminho de ordens.
 */
export async function runLivePreflight(opts) {
  if (!opts?.client) throw new Error('runLivePreflight: client obrigatório');
  const client = opts.client;
  const now = opts.clock ?? (() => Date.now());
  const maxClockSkewMs = Number(opts.maxClockSkewMs ?? 5000);
  const minBalanceUsd = Number(opts.minBalanceUsd ?? 0);
  const fetchFn = opts.fetchFn ?? fetch;

  const checks = {};

  try {
    const signerAddress = opts.signerAddress;
    const signatureType = Number(opts.signatureType);
    const funderAddress = String(opts.funderAddress ?? '').trim();
    const identityOk =
      validAddress(signerAddress) &&
      Number.isInteger(signatureType) &&
      signatureType >= 0 &&
      signatureType <= 3 &&
      (signatureType === 0 || validAddress(funderAddress));
    if (!identityOk) throw new Error('signer/funder/signatureType incoerentes');
    const openOrders = await client.getOpenOrders();
    const openOrdersCount = Array.isArray(openOrders) ? openOrders.length : null;
    checks.auth = {
      ok:
        Array.isArray(openOrders) &&
        (opts.allowExistingOpenOrders === true || openOrdersCount === 0),
      openOrdersCount,
      reason:
        openOrdersCount > 0 && opts.allowExistingOpenOrders !== true
          ? 'EXISTING_OPEN_ORDERS'
          : null,
    };
  } catch (err) {
    checks.auth = { ok: false, reason: err.message || 'AUTH_FAILED' };
  }

  try {
    const serverTimeMs = normalizeServerTimeMs(await client.getServerTime());
    const localTimeMs = now();
    const skewMs = serverTimeMs == null ? Infinity : Math.abs(localTimeMs - serverTimeMs);
    checks.clock = {
      ok: Number.isFinite(skewMs) && skewMs <= maxClockSkewMs,
      skewMs,
      maxClockSkewMs,
      serverTimeMs,
      offsetMs: serverTimeMs == null ? null : serverTimeMs - localTimeMs,
    };
  } catch (err) {
    checks.clock = { ok: false, reason: err.message || 'CLOCK_FAILED' };
  }

  try {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balanceUsd = parseCollateral(bal?.balance);
    const allowanceUsd = Math.max(
      0,
      ...Object.values(bal?.allowances ?? {}).map((v) => parseCollateral(v)),
    );
    checks.balance = {
      ok: balanceUsd >= minBalanceUsd && allowanceUsd >= minBalanceUsd,
      balanceUsd,
      allowanceUsd,
      minBalanceUsd,
    };
  } catch (err) {
    checks.balance = { ok: false, reason: err.message || 'BALANCE_FAILED' };
  }

  try {
    const response = await fetchFn('https://polymarket.com/api/geoblock', {
      signal: AbortSignal.timeout(Number(opts.timeoutMs ?? 5000)),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`geoblock HTTP ${response.status}`);
    const geo = await response.json();
    checks.geoblock = {
      ok: geo?.blocked === false,
      blocked: geo?.blocked !== false,
      country: geo?.country ?? null,
      region: geo?.region ?? null,
    };
  } catch (err) {
    checks.geoblock = { ok: false, blocked: true, reason: err.message || 'GEOBLOCK_FAILED' };
  }

  return {
    ok: Object.values(checks).every((check) => check.ok === true),
    checks,
    checkedAt: new Date(now()).toISOString(),
  };
}

export function preflightChecksFromResult(result) {
  const checks = result?.checks ?? {};
  return Object.fromEntries(
    ['auth', 'geoblock', 'clock', 'balance'].map((name) => [name, () => checks[name] ?? { ok: false }]),
  );
}
