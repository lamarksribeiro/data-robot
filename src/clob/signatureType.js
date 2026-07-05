import { SignatureTypeV2 as SignatureType } from '@polymarket/clob-client-v2';

export function resolveSignatureType(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!value) return SignatureType.POLY_PROXY;
  if (value === '0' || value === 'EOA') return SignatureType.EOA;
  if (value === '1' || value === 'POLY_PROXY' || value === 'PROXY') return SignatureType.POLY_PROXY;
  if (value === '2' || value === 'POLY_GNOSIS_SAFE' || value === 'GNOSIS' || value === 'SAFE') {
    return SignatureType.POLY_GNOSIS_SAFE;
  }
  if (value === '3' || value === 'POLY_1271' || value === '1271' || value === 'DEPOSIT') {
    return SignatureType.POLY_1271;
  }
  throw new Error('POLYMARKET_SIGNATURE_TYPE inválido. Use 0/EOA, 1/POLY_PROXY, 2/POLY_GNOSIS_SAFE ou 3/POLY_1271.');
}

export function signatureTypeLabel(type) {
  if (type === SignatureType.EOA) return 'EOA';
  if (type === SignatureType.POLY_GNOSIS_SAFE) return 'POLY_GNOSIS_SAFE';
  if (type === SignatureType.POLY_1271) return 'POLY_1271';
  return 'POLY_PROXY';
}
