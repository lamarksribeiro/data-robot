#!/usr/bin/env node
/**
 * Painel local read-only do Hyperion dry na Giovanna.
 * Não altera nem para o processo remoto — só SSH + docker exec de leitura.
 *
 *   node scripts/hyperion/hyperion-dashboard.js
 *   npm run hyperion:dashboard
 *
 * Abre http://127.0.0.1:3210
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';

const PORT = Number(process.env.HYPERION_DASH_PORT || 3210);
const HOST = process.env.HYPERION_DASH_HOST || '127.0.0.1';
const SSH_HOST = process.env.HYPERION_SSH_HOST || 'Giovanna';
const CONTAINER = process.env.HYPERION_CONTAINER || 'pair-path-micro';
const LOG_PATH = process.env.HYPERION_LOG || '/tmp/hyperion-dry-10.log';
const RUNS_DIR = '/usr/src/app/runs/hyperion-dry';
const POLL_MS = Math.max(3000, Number(process.env.HYPERION_DASH_POLL_MS || 5000));

function ssh(remoteCmd, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [SSH_HOST, remoteCmd], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ssh timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ssh exit ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function docker(inner) {
  // Evita templates Go / pipes complexos no PowerShell — tudo roda no remoto.
  const q = inner.replace(/'/g, `'\"'\"'`);
  return ssh(`docker exec ${CONTAINER} sh -c '${q}'`);
}

function parseEventsFromLog(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  const events = [];
  let current = null;
  let live = {
    eventIndex: null,
    maxEvents: null,
    slug: null,
    tau: null,
    mode: null,
    up: null,
    dn: null,
    bn: null,
    ptb: null,
    side: null,
    fill: null,
    lastLine: null,
  };

  for (const line of lines) {
    const hdr = line.match(/--- event (\d+)\/(\d+) ---/);
    if (hdr) {
      if (current) events.push(current);
      current = {
        index: Number(hdr[1]),
        max: Number(hdr[2]),
        slug: null,
        status: 'running',
        side: null,
        fill: null,
        ask: null,
        netEdge: null,
        pnl: null,
        winner: null,
        p95Ms: null,
      };
      live.eventIndex = current.index;
      live.maxEvents = current.max;
      continue;
    }

    const ev = line.match(/^event=(\S+)\s+tau≈(\d+)/);
    if (ev && current) {
      current.slug = ev[1];
      live.slug = ev[1];
      live.tau = Number(ev[2]);
    }

    const enter = line.match(/ENTER fill (\w+) @([\d.]+)/);
    if (enter && current) {
      current.side = enter[1];
      current.fill = Number(enter[2]);
      current.status = 'entered';
      live.side = enter[1];
      live.fill = Number(enter[2]);
      live.mode = 'entered';
    }

    const hb = line.match(
      /… hb tau=(\d+)\s+up=([\d.]+|null)\s+dn=([\d.]+|null)\s+bn=([\d.]+|null)\s+ptb=([\d.]+|null)\s+mode=(\w+)/,
    );
    if (hb) {
      live.tau = Number(hb[1]);
      live.up = hb[2] === 'null' ? null : Number(hb[2]);
      live.dn = hb[3] === 'null' ? null : Number(hb[3]);
      live.bn = hb[4] === 'null' ? null : Number(hb[4]);
      live.ptb = hb[5] === 'null' ? null : Number(hb[5]);
      live.mode = hb[6];
    }

    const result = line.match(
      /result mode=(\w+)\s+side=(\w+|null)\s+ask=([\d.]+|null)\s+fill=([\d.]+|null)\s+netEdge=([\d.]+|null)\s+pnl≈([-\d.]+|null)\s+winner=(\w+|null)/,
    );
    if (result && current) {
      current.status = result[1];
      current.side = result[2] === 'null' ? null : result[2];
      current.ask = result[3] === 'null' ? null : Number(result[3]);
      current.fill = result[4] === 'null' ? null : Number(result[4]);
      current.netEdge = result[5] === 'null' ? null : Number(result[5]);
      current.pnl = result[6] === 'null' ? null : Number(result[6]);
      current.winner = result[7] === 'null' ? null : result[7];
    }

    const lat = line.match(/decisionLatency p50=(\d+)ms p95=(\d+)ms/);
    if (lat && current) current.p95Ms = Number(lat[2]);

    if (line.trim()) live.lastLine = line.trim();
  }
  if (current) events.push(current);

  const settled = events.filter((e) => e.status === 'settled' && e.pnl != null);
  const wins = settled.filter((e) => e.pnl > 0).length;
  const losses = settled.filter((e) => e.pnl <= 0).length;
  const totalPnl = settled.reduce((a, e) => a + e.pnl, 0);

  return {
    live,
    events,
    stats: {
      seen: events.length,
      settled: settled.length,
      wins,
      losses,
      winRate: settled.length ? Math.round((wins / settled.length) * 1000) / 10 : null,
      totalPnl: Math.round(totalPnl * 100) / 100,
      running: events.some((e) => e.status === 'running' || e.status === 'entered'),
    },
  };
}

async function collectStatus() {
  const fetchedAt = new Date().toISOString();
  let alive = false;
  let logText = '';
  let reports = [];
  let summary = null;
  let error = null;
  let logPathUsed = LOG_PATH;

  // Script remoto via base64 — evita expansão de $VAR pelo shell do sshd.
  const remoteScript = `
set +e
C=${CONTAINER}
LOG=${LOG_PATH}
if ! docker exec "$C" test -f "$LOG" 2>/dev/null; then
  LOG=$(docker exec "$C" sh -c 'ls -1t /tmp/hyperion-dry*.log 2>/dev/null | head -n1')
fi
echo "__LOG__=$LOG"
echo "__ALIVE__"
docker exec "$C" sh -c 'ps aux' 2>/dev/null | grep '[h]yperion-dry' || true
echo "__LOGTAIL__"
if [ -n "$LOG" ]; then docker exec "$C" tail -n 400 "$LOG" 2>/dev/null || true; fi
echo "__REPORTS__"
docker exec "$C" sh -c 'ls -1t runs/hyperion-dry/hy_*.json 2>/dev/null | head -n 12' || true
echo "__SUMMARY__"
docker exec "$C" sh -c 'ls -1t runs/hyperion-dry/summary_*.json 2>/dev/null | head -n 1' || true
`.trim();

  try {
    const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');
    const blob = await ssh(`echo ${b64} | base64 -d | bash`, 35_000);

    const logMatch = blob.match(/__LOG__=(.*)/);
    if (logMatch?.[1]?.trim()) logPathUsed = logMatch[1].trim();

    const alivePart = blob.split('__ALIVE__')[1]?.split('__LOGTAIL__')[0] || '';
    alive = /hyperion-dry\.js/.test(alivePart);

    logText = blob.split('__LOGTAIL__')[1]?.split('__REPORTS__')[0] || '';

    const reportList = (blob.split('__REPORTS__')[1]?.split('__SUMMARY__')[0] || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const sumFile = (blob.split('__SUMMARY__')[1] || '').trim().split(/\r?\n/)[0];

    if (reportList.length) {
      const fetchScript = reportList
        .slice(0, 10)
        .map((f) => `echo "__FILE__${f}"\ndocker exec ${CONTAINER} cat '${f}'\necho`)
        .join('\n');
      const fetchB64 = Buffer.from(fetchScript, 'utf8').toString('base64');
      const rawBundle = await ssh(`echo ${fetchB64} | base64 -d | bash`, 40_000);
      const chunks = rawBundle.split(/__FILE__/).slice(1);
      for (const chunk of chunks) {
        const nl = chunk.indexOf('\n');
        const body = nl >= 0 ? chunk.slice(nl + 1).trim() : '';
        try {
          if (body) reports.push(JSON.parse(body));
        } catch {
          /* ignore */
        }
      }
    }

    if (sumFile) {
      try {
        const catScript = `docker exec ${CONTAINER} cat '${sumFile}'`;
        const catB64 = Buffer.from(catScript, 'utf8').toString('base64');
        const raw = await ssh(`echo ${catB64} | base64 -d | bash`, 20_000);
        summary = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    error = String(err?.message || err);
  }

  const parsed = parseEventsFromLog(logText);
  return {
    fetchedAt,
    alive,
    logPath: logPathUsed,
    container: CONTAINER,
    error,
    ...parsed,
    reports,
    summary,
    logTail: String(logText || '')
      .split(/\r?\n/)
      .slice(-40)
      .join('\n'),
  };
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hyperion Dry · Giovanna</title>
<style>
  :root {
    --bg: #0f1419;
    --panel: #1a222c;
    --line: #2a3542;
    --text: #e7eef6;
    --muted: #8b9aab;
    --win: #3dd68c;
    --loss: #ff6b6b;
    --run: #f0b429;
    --idle: #6b7c8f;
    --accent: #5b9fd4;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", "IBM Plex Sans", system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 10% -10%, #1b2a3a 0%, var(--bg) 55%);
    color: var(--text);
    min-height: 100vh;
  }
  header {
    padding: 20px 24px 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: baseline;
    justify-content: space-between;
  }
  h1 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 650;
    letter-spacing: 0.02em;
  }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-size: 0.85rem;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--idle);
  }
  .dot.on { background: var(--win); box-shadow: 0 0 10px rgba(61,214,140,.5); }
  .dot.off { background: var(--loss); }
  main { padding: 8px 24px 32px; display: grid; gap: 16px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .stat .k { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: .06em; }
  .stat .v { font-size: 1.45rem; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat .v.win { color: var(--win); }
  .stat .v.loss { color: var(--loss); }
  .grid2 {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 16px;
  }
  @media (max-width: 960px) { .grid2 { grid-template-columns: 1fr; } }
  section {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    min-height: 120px;
  }
  section h2 {
    margin: 0 0 12px;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .05em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge.settled.win { background: rgba(61,214,140,.15); color: var(--win); }
  .badge.settled.loss { background: rgba(255,107,107,.15); color: var(--loss); }
  .badge.entered, .badge.running { background: rgba(240,180,41,.15); color: var(--run); }
  .badge.idle { background: rgba(107,124,143,.2); color: var(--muted); }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 0.72rem;
    line-height: 1.45;
    color: #c5d0db;
    max-height: 420px;
    overflow: auto;
  }
  .live-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
  .live-row .k { color: var(--muted); font-size: 0.72rem; }
  .live-row .v { font-weight: 600; margin-top: 2px; }
  .err { color: var(--loss); font-size: 0.85rem; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Hyperion V4 Terminal · Dry Shadow</h1>
    <div class="meta">Giovanna · pair-path-micro · leitura apenas · auto-refresh</div>
  </div>
  <div class="pill"><span id="aliveDot" class="dot"></span><span id="aliveLabel">checando…</span></div>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div class="grid2">
    <section>
      <h2>Ao vivo</h2>
      <div class="live-row" id="live"></div>
      <div id="err" class="err"></div>
    </section>
    <section>
      <h2>Eventos</h2>
      <div style="overflow:auto">
        <table>
          <thead>
            <tr><th>#</th><th>Slug</th><th>Status</th><th>Side</th><th>Fill</th><th>PnL</th><th>Winner</th></tr>
          </thead>
          <tbody id="events"></tbody>
        </table>
      </div>
    </section>
  </div>
  <section>
    <h2>Log (tail)</h2>
    <pre id="log"></pre>
  </section>
  <div class="meta" id="footer"></div>
</main>
<script>
const POLL_MS = ${POLL_MS};
function fmt(n, d=2) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(d);
}
function money(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = (n >= 0 ? '+' : '') + Number(n).toFixed(2);
  return s;
}
async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const alive = !!data.alive;
    const dot = document.getElementById('aliveDot');
    const label = document.getElementById('aliveLabel');
    dot.className = 'dot ' + (alive ? 'on' : 'off');
    label.textContent = alive
      ? 'processo dry ativo'
      : (data.stats?.settled ? 'dry parado / concluído' : 'processo não encontrado');

    const st = data.stats || {};
    const pnlClass = st.totalPnl > 0 ? 'win' : (st.totalPnl < 0 ? 'loss' : '');
    document.getElementById('stats').innerHTML = [
      ['Eventos', st.seen ?? 0],
      ['Settled', st.settled ?? 0],
      ['Wins', st.wins ?? 0],
      ['Losses', st.losses ?? 0],
      ['Win rate', st.winRate != null ? st.winRate + '%' : '—'],
      ['PnL shadow', money(st.totalPnl)],
    ].map(([k,v], i) => {
      const cls = i === 5 ? pnlClass : '';
      return '<div class="stat"><div class="k">'+k+'</div><div class="v '+cls+'">'+v+'</div></div>';
    }).join('');

    const lv = data.live || {};
    document.getElementById('live').innerHTML = [
      ['Evento', (lv.eventIndex && lv.maxEvents) ? (lv.eventIndex + '/' + lv.maxEvents) : '—'],
      ['Slug', lv.slug || '—'],
      ['τ', lv.tau != null ? lv.tau + 's' : '—'],
      ['Mode', lv.mode || '—'],
      ['Side/Fill', lv.side ? (lv.side + ' @' + fmt(lv.fill, 3)) : '—'],
      ['UP/DN', (lv.up!=null && lv.dn!=null) ? (fmt(lv.up,2)+' / '+fmt(lv.dn,2)) : '—'],
      ['Binance', lv.bn != null ? fmt(lv.bn, 2) : '—'],
      ['PTB', lv.ptb != null ? fmt(lv.ptb, 2) : '—'],
    ].map(([k,v]) => '<div><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');

    document.getElementById('err').textContent = data.error || '';

    const rows = (data.events || []).slice().reverse().map(e => {
      const win = e.pnl != null && e.pnl > 0;
      const badgeCls = 'badge ' + e.status + (e.status === 'settled' ? (win ? ' win' : ' loss') : '');
      return '<tr>' +
        '<td>'+e.index+'</td>' +
        '<td>'+(e.slug || '—').replace(/^btc-updown-5m-/, '…')+'</td>' +
        '<td><span class="'+badgeCls+'">'+e.status+'</span></td>' +
        '<td>'+(e.side || '—')+'</td>' +
        '<td>'+(e.fill != null ? fmt(e.fill, 3) : '—')+'</td>' +
        '<td style="color:'+(e.pnl>0?'var(--win)':(e.pnl<0?'var(--loss)':'inherit'))+'">'+(e.pnl!=null?money(e.pnl):'—')+'</td>' +
        '<td>'+(e.winner || '—')+'</td>' +
        '</tr>';
    }).join('');
    document.getElementById('events').innerHTML = rows || '<tr><td colspan="7">sem eventos ainda</td></tr>';
    document.getElementById('log').textContent = data.logTail || '(vazio)';
    document.getElementById('footer').textContent =
      'Atualizado ' + data.fetchedAt + ' · poll ' + (POLL_MS/1000) + 's · log ' + data.logPath;
  } catch (err) {
    document.getElementById('err').textContent = String(err);
  }
}
refresh();
setInterval(refresh, POLL_MS);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/api/status') {
    try {
      const status = await collectStatus();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[hyperion-dashboard] http://${HOST}:${PORT}`);
  console.log(`[hyperion-dashboard] SSH ${SSH_HOST} · ${CONTAINER} · ${LOG_PATH}`);
  console.log('[hyperion-dashboard] read-only — não para o dry remoto');
});
