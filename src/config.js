import 'dotenv/config';

export default {
  port: parseInt(process.env.PORT || '3200', 10),
  host: process.env.HOST || '0.0.0.0',

  polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
  polymarketApiKey: process.env.POLYMARKET_API_KEY || '',
  polymarketApiSecret: process.env.POLYMARKET_API_SECRET || '',
  polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
  polymarketSignatureType: process.env.POLYMARKET_SIGNATURE_TYPE || '',
  polymarketFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || '',

  clobHttpUrl: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137', 10),

  gammaBase: 'https://gamma-api.polymarket.com',
  dataApiBase: 'https://data-api.polymarket.com',

  deriveNonceMax: parseInt(process.env.POLYMARKET_DERIVE_NONCE_MAX || '50', 10),
};
