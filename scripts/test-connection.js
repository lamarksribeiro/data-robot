#!/usr/bin/env node
/**
 * test-connection.js — smoke test CLOB + perfil Gamma (sem enviar ordens).
 *
 * Uso:
 *   npm run test:connection
 *   npm run test:connection -- --json
 */

import 'dotenv/config';
import { AssetType } from '@polymarket/clob-client-v2';
import config from '../src/config.js';
import { buildClobClient } from '../src/clob/buildClient.js';
import { resolveSignatureType, signatureTypeLabel } from '../src/clob/signatureType.js';
import { createSigner } from '../src/clob/wallet.js';

const json = process.argv.includes('--json');

async function main() {
  const wallet = createSigner(config.polymarketPrivateKey);
  const signatureType = resolveSignatureType(config.polymarketSignatureType);
  const client = buildClobClient({ wallet });

  const timeRes = await fetch(`${config.clobHttpUrl}/time`);
  const serverTime = await timeRes.json();

  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balancePusd = parseFloat(bal?.balance ?? '0') / 1e6;

  const open = await client.getOpenOrders();

  let gamma = null;
  const funder = config.polymarketFunderAddress.trim();
  if (funder) {
    const res = await fetch(`${config.gammaBase}/public-profile?address=${funder}`);
    if (res.ok) gamma = await res.json();
  }

  const result = {
    ok: true,
    testedAt: new Date().toISOString(),
    signer: wallet.address,
    funder: funder || wallet.address,
    signatureType: signatureTypeLabel(signatureType),
    apiKeyPrefix: config.polymarketApiKey?.slice(0, 8) ?? null,
    clobServerTime: serverTime,
    balancePusd,
    openOrdersCount: open.length,
    gammaProxyWallet: gamma?.proxyWallet ?? null,
    gammaName: gamma?.name ?? null,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== data-robot connection test ===');
    console.log(`Signer:     ${result.signer}`);
    console.log(`Funder:     ${result.funder}`);
    console.log(`Sig type:   ${result.signatureType}`);
    console.log(`API key:    ${result.apiKeyPrefix}...`);
    console.log(`pUSD:       $${result.balancePusd.toFixed(4)}`);
    console.log(`Open ord:   ${result.openOrdersCount}`);
    console.log(`Gamma:      ${result.gammaName ?? '—'} (${result.gammaProxyWallet ?? '—'})`);
    console.log('✅ CLOB autenticado');
  }
}

main().catch((err) => {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  } else {
    console.error(`❌ ${err.message}`);
  }
  process.exit(1);
});
