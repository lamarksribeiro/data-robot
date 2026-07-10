#!/usr/bin/env node
/**
 * Compara taxa real maker vs taker em BTC 5m (centavos).
 *
 * Hipótese Hopper 3 / Polymarket:
 *   - maker (limit resting, postOnly) → fee $0
 *   - taker (ordem que cruza o book) → fee ≈ shares * 0.07 * p * (1-p)
 *
 * Uso (dry-run por padrão — não envia ordem):
 *   npm run test:fee -- --mode=taker
 *   npm run test:fee -- --mode=maker
 *   npm run test:fee -- --mode=both
 *
 * Live (dinheiro real, valores pequenos):
 *   npm run test:fee -- --mode=taker --live --size=5
 *   npm run test:fee -- --mode=maker --live --size=5 --wait=120
 *
 * Depois de fills, o script consulta getTrades() e reporta trader_side + fee esperada.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { OrderType, Side, AssetType } from '@polymarket/clob-client-v2';
import { buildClobClient } from '../../src/clob/buildClient.js';
import { createSigner } from '../../src/clob/wallet.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';
import {
  CRYPTO_TAKER_FEE_RATE,
  calculateTakerFee,
  summarizeTradeFees,
} from '../../src/fees/polymarketFee.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const mode = (valueOf('--mode') ?? 'both').toLowerCase();
  return {
    mode: ['maker', 'taker', 'both'].includes(mode) ? mode : 'both',
    live: args.includes('--live'),
    json: args.includes('--json'),
    size: Math.max(1, parseInt(valueOf('--size') ?? '5', 10)),
    waitSec: Math.max(5, parseInt(valueOf('--wait') ?? '90', 10)),
    pollMs: Math.max(500, parseInt(valueOf('--poll') ?? '2000', 10)),
    side: (valueOf('--side') ?? 'UP').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP',
    outDir: valueOf('--out') ?? 'runs',
    cancelUnfilled: !args.includes('--keep-open'),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getBalancePusd(client) {
  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseFloat(bal?.balance ?? '0') / 1e6;
}

function parseLevels(levels) {
  return (levels ?? [])
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0);
}

async function getBestPrices(client, tokenId) {
  const book = await client.getOrderBook(tokenId);
  const tick = parseFloat(book?.tick_size ?? '0.01') || 0.01;
  // CLOB pode devolver níveis fora de ordem — sempre reordenar.
  const bids = parseLevels(book?.bids).sort((a, b) => b.price - a.price);
  const asks = parseLevels(book?.asks).sort((a, b) => a.price - b.price);
  return {
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bidSize: bids[0]?.size ?? null,
    askSize: asks[0]?.size ?? null,
    tick,
    minOrderSize: parseFloat(book?.min_order_size ?? '0') || 0,
  };
}

async function waitForFill(client, orderId, { waitSec, pollMs }) {
  const deadline = Date.now() + waitSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.getOrder(orderId);
    const matched = parseFloat(last?.size_matched ?? '0');
    const original = parseFloat(last?.original_size ?? '0');
    const status = String(last?.status ?? '').toLowerCase();
    if (matched > 0 || status.includes('matched') || status === 'filled') {
      return { filled: true, order: last, matched, original };
    }
    if (['canceled', 'cancelled', 'expired'].includes(status)) {
      return { filled: false, order: last, matched, original };
    }
    await sleep(pollMs);
  }
  return { filled: false, order: last, matched: parseFloat(last?.size_matched ?? '0'), original: parseFloat(last?.original_size ?? '0') };
}

async function findRelatedTrades(client, { orderId, tokenId, afterSec = 300 }) {
  const after = Math.floor(Date.now() / 1000) - afterSec;
  const trades = await client.getTrades({ asset_id: tokenId, after: String(after) });
  const related = (trades ?? []).filter((t) => {
    if (t.taker_order_id === orderId) return true;
    if ((t.maker_orders ?? []).some((m) => m.order_id === orderId)) return true;
    return false;
  });
  return related.length ? related : (trades ?? []).slice(0, 5);
}

function buildPlan({ mode, prices, size, feeRateBps }) {
  const feeRate = Number.isFinite(feeRateBps) ? feeRateBps / 10000 : CRYPTO_TAKER_FEE_RATE;

  const tick = prices.tick ?? 0.01;

  if (mode === 'taker') {
    const price = prices.bestAsk;
    if (price == null) throw new Error('Sem best ask para taker.');
    // Slippage de 1 tick acima do ask para forçar cruzamento (FOK market).
    const limitPrice = Math.min(0.99, Number((price + (prices.tick ?? 0.01)).toFixed(4)));
    const notional = size * limitPrice;
    const expectedFee = calculateTakerFee({ shares: size, price, feeRate });
    return {
      mode: 'taker',
      intent: 'cruzar o book (taker)',
      price: limitPrice,
      refAsk: price,
      size,
      amountUsd: Number((size * limitPrice).toFixed(4)),
      notionalUsd: Number(notional.toFixed(4)),
      postOnly: false,
      useMarketOrder: true,
      orderType: 'FOK market BUY (amount USDC)',
      expectedFeeUsd: expectedFee,
      feeRate,
      note: 'Market FOK compra USDC no ask — deve ser TAKER de verdade.',
    };
  }

  // Maker: no best bid, ou 1 tick abaixo do ask se não houver bid / book cruzado.
  let price = prices.bestBid;
  if (price == null && prices.bestAsk != null) {
    price = Math.max(tick, Number((prices.bestAsk - tick).toFixed(4)));
  }
  if (price != null && prices.bestAsk != null && price >= prices.bestAsk) {
    price = Math.max(tick, Number((prices.bestAsk - tick).toFixed(4)));
  }
  if (price == null) throw new Error('Sem preço maker (book vazio).');

  const notional = size * price;
  return {
    mode: 'maker',
    intent: 'descansar no book (maker)',
    price,
    size,
    notionalUsd: Number(notional.toFixed(4)),
    postOnly: true,
    orderType: 'GTC postOnly @ bid (ou ask-tick)',
    expectedFeeUsd: 0,
    feeRate,
    note: 'Ordem BUY resting com postOnly — só preenche se alguém vender em você (MAKER). Pode não fillar.',
  };
}

async function runLeg(client, { mode, event, tokenId, opts, log }) {
  const prices = await getBestPrices(client, tokenId);
  let feeRateBps = null;
  try {
    feeRateBps = await client.getFeeRateBps(tokenId);
  } catch {
    feeRateBps = null;
  }

  const plan = buildPlan({ mode, prices, size: opts.size, feeRateBps });
  const balanceBefore = await getBalancePusd(client);

  log(`\n--- ${mode.toUpperCase()} ---`);
  log(`Book: bid=${prices.bestBid} ask=${prices.bestAsk}`);
  log(`Plano: ${plan.orderType} | ${plan.size} sh @ ${plan.price} ≈ $${plan.notionalUsd}`);
  log(`Fee esperada (${plan.mode}): $${plan.expectedFeeUsd.toFixed(5)} (rate=${plan.feeRate})`);
  log(`Saldo antes: $${balanceBefore.toFixed(4)}`);

  if (!opts.live) {
    return {
      dryRun: true,
      mode,
      event: event.title,
      tokenId,
      prices,
      feeRateBps,
      plan,
      balanceBefore,
      balanceAfter: balanceBefore,
      balanceDelta: 0,
      orderId: null,
      fill: null,
      tradesSummary: null,
    };
  }

  let resp;
  if (plan.useMarketOrder) {
    // amount = USDC a gastar (BUY market). Usa FOK para fill imediato ou nada.
    resp = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: plan.amountUsd,
        side: Side.BUY,
        price: plan.price,
      },
      undefined,
      OrderType.FOK,
      false,
    );
  } else {
    resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: plan.price, side: Side.BUY, size: plan.size },
      undefined,
      OrderType.GTC,
      plan.postOnly,
      false,
    );
  }

  const orderId = resp?.orderID;
  if (!resp?.success || !orderId) {
    throw new Error(resp?.errorMsg || `Falha ao criar ordem ${mode}`);
  }

  log(`Ordem enviada: ${orderId} status=${resp.status}`);
  log('Confira Portfolio → Open / evento no navegador.');

  let fill;
  if (plan.useMarketOrder) {
    // FOK: ou matched na resposta, ou falhou.
    const matched = parseFloat(resp?.takingAmount ?? resp?.makingAmount ?? '0') > 0
      || String(resp?.status ?? '').toLowerCase().includes('matched')
      || resp?.status === 'matched';
    // Poll curto para status final.
    fill = await waitForFill(client, orderId, { waitSec: Math.min(opts.waitSec, 20), pollMs: 1000 });
    if (!fill.filled && (resp?.status === 'matched' || matched)) {
      fill = { filled: true, order: fill.order, matched: plan.size, original: plan.size };
    }
    log(`FOK resp status=${resp.status} taking=${resp?.takingAmount} making=${resp?.makingAmount}`);
  } else {
    fill = await waitForFill(client, orderId, { waitSec: opts.waitSec, pollMs: opts.pollMs });
  }
  log(`Fill: matched=${fill.matched}/${fill.original} filled=${fill.filled} status=${fill.order?.status}`);

  if (!fill.filled && opts.cancelUnfilled && !plan.useMarketOrder) {
    try {
      await client.cancelOrder({ orderID: orderId });
      log('Ordem não preenchida — cancelada.');
    } catch (err) {
      log(`Cancel falhou: ${err.message}`);
    }
  }

  await sleep(1500);
  let trades = fill.filled
    ? await findRelatedTrades(client, { orderId, tokenId })
    : [];
  // Classifica nosso papel: se nossa ordem está em maker_orders → MAKER; se é taker_order_id → TAKER.
  trades = trades.map((t) => {
    const isTaker = t.taker_order_id === orderId;
    const isMaker = (t.maker_orders ?? []).some((m) => m.order_id === orderId);
    return {
      ...t,
      trader_side: isTaker ? 'TAKER' : isMaker ? 'MAKER' : t.trader_side,
      size: isMaker
        ? String((t.maker_orders ?? []).find((m) => m.order_id === orderId)?.matched_amount ?? t.size)
        : t.size,
    };
  });
  const tradesSummary = summarizeTradeFees(trades, {
    feeRate: plan.feeRate,
  });

  const balanceAfter = await getBalancePusd(client);
  const balanceDelta = Number((balanceAfter - balanceBefore).toFixed(6));

  log(`Saldo depois: $${balanceAfter.toFixed(4)} (Δ ${balanceDelta})`);
  if (tradesSummary.trades.length) {
    for (const t of tradesSummary.trades) {
      log(`Trade ${t.id?.slice?.(0, 10) ?? '?'} side=${t.traderSide} ${t.shares}@${t.price} feeEsp=$${t.expectedFeeUsd} bps=${t.feeRateBps}`);
    }
  } else if (fill.filled) {
    log('Nenhum trade relacionado encontrado ainda — rode de novo com --mode e confira getTrades.');
  }

  return {
    dryRun: false,
    mode,
    event: event.title,
    tokenId,
    prices,
    feeRateBps,
    plan,
    balanceBefore,
    balanceAfter,
    balanceDelta,
    orderId,
    fill: {
      filled: fill.filled,
      matched: fill.matched,
      original: fill.original,
      status: fill.order?.status ?? null,
      associateTrades: fill.order?.associate_trades ?? [],
    },
    tradesSummary,
    rawTrades: trades,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = opts.json ? () => {} : (...a) => console.log(...a);

  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });
  const event = await findActiveBtc5mEvent();
  if (!event) throw new Error('Nenhum evento BTC 5m ativo.');

  const tokenId = opts.side === 'DOWN' ? event.downTokenId : event.upTokenId;
  const modes = opts.mode === 'both' ? ['taker', 'maker'] : [opts.mode];

  log('=== Maker vs Taker fee test ===');
  log(`Evento: ${event.title}`);
  log(`Lado:   ${opts.side}`);
  log(`Modo:   ${opts.mode} | live=${opts.live} | size=${opts.size}`);
  log(`Modelo: fee = shares * ${CRYPTO_TAKER_FEE_RATE} * p * (1-p)  | maker = $0`);
  if (!opts.live) log('DRY-RUN — adicione --live para enviar ordens reais.');

  const legs = [];
  for (const mode of modes) {
    legs.push(await runLeg(client, { mode, event, tokenId, opts, log }));
    if (opts.live && modes.length > 1) await sleep(2000);
  }

  const report = {
    testedAt: new Date().toISOString(),
    hypothesis: {
      makerFeeUsd: 0,
      takerFormula: 'shares * feeRate * price * (1 - price)',
      cryptoFeeRate: CRYPTO_TAKER_FEE_RATE,
      source: 'data-backtest/src/backtest/fees.js + Polymarket docs (makers never charged)',
    },
    event: event.title,
    side: opts.side,
    live: opts.live,
    legs,
    verdict: buildVerdict(legs),
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const outFile = path.join(opts.outDir, `fee-${opts.mode}-${Date.now()}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  report.outFile = outFile;

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== veredito ===');
    console.log(report.verdict.summary);
    for (const line of report.verdict.details) console.log(`- ${line}`);
    console.log(`Salvo: ${outFile}`);
  }
}

function buildVerdict(legs) {
  const details = [];
  let summary = 'Dry-run / sem fills suficientes para concluir.';

  const taker = legs.find((l) => l.mode === 'taker' && !l.dryRun);
  const maker = legs.find((l) => l.mode === 'maker' && !l.dryRun);

  if (taker?.fill?.filled) {
    const side = taker.tradesSummary?.trades?.[0]?.traderSide;
    const fee = taker.tradesSummary?.expectedTakerFeeUsd ?? taker.plan.expectedFeeUsd;
    details.push(`TAKER fill: trader_side=${side ?? '?'} | fee esperada ≈ $${fee}`);
    if (side && side !== 'TAKER') details.push('ATENÇÃO: fill taker não veio como TAKER na API.');
  } else if (taker) {
    details.push('TAKER: sem fill (ou dry-run).');
  }

  if (maker?.fill?.filled) {
    const side = maker.tradesSummary?.trades?.[0]?.traderSide;
    details.push(`MAKER fill: trader_side=${side ?? '?'} | fee esperada = $0`);
    if (side === 'MAKER') {
      details.push('Maker confirmado pela API (trader_side=MAKER) → taxa de protocolo deve ser zero.');
    } else if (side === 'TAKER') {
      details.push('ATENÇÃO: ordem “maker” fillou como TAKER (provavelmente cruzou o book).');
    }
  } else if (maker) {
    details.push('MAKER: sem fill no tempo de espera (normal — precisa de alguém bater na sua bid).');
  }

  if (taker?.fill?.filled && maker?.fill?.filled) {
    const tFee = taker.tradesSummary?.expectedTakerFeeUsd ?? 0;
    const mSide = maker.tradesSummary?.trades?.[0]?.traderSide;
    if (mSide === 'MAKER' && tFee > 0) {
      summary = `Hipótese sustentada: taker paga ~$${tFee}, maker $0 (trader_side=MAKER).`;
    } else if (mSide === 'TAKER') {
      summary = 'Hipótese NÃO confirmada neste run: “maker” fillou como taker.';
    } else {
      summary = 'Ambos fillaram — confira trader_side e Δ saldo no JSON.';
    }
  } else if (taker?.fill?.filled && !maker?.fill?.filled) {
    summary = 'Taker fillou; maker ainda precisa de fill em outro momento/evento.';
  } else if (!taker?.fill?.filled && maker?.fill?.filled) {
    summary = 'Maker fillou; rode --mode=taker --live no mesmo ou próximo evento para comparar.';
  } else if (legs.every((l) => l.dryRun)) {
    summary = 'Dry-run OK — revise os planos e rode com --live quando quiser gastar centavos.';
  }

  return { summary, details };
}

main().catch((err) => {
  console.error(`[test:fee] ${err.message}`);
  process.exit(1);
});
