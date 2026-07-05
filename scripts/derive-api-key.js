/**
 * Deriva as credenciais L2 da API Polymarket CLOB a partir da chave privada.
 *
 * Uso:
 *   POLYMARKET_PRIVATE_KEY=0x... node scripts/derive-api-key.js
 *   node scripts/derive-api-key.js --write-env --create
 *
 * Saída: KEY, SECRET e PASSPHRASE para adicionar ao .env
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Wallet } from 'ethers';
import { ClobClient, createL1Headers } from '@polymarket/clob-client-v2';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon Mainnet

const args = process.argv.slice(2);
const shouldWriteEnv = args.includes('--write-env') || args.includes('--write');
const deriveOnly = args.includes('--derive-only');
const noPrintSecrets = shouldWriteEnv || args.includes('--no-print') || args.includes('--safe');

function getArgValue(name) {
  const exact = args.indexOf(name);
  if (exact !== -1) return args[exact + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const targetKey = getArgValue('--target-key');
const shouldCreate = !deriveOnly && (args.includes('--create') || !targetKey);
const skipDerive = args.includes('--skip-derive');
const nonceMax = parseInt(getArgValue('--nonce-max') || process.env.POLYMARKET_DERIVE_NONCE_MAX || '50', 10);
const createNonce = parseInt(getArgValue('--create-nonce') || process.env.POLYMARKET_CREATE_NONCE || '0', 10);
const createNonceMax = parseInt(getArgValue('--create-nonce-max') || process.env.POLYMARKET_CREATE_NONCE_MAX || String(createNonce), 10);
const requireNewKey = args.includes('--require-new-key');
const currentApiKey = process.env.POLYMARKET_API_KEY || '';

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error('❌ Defina POLYMARKET_PRIVATE_KEY no .env ou como variável de ambiente.');
  process.exit(1);
}

let wallet;
try {
  wallet = new Wallet(privateKey);
} catch {
  console.error('❌ POLYMARKET_PRIVATE_KEY inválida.');
  process.exit(1);
}

// Adapter: ethers v6 usa signTypedData(); clob-client-v2 espera _signTypedData() (ethers v5 compat)
wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);

console.log(`\n🔑 Carteira: ${wallet.address}`);
console.log('⏳ Derivando credenciais L2 (requer conexão com a API Polymarket)...');

const client = new ClobClient({
  host: CLOB_HOST,
  chain: CHAIN_ID,
  signer: wallet,
  useServerTime: true,
  throwOnError: true,
});

async function getClobServerTimestamp() {
  const res = await fetch(`${CLOB_HOST}/time`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://polymarket.com',
      Referer: 'https://polymarket.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const timestamp = typeof data === 'number'
    ? data
    : Number(data?.epoch ?? data?.timestamp ?? data?.time ?? data?.serverTime);

  if (!res.ok || !Number.isFinite(timestamp)) {
    throw new Error(`Falha ao obter /time da Polymarket: HTTP ${res.status}`);
  }

  return Math.floor(timestamp);
}

function mask(value) {
  if (!value) return '(vazio)';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function getErrorText(err) {
  if (!err) return 'erro desconhecido';
  if (typeof err === 'string') return err;
  if (err.error) return String(err.error);
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function summarizeError(err) {
  const text = getErrorText(err);
  if (/Cloudflare|cf-error|Sorry, you have been blocked/i.test(text)) {
    const ray = text.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<\s]+)/i)
      || text.match(/Cloudflare Ray ID:\s*([a-f0-9]+)/i)
      || text.match(/Ray ID:\s*([a-f0-9]+)/i);
    return `Cloudflare bloqueou a requisição${ray ? ` (Ray ID: ${ray[1]})` : ''}`;
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function isCloudflareBlock(err) {
  return /Cloudflare bloqueou|Cloudflare|cf-error|Sorry, you have been blocked/i.test(getErrorText(err));
}

function assertCreds(creds, label) {
  if (!creds || typeof creds !== 'object') {
    throw new Error(`${label}: resposta inválida da API.`);
  }
  if (creds.error) {
    const detail = summarizeError(creds.error);
    throw new Error(`${label}: ${detail}`);
  }
  if (!creds.key || !creds.secret || !creds.passphrase) {
    throw new Error(`${label}: credenciais incompletas (key/secret/passphrase ausentes).`);
  }
}

function updateEnvFile(creds) {
  const envPath = path.resolve(process.cwd(), '.env');
  const updates = {
    POLYMARKET_API_KEY: creds.key,
    POLYMARKET_API_SECRET: creds.secret,
    POLYMARKET_API_PASSPHRASE: creds.passphrase,
  };

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      const separator = content && !content.endsWith('\n') ? '\n' : '';
      content = `${content}${separator}${line}\n`;
    }
  }

  fs.writeFileSync(envPath, content);
  console.log(`✅ .env atualizado em ${envPath}`);
}

function printCreds(creds) {
  console.log('✅ Credenciais derivadas com sucesso!\n');
  if (shouldWriteEnv) {
    updateEnvFile(creds);
  }
  if (noPrintSecrets) {
    console.log('Credenciais:');
    console.log(`  POLYMARKET_API_KEY=${mask(creds.key)}`);
    console.log(`  POLYMARKET_API_SECRET=${mask(creds.secret)}`);
    console.log(`  POLYMARKET_API_PASSPHRASE=${mask(creds.passphrase)}`);
    return;
  }
  console.log('Adicione ao seu .env:');
  console.log('─────────────────────────────────────────');
  console.log(`POLYMARKET_API_KEY=${creds.key}`);
  console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
  console.log('─────────────────────────────────────────');
}

async function tryCall(label, call) {
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    return await call();
  } catch (err) {
    throw err;
  } finally {
    console.error = originalConsoleError;
  }
}

async function createApiKeyWithBrowserFetch(nonce = 0) {
  const serverTimestamp = await getClobServerTimestamp();
  const l1Headers = await createL1Headers(wallet, CHAIN_ID, nonce, serverTimestamp);
  const headers = Object.fromEntries(
    Object.entries(l1Headers).map(([key, value]) => [key, String(value)]),
  );

  const res = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://polymarket.com',
      Referer: 'https://polymarket.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${summarizeError(data?.error || text)}`);
  }

  const apiKeyRaw = data || {};
  return {
    key: apiKeyRaw.apiKey || apiKeyRaw.key,
    secret: apiKeyRaw.secret,
    passphrase: apiKeyRaw.passphrase,
  };
}

// Tenta derivar com nonces configuráveis para cobrir casos em que a chave foi criada com nonce > 0.
let lastError = null;
let success = false;

function shouldSkipCreds(creds) {
  if (targetKey && creds.key !== targetKey) {
    console.log(`    Chave encontrada (${mask(creds.key)}), mas não é a --target-key.`);
    return true;
  }
  if (requireNewKey && currentApiKey && creds.key === currentApiKey) {
    console.log(`    Chave encontrada (${mask(creds.key)}), mas é igual à chave atual; procurando/criando outra.`);
    return true;
  }
  return false;
}

if (!skipDerive) {
  for (let nonce = 0; nonce <= nonceMax; nonce++) {
    try {
      console.log(`  → Tentando nonce ${nonce}...`);
      const creds = await tryCall(`deriveApiKey(nonce=${nonce})`, () => client.deriveApiKey(nonce));
      assertCreds(creds, `deriveApiKey(nonce=${nonce})`);
      if (shouldSkipCreds(creds)) continue;
      printCreds(creds);
      success = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }
} else {
  console.log('  → Derivação de chaves existentes ignorada (--skip-derive).');
}

if (!success && shouldCreate) {
  console.log(`\n⚠️  Nenhuma chave existente encontrada nos nonces 0–${nonceMax}. Tentando criar nova chave...`);
  for (let nonce = createNonce; nonce <= createNonceMax; nonce++) {
    try {
      console.log(`  → Criando chave com nonce ${nonce}...`);
      const creds = await tryCall(`createApiKey(nonce=${nonce})`, () => client.createApiKey(nonce));
      assertCreds(creds, `createApiKey(nonce=${nonce})`);
      if (shouldSkipCreds(creds)) continue;
      printCreds(creds);
      success = true;
      break;
    } catch (err) {
      lastError = err;
      if (isCloudflareBlock(err)) {
        console.log(`  → ${summarizeError(err)}`);
        console.log('  → Tentando fallback com headers HTTP de navegador...');
        try {
          const creds = await createApiKeyWithBrowserFetch(nonce);
          assertCreds(creds, `createApiKey(fetch, nonce=${nonce})`);
          if (shouldSkipCreds(creds)) continue;
          printCreds(creds);
          success = true;
          break;
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      }
    }
  }
}

if (!success) {
  console.error(`\n❌ Falha ao derivar/criar credenciais: ${summarizeError(lastError)}`);
  console.error('');
  console.error('Causas possíveis:');
  console.error('  • A chave foi criada pelo painel e não é derivável pela carteira atual');
  console.error('  • Use --create para criar uma nova chave L2 via assinatura da carteira');
  console.error('  • Carteira não aceita os Termos de Uso da Polymarket (acesse polymarket.com)');
  console.error('  • Credenciais geradas via painel da Polymarket: copie-as direto para o .env sem derivar');
  process.exit(1);
}
