import { Wallet } from 'ethers';

export function createSigner(privateKey) {
  if (!privateKey) {
    throw new Error('POLYMARKET_PRIVATE_KEY não configurada.');
  }

  let wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    throw new Error('POLYMARKET_PRIVATE_KEY inválida — verifique o formato (0x...).');
  }

  wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);
  return wallet;
}
