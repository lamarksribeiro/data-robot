/**
 * Configuração HTTP do processo — importar como primeiro side-effect nos entrypoints.
 * Com GIOVANNA_SOCKS: roteia fetch + axios pelo túnel SOCKS.
 * Sem proxy: habilita keep-alive no axios (CLOB SDK).
 */
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { applySocksExit, isSocksExitActive } from './applySocksExit.js';

const socksUrl = String(process.env.GIOVANNA_SOCKS ?? '').trim();

if (socksUrl) {
  applySocksExit(socksUrl);
} else if (!isSocksExitActive()) {
  const keepAlive = { keepAlive: true, maxSockets: 32 };
  axios.defaults.httpAgent = new http.Agent(keepAlive);
  axios.defaults.httpsAgent = new https.Agent(keepAlive);
}
