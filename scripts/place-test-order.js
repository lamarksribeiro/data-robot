#!/usr/bin/env node
/**
 * Ordem LIMIT post-only para conferir sincronização API → UI.
 * Dry-run é o padrão. Live exige todos os parâmetros e confirmação textual.
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client-v2';
import { encodeBytes32String } from 'ethers';
import { buildClobClient } from '../src/clob/buildClient.js';
import { createSigner } from '../src/clob/wallet.js';
import config from '../src/config.js';
import {
  PASSIVE_TEST_CONFIRMATION,
  PASSIVE_TEST_LABEL,
  assertLiveConfirmation,
  buildPassiveTestSummary,
  parsePassiveTestArgs,
  validatePassiveTestOrder,
} from '../src/cli/passiveTestOrder.js';

const HELP = `
Uso (simulação padrão, somente leitura):
  npm run test:order -- --market=<condition-id> --token=<token-id> --side=BUY --price=0.01 --quantity=5

Live (GTD post-only, cancelamento automático):
  npm run test:order -- --market=<condition-id> --token=<token-id> --side=BUY --price=0.01 --quantity=5 --live --confirm=${PASSIVE_TEST_CONFIRMATION}

Obrigatórios: --market, --token, --side=BUY|SELL, --price, --quantity
O live aguarda --verify-seconds=10 (máximo 30) para conferência e cancela em seguida.
Use --keep-open somente quando houver confirmação visual pendente; nesse modo a ordem é GTC.
`.trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createPublicClient() {
  return new ClobClient({
    host: config.clobHttpUrl,
    chain: config.chainId,
    useServerTime: true,
    throwOnError: true,
  });
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify({ phase: 'PRE_SEND_SUMMARY', ...summary }, null, 2));
    return;
  }
  console.log('=== POLYMARKET PASSIVE SYNC TEST — PRE-SEND ===');
  console.log(`Modo:        ${summary.mode}`);
  console.log(`Marca:       ${summary.label}`);
  console.log(`Mercado:     ${summary.market}`);
  console.log(`Token:       ${summary.token}`);
  console.log(`Ordem:       ${summary.side} ${summary.quantity} @ ${summary.price}`);
  console.log(`Notional:    US$ ${summary.notionalUsd}`);
  console.log(`Book:        bid=${summary.bestBid} ask=${summary.bestAsk}`);
  console.log(`Regras:      tick=${summary.tickSize} mínimo=${summary.minOrderSize}`);
  console.log(
    `Proteções:   ${summary.orderType} + postOnly + ${summary.autoCancel ? `cancelamento em ${summary.verifySeconds}s` : 'aberta até cancelamento/fechamento do mercado'}`,
  );
}

function wasCanceled(cancelResponse, orderId) {
  return cancelResponse?.canceled?.includes?.(orderId) ?? cancelResponse?.success === true;
}

async function waitForUiVerification(client, orderId, seconds, json) {
  let visible = false;
  for (let elapsed = 1; elapsed <= seconds; elapsed += 1) {
    await sleep(1000);
    const openOrders = await client.getOpenOrders();
    const order = openOrders.find((candidate) => candidate.id === orderId);
    visible ||= Boolean(order);
    if (order && Number(order.size_matched ?? 0) > 0) {
      throw new Error(`A ordem de teste teve execução parcial (${order.size_matched}).`);
    }
    if (!json) {
      console.log(`[${elapsed}s/${seconds}s] visível na API=${Boolean(order)} — confira Portfolio → Open`);
    }
  }
  return visible;
}

async function validateAvailableBalance(client, opts, analysis) {
  const assetType = opts.side === 'BUY' ? AssetType.COLLATERAL : AssetType.CONDITIONAL;
  const params = opts.side === 'BUY'
    ? { asset_type: assetType }
    : { asset_type: assetType, token_id: opts.token };
  const response = await client.getBalanceAllowance(params);
  const available = Number(response?.balance) / 1e6;
  const required = opts.side === 'BUY' ? analysis.notionalUsd : opts.quantity;
  if (!Number.isFinite(available) || available < required) {
    throw new Error(`Saldo insuficiente: disponível=${available} necessário=${required}.`);
  }
  return { available, required, assetType };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parsePassiveTestArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const publicClient = createPublicClient();
  const initialBook = await publicClient.getOrderBook(opts.token);
  const initialAnalysis = validatePassiveTestOrder(opts, initialBook);

  if (!opts.live) {
    const summary = buildPassiveTestSummary(opts, initialAnalysis, {
      metadata: PASSIVE_TEST_LABEL,
      result: 'SIMULATION_ONLY_NO_ORDER_SIGNED_OR_SENT',
    });
    printSummary(summary, opts.json);
    if (!opts.json) console.log('Resultado: simulação concluída; nenhuma ordem foi assinada ou enviada.');
    return summary;
  }

  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });

  // Revalida o book autenticado imediatamente antes do único ponto de escrita.
  const finalBook = await client.getOrderBook(opts.token);
  const finalAnalysis = validatePassiveTestOrder(opts, finalBook);
  const balance = await validateAvailableBalance(client, opts, finalAnalysis);
  const expiresAt = opts.keepOpen ? null : Math.floor(Date.now() / 1000) + 600;
  const metadataHex = encodeBytes32String(PASSIVE_TEST_LABEL);
  const summary = buildPassiveTestSummary(opts, finalAnalysis, {
    expiresAt,
    metadata: PASSIVE_TEST_LABEL,
    metadataHex,
    apiKeyPrefix: config.polymarketApiKey.slice(0, 8) || null,
    balance,
  });
  printSummary(summary, opts.json);

  // Gate no ponto de ação: sem a frase exata, createAndPostOrder nunca é chamado.
  assertLiveConfirmation(opts);

  let orderId = null;
  let canceled = false;
  let visibleInApi = false;
  try {
    const order = {
        tokenID: opts.token,
        price: opts.price,
        side: opts.side === 'BUY' ? Side.BUY : Side.SELL,
        size: opts.quantity,
        metadata: metadataHex,
      };
    if (expiresAt != null) order.expiration = expiresAt;

    const response = await client.createAndPostOrder(
      order,
      {
        tickSize: finalAnalysis.tickSizeText,
        negRisk: finalAnalysis.negRisk,
        version: 2,
      },
      opts.keepOpen ? OrderType.GTC : OrderType.GTD,
      true,
      false,
    );

    orderId = response?.orderID ?? null;
    if (!response?.success || !orderId) {
      throw new Error(response?.errorMsg || 'CLOB rejeitou a ordem de teste.');
    }
    if (String(response.status).toLowerCase() !== 'live') {
      throw new Error(`Status inesperado para post-only: ${response.status ?? 'ausente'}.`);
    }

    if (!opts.json) {
      console.log(`Order ID:     ${orderId}`);
      console.log('Abra agora:   https://polymarket.com/portfolio?tab=open');
    }
    visibleInApi = await waitForUiVerification(client, orderId, opts.verifySeconds, opts.json);
    if (!visibleInApi) {
      throw new Error('A ordem não apareceu em getOpenOrders durante a janela de verificação.');
    }
  } finally {
    if (orderId && !opts.keepOpen) {
      const cancelResponse = await client.cancelOrder({ orderID: orderId });
      canceled = wasCanceled(cancelResponse, orderId);
      if (!canceled) {
        throw new Error(`Falha ao confirmar cancelamento automático da ordem ${orderId}.`);
      }
    }
  }

  const result = {
    ...summary,
    orderId,
    visibleInApi,
    canceled,
    leftOpen: opts.keepOpen,
    result: opts.keepOpen ? 'LIVE_TEST_VISIBLE_AND_LEFT_OPEN' : 'LIVE_TEST_VISIBLE_AND_CANCELED',
  };
  if (opts.json) console.log(JSON.stringify({ phase: 'RESULT', ...result }, null, 2));
  else if (opts.keepOpen) console.log('Resultado: ordem visível na API e mantida aberta para conferência visual.');
  else console.log('Resultado: ordem visível na API e cancelada automaticamente.');
  return result;
}

const isDirect = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirect) {
  main().catch((err) => {
    console.error(`[test:order] ${err.message}`);
    process.exitCode = 1;
  });
}
