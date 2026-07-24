import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import axios from 'axios';
import {
  applySocksExit,
  DEFAULT_SOCKS_FETCH_TIMEOUT_MS,
  isSocksExitActive,
} from '../src/net/applySocksExit.js';

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

describe('applySocksExit', () => {
  it('propaga AbortSignal do chamador', async () => {
    const prevHttp = axios.defaults.httpAgent;
    const prevHttps = axios.defaults.httpsAgent;
    try {
      applySocksExit('socks5h://127.0.0.1:9', { fetchTimeoutMs: 30_000 });
      assert.equal(isSocksExitActive(), true);

      const controller = new AbortController();
      const pending = fetch('http://127.0.0.1:9/', { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, (err) => err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED');
    } finally {
      axios.defaults.httpAgent = prevHttp;
      axios.defaults.httpsAgent = prevHttps;
      globalThis.fetch = originalFetch;
    }
  });

  it('usa timeout padrão reduzido sem signal do chamador', () => {
    assert.equal(DEFAULT_SOCKS_FETCH_TIMEOUT_MS, 10_000);
  });
});
