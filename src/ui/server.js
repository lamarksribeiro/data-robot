/** Servidor da UI: arquivos estáticos + proxy autenticado para a engine interna. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function readJson(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createUiServer(opts = {}) {
  const host = opts.host ?? '0.0.0.0';
  const port = Number(opts.port ?? 3200);
  const publicDir = path.resolve(opts.publicDir ?? 'public');
  const defaultEngineBaseUrl = String(opts.engineBaseUrl ?? 'http://127.0.0.1:3201').replace(/\/$/, '');
  const parseEngineRegistry = (registryStr) => {
    const raw = String(registryStr ?? '').trim();
    if (!raw) return [];
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const engines = [];
    for (const part of parts) {
      const [idRaw, labelRaw, baseUrlRaw] = part.split('|').map((s) => (s ?? '').trim());
      if (!idRaw || !baseUrlRaw) continue;
      const baseUrl = String(baseUrlRaw).replace(/\/$/, '');
      let baseUrlHost = null;
      try {
        baseUrlHost = new URL(baseUrl).host;
      } catch {
        baseUrlHost = null;
      }
      const label = labelRaw || idRaw;
      const asset = label;
      engines.push({ id: idRaw, label, asset, baseUrl, baseUrlHost });
    }
    return engines;
  };

  const enginesFromRegistry = parseEngineRegistry(opts.engineRegistry ?? process.env.ENGINE_REGISTRY);
  const engines =
    enginesFromRegistry.length > 0
      ? enginesFromRegistry
      : [{ id: 'btc', label: 'BTC', asset: 'BTC', baseUrl: defaultEngineBaseUrl, baseUrlHost: null }];

  const engineById = new Map(engines.map((e) => [String(e.id), e]));
  const defaultEngineId = String(opts.engineDefaultEngineId ?? process.env.ENGINE_DEFAULT_ENGINE ?? engines[0].id);
  if (!engineById.has(defaultEngineId)) {
    // fallback seguro quando env aponta para um id inexistente
    // (mantém o comportamento legado de 1 engine).
    engineById.set(defaultEngineId, engineById.get(engines[0].id));
  }

  function getEngine(engineId) {
    return engineById.get(String(engineId)) ?? engineById.get(defaultEngineId) ?? engines[0];
  }
  const sessionTtlMs = Number(opts.sessionTtlMs ?? 8 * 60 * 60 * 1000);
  const sessions = new Map();
  const loginAttempts = new Map();

  function credentialsConfigured() {
    return Boolean(opts.dashboardUser && opts.dashboardPassword);
  }

  function authenticated(req) {
    const token = cookieValue(req, 'dr_session');
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function requireSession(req, res) {
    if (authenticated(req)) return true;
    json(res, 401, { ok: false, reason: 'UNAUTHENTICATED' });
    return false;
  }

  async function proxyEngine(req, res, engineBaseUrl, enginePath, method = 'GET', body = null) {
    const headers = { accept: 'application/json' };
    let requestBody;
    // GETs operacionais da engine também exigem x-ops-token (status/audit/catalog/etc.).
    if (opts.engineOpsToken) {
      headers['x-ops-token'] = opts.engineOpsToken;
    } else if (method !== 'GET') {
      return json(res, 503, { ok: false, reason: 'ENGINE_OPS_TOKEN_NOT_CONFIGURED' });
    }
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify(body ?? {});
    }
    try {
      const response = await fetch(`${engineBaseUrl}${enginePath}`, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(Number(opts.engineTimeoutMs ?? 5000)),
      });
      const text = await response.text();
      res.writeHead(response.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(text || '{}');
    } catch (error) {
      return json(res, 502, { ok: false, reason: 'ENGINE_UNREACHABLE', detail: error.message });
    }
  }

  function serveStatic(res, pathname) {
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(publicDir, requested);
    if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) {
      json(res, 403, { ok: false, reason: 'FORBIDDEN' });
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      json(res, 404, { ok: false, reason: 'NOT_FOUND' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) {
          return json(res, 403, { ok: false, reason: 'CROSS_ORIGIN_REQUEST_BLOCKED' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        return json(res, 200, {
          ok: true,
          configured: credentialsConfigured(),
          authenticated: authenticated(req),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!credentialsConfigured()) {
          return json(res, 503, { ok: false, reason: 'DASHBOARD_CREDENTIALS_NOT_CONFIGURED' });
        }
        const remote = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const attempt = loginAttempts.get(remote);
        if (attempt && attempt.resetAt > now && attempt.count >= 5) {
          return json(res, 429, { ok: false, reason: 'LOGIN_RATE_LIMITED' });
        }
        if (attempt && attempt.resetAt <= now) loginAttempts.delete(remote);
        const body = await readJson(req);
        if (
          !safeEqual(body.username, opts.dashboardUser) ||
          !safeEqual(body.password, opts.dashboardPassword)
        ) {
          const current = loginAttempts.get(remote) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
          loginAttempts.set(remote, { ...current, count: current.count + 1 });
          return json(res, 401, { ok: false, reason: 'INVALID_CREDENTIALS' });
        }
        loginAttempts.delete(remote);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, Date.now() + sessionTtlMs);
        const secure = opts.secureCookie === false ? '' : '; Secure';
        return json(
          res,
          200,
          { ok: true },
          {
            'Set-Cookie': `dr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`,
          },
        );
      }
      if (req.method === 'DELETE' && url.pathname === '/api/session') {
        const token = cookieValue(req, 'dr_session');
        if (token) sessions.delete(token);
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'dr_session=; Path=/; Max-Age=0' });
      }

      const defaultEngineBaseUrlForProxy = getEngine(defaultEngineId).baseUrl;

      const engineReadSuffixToPath = new Map([
        ['health', '/health'],
        ['status', '/status'],
        ['metrics', '/metrics'],
        ['catalog', '/catalog'],
        ['instances', '/instances'],
        ['strategy-library', '/strategy-library'],
        ['strategy-active', '/strategy-active'],
        ['wallet', '/wallet'],
        ['settings', '/settings'],
      ]);

      const engineControlActionToSpec = new Map([
        ['arm', { path: '/control/arm', confirmation: 'ARM' }],
        ['pause', { path: '/control/pause', confirmation: 'PAUSE' }],
        ['stop', { path: '/control/stop', confirmation: 'STOP' }],
        ['disarm', { path: '/control/disarm', confirmation: 'STOP' }],
        ['reconcile', { path: '/control/reconcile', confirmation: 'RECONCILE' }],
        ['cancel-all', { path: '/control/cancel-all', confirmation: 'CANCEL' }],
        ['checkpoint', { path: '/control/checkpoint', confirmation: 'CHECKPOINT' }],
        ['rollback', { path: '/control/rollback', confirmation: 'ROLLBACK' }],
        ['flatten', { path: '/control/flatten', confirmation: 'FLATTEN' }],
        ['kill', { path: '/control/kill', confirmation: 'HALT' }],
      ]);

      if (req.method === 'GET' && url.pathname === '/api/engines') {
        if (!requireSession(req, res)) return;
        const timeoutMs = Number(opts.engineTimeoutMs ?? 3000);
        const headers = { accept: 'application/json' };
        if (opts.engineOpsToken) headers['x-ops-token'] = opts.engineOpsToken;

        const list = await Promise.all(
          engines.map(async (engine) => {
            const baseUrl = engine.baseUrl;
            let reachable = false;
            let lastError = null;
            let health = null;
            let status = null;
            try {
              const [h, s] = await Promise.all([
                fetch(`${baseUrl}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) })
                  .then((r) => r.json().catch(() => null))
                  .catch((e) => {
                    throw e;
                  }),
                fetch(`${baseUrl}/status`, { headers, signal: AbortSignal.timeout(timeoutMs) })
                  .then((r) => r.json().catch(() => null))
                  .catch((e) => {
                    throw e;
                  }),
              ]);
              reachable = h != null || s != null;
              health = h;
              status = s;
            } catch (error) {
              lastError = error?.message ?? String(error);
            }
            return {
              id: engine.id,
              label: engine.label,
              asset: engine.asset,
              baseUrlHost: engine.baseUrlHost,
              reachable,
              lastError,
              health,
              status,
            };
          }),
        );

        return json(res, 200, { ok: true, engines: list });
      }

      // Proxy multi-engine: /api/engines/:engineId/<enginePath>
      if (url.pathname.startsWith('/api/engines/')) {
        if (!requireSession(req, res)) return;

        const parts = url.pathname.split('/').filter(Boolean);
        const engineId = parts[2];
        const tail = parts.slice(3);

        if (!engineId || tail.length === 0) {
          return json(res, 404, { ok: false, reason: 'NOT_FOUND' });
        }

        const engine = getEngine(engineId);
        const engineBaseUrlForProxy = engine.baseUrl;

        if (req.method === 'GET') {
          const leaf = tail.join('/');
          if (tail.length === 1 && engineReadSuffixToPath.has(tail[0])) {
            return proxyEngine(req, res, engineBaseUrlForProxy, engineReadSuffixToPath.get(tail[0]));
          }
          if (tail.length === 1 && tail[0] === 'audit') {
            const qs = url.searchParams.toString();
            return proxyEngine(req, res, engineBaseUrlForProxy, qs ? `/audit?${qs}` : '/audit');
          }
          if (tail.length === 1 && tail[0] === 'trades') {
            const qs = url.searchParams.toString();
            return proxyEngine(req, res, engineBaseUrlForProxy, qs ? `/trades?${qs}` : '/trades');
          }
          return json(res, 404, { ok: false, reason: 'NOT_FOUND', detail: leaf });
        }

        if (req.method === 'PUT') {
          if (tail.length === 1 && tail[0] === 'settings') {
            const body = await readJson(req);
            return proxyEngine(req, res, engineBaseUrlForProxy, '/settings', 'PUT', body);
          }
          return json(res, 404, { ok: false, reason: 'NOT_FOUND', detail: tail.join('/') });
        }

        if (req.method === 'POST') {
          // POST /api/engines/:id/control/:action
          if (tail[0] === 'control' && tail.length === 2 && engineControlActionToSpec.has(tail[1])) {
            const action = engineControlActionToSpec.get(tail[1]);
            const body = await readJson(req);
            if (body.confirm !== action.confirmation) {
              return json(res, 400, {
                ok: false,
                reason: 'CONFIRMATION_REQUIRED',
                confirmation: action.confirmation,
              });
            }
            return proxyEngine(req, res, engineBaseUrlForProxy, action.path, 'POST', body);
          }
          // POST /api/engines/:id/strategy-library/presets
          if (tail[0] === 'strategy-library' && tail[1] === 'presets') {
            const body = await readJson(req);
            return proxyEngine(req, res, engineBaseUrlForProxy, '/strategy-library/presets', 'POST', body);
          }
          // POST /api/engines/:id/strategy-library/activate
          if (tail[0] === 'strategy-library' && tail[1] === 'activate') {
            const body = await readJson(req);
            return proxyEngine(req, res, engineBaseUrlForProxy, '/strategy-library/activate', 'POST', body);
          }
          return json(res, 404, { ok: false, reason: 'NOT_FOUND', detail: tail.join('/') });
        }
      }

      // Legado: mantém /api/engine/* como alias da engine default.
      const readRoutes = new Map([
        ['/api/engine/health', '/health'],
        ['/api/engine/status', '/status'],
        ['/api/engine/metrics', '/metrics'],
        ['/api/engine/catalog', '/catalog'],
        ['/api/engine/instances', '/instances'],
        ['/api/engine/strategy-library', '/strategy-library'],
        ['/api/engine/strategy-active', '/strategy-active'],
      ]);
      if (req.method === 'GET' && readRoutes.has(url.pathname)) {
        if (!requireSession(req, res)) return;
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, readRoutes.get(url.pathname));
      }
      if (req.method === 'GET' && url.pathname === '/api/engine/audit') {
        if (!requireSession(req, res)) return;
        const qs = url.searchParams.toString();
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, qs ? `/audit?${qs}` : '/audit');
      }
      if (req.method === 'GET' && url.pathname === '/api/engine/trades') {
        if (!requireSession(req, res)) return;
        const qs = url.searchParams.toString();
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, qs ? `/trades?${qs}` : '/trades');
      }
      if (req.method === 'GET' && url.pathname === '/api/engine/settings') {
        if (!requireSession(req, res)) return;
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, '/settings');
      }
      if (req.method === 'PUT' && url.pathname === '/api/engine/settings') {
        if (!requireSession(req, res)) return;
        const body = await readJson(req);
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, '/settings', 'PUT', body);
      }
      if (req.method === 'GET' && url.pathname === '/api/engine/wallet') {
        if (!requireSession(req, res)) return;
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, '/wallet');
      }

      const controlRoutes = new Map([
        ['/api/engine/control/arm', { path: '/control/arm', confirmation: 'ARM' }],
        ['/api/engine/control/pause', { path: '/control/pause', confirmation: 'PAUSE' }],
        ['/api/engine/control/stop', { path: '/control/stop', confirmation: 'STOP' }],
        ['/api/engine/control/disarm', { path: '/control/disarm', confirmation: 'STOP' }],
        ['/api/engine/control/reconcile', { path: '/control/reconcile', confirmation: 'RECONCILE' }],
        ['/api/engine/control/cancel-all', { path: '/control/cancel-all', confirmation: 'CANCEL' }],
        ['/api/engine/control/checkpoint', { path: '/control/checkpoint', confirmation: 'CHECKPOINT' }],
        ['/api/engine/control/rollback', { path: '/control/rollback', confirmation: 'ROLLBACK' }],
        ['/api/engine/control/flatten', { path: '/control/flatten', confirmation: 'FLATTEN' }],
        ['/api/engine/control/kill', { path: '/control/kill', confirmation: 'HALT' }],
      ]);
      if (req.method === 'POST' && controlRoutes.has(url.pathname)) {
        if (!requireSession(req, res)) return;
        const action = controlRoutes.get(url.pathname);
        const body = await readJson(req);
        if (body.confirm !== action.confirmation) {
          return json(res, 400, {
            ok: false,
            reason: 'CONFIRMATION_REQUIRED',
            confirmation: action.confirmation,
          });
        }
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, action.path, 'POST', body);
      }
      if (req.method === 'POST' && url.pathname === '/api/engine/strategy-library/presets') {
        if (!requireSession(req, res)) return;
        const body = await readJson(req);
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, '/strategy-library/presets', 'POST', body);
      }
      if (req.method === 'POST' && url.pathname === '/api/engine/strategy-library/activate') {
        if (!requireSession(req, res)) return;
        const body = await readJson(req);
        return proxyEngine(req, res, defaultEngineBaseUrlForProxy, '/strategy-library/activate', 'POST', body);
      }
      if (url.pathname.startsWith('/api/')) {
        return json(res, 404, { ok: false, reason: 'NOT_FOUND' });
      }
      return serveStatic(res, url.pathname);
    } catch (error) {
      return json(res, 500, { ok: false, reason: error.message });
    }
  });

  return {
    server,
    host,
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    stop() {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
