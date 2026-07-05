import { ClobClient } from '@polymarket/clob-client-v2';
import config from '../config.js';
import { resolveSignatureType } from './signatureType.js';
import { createSigner } from './wallet.js';

export function buildClobClient(options = {}) {
  const wallet = options.wallet ?? createSigner(config.polymarketPrivateKey);
  const signatureType = options.signatureType ?? resolveSignatureType(config.polymarketSignatureType);
  const funderRaw = options.funderAddress ?? config.polymarketFunderAddress ?? '';
  const funderAddress = String(funderRaw).trim() || undefined;

  const creds = options.creds ?? (
    config.polymarketApiKey && config.polymarketApiSecret && config.polymarketApiPassphrase
      ? {
          key: config.polymarketApiKey,
          secret: config.polymarketApiSecret,
          passphrase: config.polymarketApiPassphrase,
        }
      : undefined
  );

  return new ClobClient({
    host: options.host ?? config.clobHttpUrl,
    chain: options.chainId ?? config.chainId,
    signer: wallet,
    creds,
    signatureType,
    funderAddress,
    useServerTime: true,
    throwOnError: options.throwOnError ?? false,
  });
}

export async function deriveApiCredentials(wallet, nonce = 0) {
  const client = new ClobClient({
    host: config.clobHttpUrl,
    chain: config.chainId,
    signer: wallet,
    useServerTime: true,
    throwOnError: true,
  });
  return client.deriveApiKey(nonce);
}
