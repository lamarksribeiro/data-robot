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
  const engineBaseUrl = String(opts.engineBaseUrl ?? 'http://127.0.0.1:3201').replace(/\/$/, '');
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

  async function proxyEngine(req, res, enginePath, method = 'GET', body = null) {
    const headers = { accept: 'application/json' };
    let requestBody;
    if (method !== 'GET') {
      if (!opts.engineOpsToken) {
        return json(res, 503, { ok: false, reason: 'ENGINE_OPS_TOKEN_NOT_CONFIGURED' });
      }
      headers['x-ops-token'] = opts.engineOpsToken;
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
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
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

      const readRoutes = new Map([
        ['/api/engine/health', '/health'],
        ['/api/engine/status', '/status'],
        ['/api/engine/metrics', '/metrics'],
        ['/api/engine/catalog', '/catalog'],
        ['/api/engine/instances', '/instances'],
      ]);
      if (req.method === 'GET' && readRoutes.has(url.pathname)) {
        if (!requireSession(req, res)) return;
        return proxyEngine(req, res, readRoutes.get(url.pathname));
      }
      if (req.method === 'GET' && url.pathname === '/api/engine/audit') {
        if (!requireSession(req, res)) return;
        const requested = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, requested)) : 100;
        return proxyEngine(req, res, `/audit?limit=${limit}`);
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
        return proxyEngine(req, res, action.path, 'POST', body);
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
