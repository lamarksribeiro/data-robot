#!/usr/bin/env node
/**
 * check-api-key-alignment.js
 *
 * Valida se o .env está alinhado com a API key que o site Polymarket usa.
 * Evita ordens "fantasma": aceitas no CLOB mas invisíveis na aba Open do Portfolio.
 *
 * Uso:
 *   npm run check:api-key
 *   npm run check:api-key -- --json
 *   npm run check:api-key -- --browser-storage ../polymarket-web-api/storage/polymarket-storage-state.json
 */

import 'dotenv/config';
import { AssetType } from '@polymarket/clob-client-v2';
import config from '../src/config.js';
import { readBrowserClobKeyMap } from '../src/clob/browserKeyMap.js';
import { buildClobClient, deriveApiCredentials } from '../src/clob/buildClient.js';
import { resolveSignatureType, signatureTypeLabel } from '../src/clob/signatureType.js';
import { createSigner } from '../src/clob/wallet.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  function valueOf(flag) {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return null;
  }
  return {
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
    browserStorage: valueOf('--browser-storage'),
  };
}

function maskKey(key) {
  if (!key) return '(vazio)';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function prefix(key) {
  return key ? key.slice(0, 8) : null;
}

async function fetchGammaProfile(address) {
  const url = `${config.gammaBase}/public-profile?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  return { ok: true, proxyWallet: data?.proxyWallet?.toLowerCase() ?? null, name: data?.name ?? null };
}

async function isContract(address) {
  const res = await fetch('https://polygon-rpc.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  });
  const data = await res.json();
  const code = data?.result || '0x';
  return code !== '0x' && code.length > 4;
}

function printHelp() {
  console.log(`GoldenLens data-robot — check API key alignment

Uso:
  node scripts/check-api-key-alignment.js [opções]

Opções:
  --json                         Saída JSON
  --browser-storage <arquivo>    Comparar com poly_clob_api_key_map do navegador
  --help                         Esta ajuda

Exit codes:
  0  Tudo alinhado
  1  Problema de configuração ou API key divergente
  2  Erro fatal (chave privada ausente, etc.)

Correção recomendada quando divergir:
  npm run derive-key -- --write-env --safe --derive-only

Documentação: docs/polymarket-ordens-abertas-ui-vs-api.md
`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    signerAddress: null,
    funderAddress: config.polymarketFunderAddress.trim() || null,
    signatureType: null,
    envApiKeyPrefix: prefix(config.polymarketApiKey),
    derivedApiKeyPrefix: null,
    browserApiKeyPrefix: null,
    apiKeyAlignedWithDerived: null,
    apiKeyAlignedWithBrowser: null,
    funderMatchesGammaProxy: null,
    funderIsContract: null,
    balancePusd: null,
    openOrdersCount: null,
    l2AuthOk: null,
    issues: [],
    recommendations: [],
  };

  if (!config.polymarketPrivateKey) {
    report.issues.push('POLYMARKET_PRIVATE_KEY ausente no .env');
    report.recommendations.push('Copie .env.example para .env e preencha a chave privada.');
    output(report, options.json);
    process.exit(2);
  }

  let wallet;
  let signatureType;
  try {
    wallet = createSigner(config.polymarketPrivateKey);
    signatureType = resolveSignatureType(config.polymarketSignatureType);
    report.signerAddress = wallet.address;
    report.signatureType = signatureTypeLabel(signatureType);
  } catch (err) {
    report.issues.push(err.message);
    output(report, options.json);
    process.exit(2);
  }

  if (!config.polymarketApiKey || !config.polymarketApiSecret || !config.polymarketApiPassphrase) {
    report.issues.push('Credenciais L2 incompletas no .env');
    report.recommendations.push('npm run derive-key -- --write-env --safe --derive-only');
  }

  if (!report.funderAddress && signatureType !== 0) {
    report.issues.push('POLYMARKET_FUNDER_ADDRESS ausente com signatureType proxy/safe/1271');
    report.recommendations.push('Defina o proxyWallet do perfil (polymarket.com/settings).');
  }

  try {
    const derived = await deriveApiCredentials(wallet, 0);
    report.derivedApiKeyPrefix = prefix(derived.key);
    report.apiKeyAlignedWithDerived = config.polymarketApiKey === derived.key;

    if (!report.apiKeyAlignedWithDerived) {
      report.issues.push(
        `API key do .env (${maskKey(config.polymarketApiKey)}) ≠ derivada nonce 0 (${maskKey(derived.key)}). `
        + 'Ordens podem não aparecer na UI do site.',
      );
      report.recommendations.push('npm run derive-key -- --write-env --safe --derive-only');
    }
  } catch (err) {
    report.issues.push(`Falha ao derivar API key: ${err.message}`);
  }

  if (options.browserStorage) {
    const browser = readBrowserClobKeyMap(options.browserStorage);
    report.browserStorage = { path: options.browserStorage, ...browser };
    if (browser.ok && browser.entries?.length) {
      const entry = browser.entries.find(
        (e) => !report.funderAddress || e.proxyWallet.toLowerCase() === report.funderAddress.toLowerCase(),
      ) ?? browser.entries[0];
      report.browserApiKeyPrefix = entry.apiKeyPrefix;
      report.apiKeyAlignedWithBrowser = config.polymarketApiKey === entry.apiKey;
      if (!report.apiKeyAlignedWithBrowser) {
        report.issues.push(
          `API key do .env (${maskKey(config.polymarketApiKey)}) ≠ navegador (${entry.apiKeyPrefix}...).`,
        );
        report.recommendations.push('npm run derive-key -- --write-env --safe --derive-only');
      }
    } else if (!browser.ok) {
      report.issues.push(`Browser storage: ${browser.error}`);
    }
  }

  if (report.funderAddress) {
    const profile = await fetchGammaProfile(report.funderAddress);
    if (profile.ok) {
      report.funderMatchesGammaProxy = profile.proxyWallet === report.funderAddress.toLowerCase();
      report.gammaProfileName = profile.name;
      if (!report.funderMatchesGammaProxy) {
        report.issues.push(
          `Funder ${report.funderAddress} ≠ proxyWallet Gamma (${profile.proxyWallet}).`,
        );
      }
    }
    try {
      report.funderIsContract = await isContract(report.funderAddress);
      if (report.funderIsContract && signatureType === 1) {
        report.issues.push(
          'Funder é contrato (deposit wallet?) mas signatureType=POLY_PROXY — considere POLY_1271 (3).',
        );
      }
    } catch {
      // RPC opcional
    }
  }

  if (config.polymarketApiKey) {
    try {
      const client = buildClobClient({ wallet, throwOnError: false });
      const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const raw = parseFloat(bal?.balance ?? '0');
      report.balancePusd = Number.isFinite(raw) ? raw / 1e6 : null;
      report.l2AuthOk = true;

      const open = await client.getOpenOrders();
      report.openOrdersCount = Array.isArray(open) ? open.length : 0;
    } catch (err) {
      report.l2AuthOk = false;
      report.issues.push(`L2/CLOB: ${err.message}`);
    }
  }

  report.ok = report.issues.length === 0;
  if (report.ok) {
    report.summary = 'Configuração alinhada — ordens via API devem aparecer na aba Open do site.';
  } else {
    report.summary = `${report.issues.length} problema(s) encontrado(s).`;
  }

  output(report, options.json);
  process.exit(report.ok ? 0 : 1);
}

function output(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== GoldenLens data-robot — API key alignment ===\n');
  console.log(`Signer:          ${report.signerAddress ?? '—'}`);
  console.log(`Funder:          ${report.funderAddress ?? '—'}`);
  console.log(`Signature type:  ${report.signatureType ?? '—'}`);
  console.log(`API key .env:    ${maskKey(config.polymarketApiKey)}`);
  console.log(`API key derivada:${report.derivedApiKeyPrefix ? `${report.derivedApiKeyPrefix}...` : '—'}`);
  if (report.browserApiKeyPrefix) {
    console.log(`API key browser: ${report.browserApiKeyPrefix}...`);
  }
  console.log(`Saldo pUSD:      ${report.balancePusd != null ? `$${report.balancePusd.toFixed(2)}` : '—'}`);
  console.log(`Open orders:     ${report.openOrdersCount ?? '—'}`);
  console.log('');

  if (report.ok) {
    console.log('✅', report.summary);
  } else {
    console.log('❌', report.summary);
    console.log('\nProblemas:');
    for (const issue of report.issues) console.log(`  • ${issue}`);
    if (report.recommendations.length) {
      console.log('\nRecomendações:');
      for (const rec of [...new Set(report.recommendations)]) console.log(`  → ${rec}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(`[check-api-key] fatal: ${err.message}`);
  process.exit(2);
});
