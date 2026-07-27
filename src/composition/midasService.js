/** Dependências reais do serviço MIDAS P9. Composition root; nunca importado pelo core. */

import { AssetType, OrderType, Side } from '@polymarket/clob-client-v2';
import config from '../config.js';
import { buildClobClient } from '../clob/buildClient.js';
import { buildPolymarketPortfolio, fetchPositionsValueUsd } from '../clob/portfolioValue.js';
import { resolveSignatureType } from '../clob/signatureType.js';
import { createSigner } from '../clob/wallet.js';
import { createLiveTransport } from '../executor/liveTransport.js';
import { createUserChannel } from '../executor/userChannel.js';
import { createOmsSink } from '../oms/omsSink.js';
import { createLogger } from '../observability/logger.js';
import { preflightChecksFromResult, runLivePreflight } from '../risk/livePreflight.js';
import { createFileAccountRiskBook } from '../risk/fileAccountBook.js';
import {
  CANARY_LIMITS,
  PORTFOLIO_PRODUCTION,
  PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD,
  canaryMidasPreset,
} from '../tfc/preset-midas.js';

/** Hard cap legado do micro-canário ($4). */
export const MIDAS_CANARY_HARD_CAP_USD = CANARY_LIMITS.maxCanaryBudget;
/** Teto live portfolio ($4). prepareMidasCanaryRuntime usa este. */
export const MIDAS_LIVE_HARD_CAP_USD = PORTFOLIO_PRODUCTION.maxEntryBudget;
/** Exposição agregada portfolio (4 × $4). */
export const MIDAS_PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD = PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCollateral(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

/**
 * Lê a carteira direto das mesmas fontes da UI Polymarket:
 * CLOB cash + Data API /value → Portfolio.
 * Faz updateBalanceAllowance antes do get para sincronizar o cache CLOB.
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

  if (opts.skipBalanceSync !== true && typeof client.updateBalanceAllowance === 'function') {
    try {
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    } catch {
      /* segue com get — sync é best-effort */
    }
  }

  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const cashUsd = parseCollateral(bal?.balance);
  const rawAllowance = Math.max(
    0,
    ...Object.values(bal?.allowances ?? {}).map((v) => parseCollateral(v)),
    0,
  );
  const allowanceUsd = rawAllowance > 1e9 ? null : rawAllowance;

  const positionsValueUsd = await fetchPositionsValueUsd({
    funderAddress,
    fetchFn: opts.fetchFn,
    dataApiBase: opts.dataApiBase ?? config.dataApiBase,
    timeoutMs: opts.timeoutMs,
  });

  const portfolio = buildPolymarketPortfolio({
    cashUsd,
    positionsValueUsd,
    allowanceUsd,
    allowanceUnlimited: rawAllowance > 1e9,
    funderAddress,
  });

  return {
    ok: true,
    displayOnly: true,
    checkedAt: new Date((opts.clock ?? Date.now)()).toISOString(),
    checks: {
      balance: {
        ok: Number.isFinite(cashUsd),
        ...portfolio,
        minBalanceUsd: 0,
      },
    },
  };
}

export async function prepareMidasCanaryRuntime(opts = {}) {
  const hardCap = positive(opts.liveHardCapUsd, MIDAS_LIVE_HARD_CAP_USD);
  const requestedCap = positive(opts.maxCanaryBudget, MIDAS_CANARY_HARD_CAP_USD);
  if (requestedCap > hardCap) {
    throw new Error(`cap solicitado $${requestedCap} excede hard cap $${hardCap}`);
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
      logger: opts.logger ?? createLogger({ service: 'data-robot-engine' }),
      userWsStaleMs: positive(opts.userWsStaleMs, 30_000),
      clobHeartbeatHaltMs: Number.isFinite(Number(opts.clobHeartbeatHaltMs))
        ? Number(opts.clobHeartbeatHaltMs)
        : Number(process.env.ENGINE_CLOB_HEARTBEAT_HALT_MS || 60_000),
      userDisconnectHaltMs: Number.isFinite(Number(opts.userDisconnectHaltMs))
        ? Number(opts.userDisconnectHaltMs)
        : Number(process.env.ENGINE_USER_DISCONNECT_HALT_MS || 60_000),
      clobHeartbeatMs: Number.isFinite(Number(opts.clobHeartbeatMs))
        ? Number(opts.clobHeartbeatMs)
        : Number(process.env.ENGINE_CLOB_HEARTBEAT_MS || 5_000),
    });

  const accountExposure = positive(
    opts.maxAccountExposure,
    MIDAS_PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD,
  );
  const sharedBook =
    opts.accountBook ??
    (opts.shareAccountBook === false || process.env.ENGINE_SHARE_ACCOUNT_BOOK === '0'
      ? undefined
      : createFileAccountRiskBook({
          maxAccountExposure: accountExposure,
          file: opts.accountBookFile,
        }));

  return {
    sink,
    // Preset já resolvido pelo engine-serve (portfolio vs micro); não rebaixar aqui.
    preset: opts.preset ?? canaryMidasPreset(),
    riskOpts: {
      preflightChecks: preflightChecksFromResult(preflight),
      canaryMode: true,
      maxCanaryBudget: requestedCap,
      maxNotionalPerOrder: requestedCap,
      maxNotionalPerEvent: requestedCap,
      maxAccountExposure: accountExposure,
      maxDailyLoss: positive(opts.maxDailyLoss, accountExposure),
      maxSlippage: CANARY_LIMITS.maxSlippage,
      allowLiveReverse: opts.allowLiveReverse !== false,
      accountBook: sharedBook,
      // 0 = ilimitado na control window; por evento: até maxEntryAttemptsPerEvent
      // (FAK miss libera o slot ONE_INTENT para retry na janela terminal).
      maxEntryAttemptsPerEvent: Number.isFinite(Number(opts.maxEntryAttemptsPerEvent))
        ? Math.max(1, Number(opts.maxEntryAttemptsPerEvent))
        : Number.isFinite(Number(process.env.ENGINE_MAX_ENTRY_ATTEMPTS_PER_EVENT))
          ? Math.max(1, Number(process.env.ENGINE_MAX_ENTRY_ATTEMPTS_PER_EVENT))
          : 5,
      maxEntriesPerControlWindow: Number.isFinite(Number(opts.maxEntriesPerControlWindow))
        ? Math.max(0, Number(opts.maxEntriesPerControlWindow))
        : 0,
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
