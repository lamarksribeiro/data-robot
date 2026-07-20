#!/usr/bin/env node
/**
 * Latência do app LOCAL com exit HTTP pelo IP do Giovanna (SSH SOCKS).
 *
 * Não é spoof de pacote IP (TCP/HTTPS não permite). O tráfego sai pelo seu
 * servidor Hetzner FI via: ssh -D 1080 -N Giovanna
 *
 * Pré-requisito (outro terminal):
 *   ssh -o ExitOnForwardFailure=yes -D 1080 -N Giovanna
 *
 * Uso:
 *   npm run tfc:latency:giovanna-exit -- --live --repeat=3
 *   GIOVANNA_SOCKS=socks5h://127.0.0.1:1080 npm run tfc:latency:giovanna-exit -- --live
 */

import { applySocksExit, probeExitIdentity } from '../../src/net/applySocksExit.js';

const socks = process.env.GIOVANNA_SOCKS || 'socks5h://127.0.0.1:1080';

applySocksExit(socks);

const geo = await probeExitIdentity(socks);
console.log(`[giovanna-exit] socks=${socks}`);
console.log(`[giovanna-exit] geoblock=${JSON.stringify(geo)}`);

if (geo?.blocked === true) {
  console.error('[giovanna-exit] Exit ainda geobloqueado — aborte.');
  process.exit(1);
}
if (geo?.country && geo.country !== 'FI') {
  console.warn(`[giovanna-exit] Aviso: country=${geo.country} (esperado FI)`);
}

// Injeta label/note padrão se ausentes
if (!process.argv.includes('--label') && !process.argv.some((a) => a.startsWith('--label='))) {
  process.argv.push('--label', 'local-via-giovanna');
}
if (!process.argv.includes('--note') && !process.argv.some((a) => a.startsWith('--note='))) {
  process.argv.push('--note', 'PC local + SSH SOCKS exit Giovanna FI (sem Kaspersky VPN)');
}

const { main } = await import('./measure-order-latency.js');
try {
  await main();
} catch (err) {
  console.error(`[giovanna-exit] ${err.message}`);
  process.exit(1);
}
