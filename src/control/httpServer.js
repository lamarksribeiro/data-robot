/**
 * HTTP control plane mínimo (sem Express) — engine process.
 * UI continua em :3200; engine default :3201.
 */

import http from 'node:http';

/**
 * @param {object} opts
 * @param {() => object} opts.getHealth
 * @param {() => object} opts.getStatus
 * @param {() => object} opts.getMetrics
 * @param {() => object} [opts.getCatalog]
 * @param {() => object} [opts.getInstances]
 * @param {(limit:number) => object[]} [opts.getAudit]
 * @param {() => Promise<object>|object} [opts.onKill]
 * @param {string} [opts.opsToken] — se setado, POST /control/* exige header x-ops-token
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 */
export function createControlServer(opts) {
  const port = opts.port ?? Number(process.env.ENGINE_PORT || 3201);
  const host = opts.host ?? process.env.ENGINE_HOST ?? '127.0.0.1';

  function authorize(req) {
    if (!opts.opsToken) return true;
    return req.headers['x-ops-token'] === opts.opsToken;
  }

  function send(res, code, body) {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(json);
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

  const actions = new Map([
    ['/control/arm', { confirmation: 'ARM', handler: opts.onArm }],
    ['/control/pause', { confirmation: 'PAUSE', handler: opts.onPause }],
    ['/control/disarm', { confirmation: 'STOP', handler: opts.onDisarm }],
    ['/control/stop', { confirmation: 'STOP', handler: opts.onDisarm }],
    ['/control/cancel-all', { confirmation: 'CANCEL', handler: opts.onCancelAll }],
    ['/control/reconcile', { confirmation: 'RECONCILE', handler: opts.onReconcile }],
    ['/control/checkpoint', { confirmation: 'CHECKPOINT', handler: opts.onCheckpoint }],
    ['/control/rollback', { confirmation: 'ROLLBACK', handler: opts.onRollback }],
    ['/control/flatten', { confirmation: 'FLATTEN', handler: opts.onFlatten }],
    ['/control/kill', { confirmation: 'HALT', handler: opts.onKill }],
  ]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    const pathName = url.pathname;

    try {
      if (req.method === 'GET' && pathName === '/health') {
        const h = opts.getHealth();
        return send(res, h.ok ? 200 : 503, h);
      }
      if (req.method === 'GET' && pathName === '/ready') {
        const h = opts.getHealth();
        return send(res, h.ready ? 200 : 503, { ready: h.ready, state: h.state });
      }
      if (req.method === 'GET' && pathName === '/status') {
        return send(res, 200, opts.getStatus());
      }
      if (req.method === 'GET' && pathName === '/metrics') {
        return send(res, 200, opts.getMetrics());
      }
      if (req.method === 'GET' && pathName === '/catalog') {
        return send(res, 200, opts.getCatalog?.() ?? null);
      }
      if (req.method === 'GET' && pathName === '/instances') {
        return send(res, 200, opts.getInstances?.() ?? []);
      }
      if (req.method === 'GET' && pathName === '/audit') {
        const requested = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, requested)) : 100;
        return send(res, 200, opts.getAudit?.(limit) ?? []);
      }
      if (req.method === 'POST' && actions.has(pathName)) {
        if (!authorize(req)) return send(res, 401, { ok: false, reason: 'UNAUTHORIZED' });
        const action = actions.get(pathName);
        if (typeof action.handler !== 'function') {
          return send(res, 501, { ok: false, reason: 'ACTION_NOT_IMPLEMENTED' });
        }
        const body = await readJson(req);
        if (body.confirm !== action.confirmation) {
          return send(res, 400, {
            ok: false,
            reason: 'CONFIRMATION_REQUIRED',
            confirmation: action.confirmation,
          });
        }
        const result = await action.handler(body.reason ?? `http-${pathName.split('/').at(-1)}`);
        return send(res, 200, { ok: true, result });
      }
      return send(res, 404, { ok: false, reason: 'NOT_FOUND' });
    } catch (err) {
      return send(res, 500, { ok: false, reason: err.message });
    }
  });

  return {
    port,
    host,
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve({ port, host }));
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
