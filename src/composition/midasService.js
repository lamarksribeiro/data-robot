/** Dependências reais do serviço MIDAS P9. Composition root; nunca importado pelo core. */

import { AssetType, OrderType, Side } from '@polymarket/clob-client-v2';
import config from '../config.js';
import { buildClobClient } from '../clob/buildClient.js';
import { resolveSignatureType } from '../clob/signatureType.js';
import { createSigner } from '../clob/wallet.js';
import { createLiveTransport } from '../executor/liveTransport.js';
import { createUserChannel } from '../executor/userChannel.js';
import { createOmsSink } from '../oms/omsSink.js';
import { preflightChecksFromResult, runLivePreflight } from '../risk/livePreflight.js';
import { CANARY_LIMITS, canaryMidasPreset } from '../tfc/preset-midas.js';

export const MIDAS_CANARY_HARD_CAP_USD = CANARY_LIMITS.maxCanaryBudget;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCollateral(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

/**
 * Leitura read-only de saldo/allowance USDC no CLOB (para dashboard em shadow/local).
 * Não habilita trading; não substitui preflight live completo.
 */
export async function fetchWalletSnapshot(opts = {}) {
  if (!config.polymarketPrivateKey) {
    throw new Error('POLYMARKET_PRIVATE_KEY ausente');
  }
  const wallet = opts.wallet ?? createSigner(config.polymarketPrivateKey);
  const signatureType = opts.signatureType ?? resolveSignatureType(config.polymarketSignatureType);
  const funderAddress =
    String(opts.funderAddress ?? config.polymarketFunderAddress ?? wallet.address).trim() ||
    wallet.address;
  const client =
    opts.client ?? buildClobClient({ wallet, signatureType, funderAddress, throwOnError: true });

  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balanceUsd = parseCollateral(bal?.balance);
  const rawAllowance = Math.max(
    0,
    ...Object.values(bal?.allowances ?? {}).map((v) => parseCollateral(v)),
    0,
  );
  // CLOB às vezes devolve allowance “max uint” — trata como efetivamente ilimitado p/ UI.
  const allowanceUsd = rawAllowance > 1e9 ? null : rawAllowance;

  return {
    ok: true,
    displayOnly: true,
    checkedAt: new Date((opts.clock ?? Date.now)()).toISOString(),
    checks: {
      balance: {
        ok: Number.isFinite(balanceUsd),
        balanceUsd,
        allowanceUsd,
        allowanceUnlimited: rawAllowance > 1e9,
        minBalanceUsd: 0,
        source: 'clob-read',
      },
    },
  };
}

export async function prepareMidasCanaryRuntime(opts = {}) {
  const requestedCap = positive(opts.maxCanaryBudget, MIDAS_CANARY_HARD_CAP_USD);
  if (requestedCap > MIDAS_CANARY_HARD_CAP_USD) {
    throw new Error(
      `cap solicitado $${requestedCap} excede hard cap $${MIDAS_CANARY_HARD_CAP_USD}`,
    );
  }

  const wallet = opts.wallet ?? createSigner(config.polymarketPrivateKey);
  const signatureType = opts.signatureType ?? resolveSignatureType(config.polymarketSignatureType);
  const funderAddress = String(
    opts.funderAddress ?? config.polymarketFunderAddress ?? wallet.address,
  ).trim() || wallet.address;
  const client =
    opts.client ?? buildClobClient({ wallet, signatureType, funderAddress, throwOnError: true });

  const runPreflight = () =>
    runLivePreflight({
      client,
      signerAddress: wallet.address,
      signatureType,
      funderAddress,
      minBalanceUsd: requestedCap,
      // Recovery decide se as ordens remotas pertencem ao journal; não fingimos que não existem.
      allowExistingOpenOrders: true,
      fetchFn: opts.fetchFn,
      clock: opts.clock,
    });
  const preflight = await runPreflight();
  if (!preflight.ok) {
    const failed = Object.entries(preflight.checks)
      .filter(([, check]) => check.ok !== true)
      .map(([name]) => name)
      .join(', ');
    throw new Error(`preflight live reprovado: ${failed || 'UNKNOWN'}`);
  }

  const userChannel =
    opts.userChannel ??
    createUserChannel({
      kind: 'ws',
      url: config.clobUserWsUrl,
      auth: {
        apiKey: config.polymarketApiKey,
        secret: config.polymarketApiSecret,
        passphrase: config.polymarketApiPassphrase,
      },
      // Sem filtro: o serviço sobrevive à rotação BTC 5m.
      markets: [],
      clock: opts.clock,
    });
  const transport =
    opts.transport ?? createLiveTransport({ client, Side, OrderType, clock: opts.clock });
  const sink =
    opts.sink ??
    createOmsSink({
      mode: 'live',
      transport,
      userChannel,
      clock: opts.clock,
      userWsStaleMs: positive(opts.userWsStaleMs, 30_000),
    });

  return {
    sink,
    preset: canaryMidasPreset({ ...(opts.preset ?? {}) }),
    riskOpts: {
      preflightChecks: preflightChecksFromResult(preflight),
      canaryMode: true,
      maxCanaryBudget: requestedCap,
      maxNotionalPerOrder: requestedCap,
      maxNotionalPerEvent: requestedCap,
      maxAccountExposure: positive(opts.maxAccountExposure, requestedCap),
      maxDailyLoss: positive(opts.maxDailyLoss, requestedCap),
      maxSlippage: CANARY_LIMITS.maxSlippage,
      allowLiveReverse: opts.allowLiveReverse !== false,
      maxEntriesPerControlWindow: positive(opts.maxEntriesPerControlWindow, 1),
      controlWindowMs: positive(opts.controlWindowMs, 24 * 60 * 60 * 1000),
    },
    preflight: {
      ok: preflight.ok,
      checkedAt: preflight.checkedAt,
      checks: Object.fromEntries(
        Object.entries(preflight.checks).map(([key, value]) => [key, { ...value }]),
      ),
    },
    async revalidatePreflight() {
      const current = await runPreflight();
      return {
        ok: current.ok,
        checkedAt: current.checkedAt,
        checks: Object.fromEntries(
          Object.entries(current.checks).map(([key, value]) => [key, { ...value }]),
        ),
      };
    },
    client,
  };
}
