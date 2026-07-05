import fs from 'node:fs';

/**
 * Lê poly_clob_api_key_map exportado do navegador (polymarket-web-api storage state
 * ou dump manual do DevTools → Application → Local Storage).
 */
export function readBrowserClobKeyMap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'arquivo não encontrado', filePath };
  }

  const raw = fs.readFileSync(filePath, 'utf8');

  let map = null;
  let source = 'unknown';

  if (filePath.endsWith('.json')) {
    try {
      const data = JSON.parse(raw);
      if (data?.origins) {
        for (const origin of data.origins) {
          const entry = origin.localStorage?.find((item) => item.name === 'poly_clob_api_key_map');
          if (entry?.value) {
            map = JSON.parse(entry.value);
            source = 'playwright-storage-state';
            break;
          }
        }
      }
      if (!map && data?.poly_clob_api_key_map) {
        map = data.poly_clob_api_key_map;
        source = 'json-export';
      }
      if (!map && typeof data === 'object') {
        const text = JSON.stringify(data);
        const match = text.match(/poly_clob_api_key_map[^"]*"(\{[^"]+\})"/);
        if (match) {
          map = JSON.parse(match[1].replace(/\\"/g, '"'));
          source = 'embedded-json';
        }
      }
    } catch (err) {
      return { ok: false, error: `JSON inválido: ${err.message}`, filePath };
    }
  }

  if (!map) {
    return { ok: false, error: 'poly_clob_api_key_map não encontrado no arquivo', filePath };
  }

  const wallets = Object.keys(map);
  const entries = wallets.map((proxyWallet) => {
    const row = map[proxyWallet];
    return {
      proxyWallet,
      apiKeyPrefix: row?.key?.slice(0, 8) ?? null,
      apiKey: row?.key ?? null,
      baseAddress: row?.baseAddress ?? null,
    };
  });

  return { ok: true, source, filePath, entries };
}
