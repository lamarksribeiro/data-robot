#!/usr/bin/env node
/**
 * Painel local read-only do Early Favorite Rush dry na Giovanna.
 * Não altera nem para o processo remoto — só SSH + docker exec de leitura.
 *
 *   node scripts/early-fav-rush/early-fav-rush-dashboard.js
 *   npm run early-fav:dashboard
 *
 * Abre http://127.0.0.1:3212
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';

const PORT = Number(process.env.EARLY_FAV_DASH_PORT || 3212);
const HOST = process.env.EARLY_FAV_DASH_HOST || '127.0.0.1';
const SSH_HOST = process.env.EARLY_FAV_SSH_HOST || 'Giovanna';
const CONTAINER = process.env.EARLY_FAV_CONTAINER || 'pair-path-micro';
const LOG_PATH = process.env.EARLY_FAV_LOG || '/tmp/early-fav-rush-dry.log';
const RUNS_DIR = '/usr/src/app/runs/early-fav-rush-dry';
const POLL_MS = Math.max(3000, Number(process.env.EARLY_FAV_DASH_POLL_MS || 5000));
const RECENT_EVENTS = 5;

const ASSET_COLORS = Object.freeze({
  btc: '#f7931a',
  eth: '#8b9cff',
  sol: '#14f195',
  xrp: '#5eb8ff',
  bnb: '#f3ba2f',
  doge: '#c2a633',
  hype: '#ff6ec7',
  portfolio: '#e8eef7',
});

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

function eventKeyFromSlug(slug) {
  const m = String(slug || '').match(/(\d{9,})$/);
  return m ? m[1] : null;
}

function fmtEventLabel(eventKey) {
  const n = Number(eventKey);
  if (!Number.isFinite(n) || n < 1e9) return String(eventKey || '—');
  try {
    return new Date(n * 1000).toISOString().slice(11, 16) + 'Z';
  } catch {
    return String(eventKey);
  }
}

function ensureEvent(map, eventKey, order) {
  if (!eventKey) return null;
  if (!map.has(eventKey)) {
    map.set(eventKey, {
      eventKey,
      label: fmtEventLabel(eventKey),
      order: order ?? map.size,
      byAsset: {},
      eventPnl: 0,
      trades: 0,
      opens: 0,
      skips: 0,
    });
  }
  return map.get(eventKey);
}

function parseLog(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  const assets = {};
  const trades = [];
  const skips = [];
  const eventsMap = new Map();
  const pendingOpen = {};
  let eventOrder = 0;
  let header = {
    assetsList: null,
    budget: null,
    maxEvents: null,
    fill: null,
    timeoutSec: null,
  };
  let hb = {
    trades: null,
    maxEvents: null,
    open: null,
    minTau: null,
    sleeping: false,
  };
  let lastLine = null;

  const ensure = (key) => {
    const k = String(key || '').toLowerCase();
    if (!assets[k]) {
      assets[k] = {
        asset: k,
        slug: null,
        eventKey: null,
        rule: null,
        ptb: null,
        status: 'idle',
        side: null,
        ask: null,
        tauAtEntry: null,
        won: null,
        pnl: null,
        winner: null,
        skipReason: null,
      };
    }
    return assets[k];
  };

  const touchAssetOnEvent = (eventKey, assetKey, patch) => {
    const ev = ensureEvent(eventsMap, eventKey, eventOrder++);
    if (!ev) return;
    const prev = ev.byAsset[assetKey] || {
      asset: assetKey,
      status: 'flat',
      side: null,
      ask: null,
      tauAtEntry: null,
      pnl: null,
      won: null,
      reason: null,
      slug: null,
    };
    ev.byAsset[assetKey] = { ...prev, ...patch };
  };

  for (const line of lines) {
    if (line.trim()) lastLine = line.trim();

    const hdr = line.match(
      /assets=([^\s]+)\s+budget=\$([\d.]+)\s+maxEvents=(\d+)\s+fill=(\w+)\s+timeout=(\d+)s/,
    );
    if (hdr) {
      header = {
        assetsList: hdr[1].split(','),
        budget: Number(hdr[2]),
        maxEvents: Number(hdr[3]),
        fill: hdr[4],
        timeoutSec: Number(hdr[5]),
      };
      for (const a of header.assetsList) ensure(a);
      continue;
    }

    const evLine = line.match(
      /^\[(\w+)\]\s+event=(\S+)\s+ptb=(\S+)\s+rule=(.+)$/,
    );
    if (evLine) {
      const a = ensure(evLine[1]);
      const slug = evLine[2];
      const eventKey = eventKeyFromSlug(slug);
      a.slug = slug;
      a.eventKey = eventKey;
      a.ptb = evLine[3] === 'pendente' ? null : Number(evLine[3]);
      a.rule = evLine[4].trim();
      a.status = 'watching';
      a.side = null;
      a.ask = null;
      a.tauAtEntry = null;
      a.won = null;
      a.pnl = null;
      a.winner = null;
      a.skipReason = null;
      ensureEvent(eventsMap, eventKey, eventOrder++);
      touchAssetOnEvent(eventKey, a.asset, {
        status: 'watching',
        slug,
        side: null,
        ask: null,
        tauAtEntry: null,
        pnl: null,
        won: null,
        reason: null,
      });
      continue;
    }

    const ptbOnly = line.match(/^\[(\w+)\]\s+ptb=([\d.]+)/);
    if (ptbOnly) {
      ensure(ptbOnly[1]).ptb = Number(ptbOnly[2]);
      continue;
    }

    const sig = line.match(
      /^\[SIGNAL\s+(\w+)\]\s+(UP|DOWN)@([\d.]+)\s+τ=(\d+)(?:\s+slug=(\S+))?/,
    );
    if (sig) {
      const a = ensure(sig[1]);
      const slug = sig[5] || a.slug;
      const eventKey = eventKeyFromSlug(slug) || a.eventKey;
      a.status = 'open';
      a.side = sig[2];
      a.ask = Number(sig[3]);
      a.tauAtEntry = Number(sig[4]);
      a.skipReason = null;
      if (slug) {
        a.slug = slug;
        a.eventKey = eventKey;
      }
      pendingOpen[a.asset] = {
        asset: a.asset,
        side: a.side,
        ask: a.ask,
        tauAtEntry: a.tauAtEntry,
        slug,
        eventKey,
      };
      touchAssetOnEvent(eventKey, a.asset, {
        status: 'open',
        side: a.side,
        ask: a.ask,
        tauAtEntry: a.tauAtEntry,
        slug,
        pnl: null,
        won: null,
        reason: null,
      });
      const ev = eventsMap.get(eventKey);
      if (ev) ev.opens += 1;
      continue;
    }

    const skip = line.match(/^\[SKIP\s+(\w+)\]\s+(.+?)\s+slug=(\S+)/);
    if (skip) {
      const a = ensure(skip[1]);
      const slug = skip[3];
      const eventKey = eventKeyFromSlug(slug);
      a.status = 'skip';
      a.skipReason = skip[2].trim();
      a.slug = slug;
      a.eventKey = eventKey;
      skips.push({
        asset: skip[1],
        reason: skip[2].trim(),
        slug,
        eventKey,
      });
      touchAssetOnEvent(eventKey, a.asset, {
        status: 'skip',
        reason: skip[2].trim(),
        slug,
        side: null,
        ask: null,
        tauAtEntry: null,
        pnl: null,
        won: null,
      });
      const ev = eventsMap.get(eventKey);
      if (ev) ev.skips += 1;
      continue;
    }

    const settle = line.match(
      /^\[ENTER-SETTLE\s+(\w+)\]\s+(UP|DOWN)@([\d.]+)\s+τ=(\d+)\s+won=(true|false)\s+pnl=([-\d.]+)(?:\s+.*?slug=(\S+))?/,
    );
    if (settle) {
      const a = ensure(settle[1]);
      const won = settle[5] === 'true';
      const pnl = Number(settle[6]);
      const pending = pendingOpen[a.asset];
      const slug = settle[7] || pending?.slug || a.slug;
      const eventKey = eventKeyFromSlug(slug) || pending?.eventKey || a.eventKey;
      a.status = won ? 'win' : 'loss';
      a.side = settle[2];
      a.ask = Number(settle[3]);
      a.tauAtEntry = Number(settle[4]);
      a.won = won;
      a.pnl = pnl;
      if (slug) {
        a.slug = slug;
        a.eventKey = eventKey;
      }
      delete pendingOpen[a.asset];
      const row = {
        asset: settle[1],
        side: settle[2],
        ask: Number(settle[3]),
        tauAtEntry: Number(settle[4]),
        won,
        pnl,
        slug,
        eventKey,
        seq: trades.length + 1,
        eventLabel: fmtEventLabel(eventKey),
        exitKind: 'settle',
      };
      trades.push(row);
      touchAssetOnEvent(eventKey, a.asset, {
        status: won ? 'win' : 'loss',
        side: row.side,
        ask: row.ask,
        tauAtEntry: row.tauAtEntry,
        pnl,
        won,
        slug,
        reason: null,
        exitKind: 'settle',
      });
      const ev = eventsMap.get(eventKey);
      if (ev) {
        ev.trades += 1;
        ev.eventPnl = Math.round((ev.eventPnl + pnl) * 100) / 100;
      }
      continue;
    }

    const disaster = line.match(
      /^\[DISASTER-EXIT\s+(\w+)\]\s+(UP|DOWN)@([\d.]+)\s+τEntry=(\d+)\s+exitBid=([\d.]+)\s+τ=(\d+)\s+pnl=([-\d.]+)/,
    );
    if (disaster) {
      const a = ensure(disaster[1]);
      const pnl = Number(disaster[7]);
      const won = pnl > 0;
      const pending = pendingOpen[a.asset];
      const slug = pending?.slug || a.slug;
      const eventKey = eventKeyFromSlug(slug) || pending?.eventKey || a.eventKey;
      a.status = 'disaster';
      a.side = disaster[2];
      a.ask = Number(disaster[3]);
      a.tauAtEntry = Number(disaster[4]);
      a.won = won;
      a.pnl = pnl;
      if (slug) {
        a.slug = slug;
        a.eventKey = eventKey;
      }
      delete pendingOpen[a.asset];
      const row = {
        asset: disaster[1],
        side: disaster[2],
        ask: Number(disaster[3]),
        tauAtEntry: Number(disaster[4]),
        won,
        pnl,
        slug,
        eventKey,
        seq: trades.length + 1,
        eventLabel: fmtEventLabel(eventKey),
        exitKind: 'disaster',
        exitBid: Number(disaster[5]),
        exitTau: Number(disaster[6]),
      };
      trades.push(row);
      touchAssetOnEvent(eventKey, a.asset, {
        status: 'disaster',
        side: row.side,
        ask: row.ask,
        tauAtEntry: row.tauAtEntry,
        pnl,
        won,
        slug,
        reason: `exit@${row.exitBid}`,
        exitKind: 'disaster',
      });
      const ev = eventsMap.get(eventKey);
      if (ev) {
        ev.trades += 1;
        ev.eventPnl = Math.round((ev.eventPnl + pnl) * 100) / 100;
      }
      continue;
    }

    const hbSleep = line.match(
      /^\[hb\]\s+trades=(\d+)\/(\d+)\s+minτ=(\d+)\s+sleep\s+(\d+)s/,
    );
    if (hbSleep) {
      hb = {
        trades: Number(hbSleep[1]),
        maxEvents: Number(hbSleep[2]),
        open: 0,
        minTau: Number(hbSleep[3]),
        sleeping: true,
        sleepSec: Number(hbSleep[4]),
      };
      continue;
    }

    const hbOpen = line.match(
      /^\[hb\]\s+trades=(\d+)\/(\d+)\s+open=(\d+)\s+minτ=(\d+)/,
    );
    if (hbOpen) {
      hb = {
        trades: Number(hbOpen[1]),
        maxEvents: Number(hbOpen[2]),
        open: Number(hbOpen[3]),
        minTau: Number(hbOpen[4]),
        sleeping: false,
      };
    }
  }

  // Posições ainda abertas (SIGNAL sem settle) entram nos eventos recentes
  for (const p of Object.values(pendingOpen)) {
    touchAssetOnEvent(p.eventKey, p.asset, {
      status: 'open',
      side: p.side,
      ask: p.ask,
      tauAtEntry: p.tauAtEntry,
      slug: p.slug,
      pnl: null,
      won: null,
    });
  }

  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const byAsset = {};
  for (const t of trades) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { trades: 0, wins: 0, pnl: 0 };
    byAsset[t.asset].trades += 1;
    if (t.won) byAsset[t.asset].wins += 1;
    byAsset[t.asset].pnl += t.pnl || 0;
  }
  for (const k of Object.keys(byAsset)) {
    byAsset[k].pnl = Math.round(byAsset[k].pnl * 100) / 100;
    byAsset[k].winRate =
      byAsset[k].trades > 0
        ? Math.round((byAsset[k].wins / byAsset[k].trades) * 1000) / 10
        : null;
  }

  const assetOrder = header.assetsList?.length
    ? header.assetsList
    : Object.keys(assets).sort();

  const recentEvents = [...eventsMap.values()]
    .sort((a, b) => Number(b.eventKey) - Number(a.eventKey))
    .slice(0, RECENT_EVENTS)
    .map((ev) => {
      const cells = {};
      for (const asset of assetOrder) {
        cells[asset] = ev.byAsset[asset] || {
          asset,
          status: 'flat',
          side: null,
          ask: null,
          tauAtEntry: null,
          pnl: null,
          won: null,
          reason: null,
          slug: null,
        };
      }
      return {
        eventKey: ev.eventKey,
        label: ev.label,
        eventPnl: ev.eventPnl,
        trades: ev.trades,
        opens: ev.opens,
        skips: ev.skips,
        cells,
      };
    });

  // Série PnL acumulado: ponto 0 = zero; depois cada settle
  const cum = Object.fromEntries(assetOrder.map((a) => [a, 0]));
  let cumPort = 0;
  const points = [
    {
      seq: 0,
      label: 'start',
      eventKey: null,
      eventLabel: '0',
      portfolio: 0,
      byAsset: Object.fromEntries(assetOrder.map((a) => [a, 0])),
      trade: null,
    },
  ];
  for (const t of trades) {
    if (cum[t.asset] == null) cum[t.asset] = 0;
    cum[t.asset] = Math.round((cum[t.asset] + t.pnl) * 100) / 100;
    cumPort = Math.round((cumPort + t.pnl) * 100) / 100;
    points.push({
      seq: t.seq,
      label: `#${t.seq} ${String(t.asset).toUpperCase()}`,
      eventKey: t.eventKey,
      eventLabel: t.eventLabel,
      portfolio: cumPort,
      byAsset: { ...cum },
      trade: {
        asset: t.asset,
        side: t.side,
        pnl: t.pnl,
        won: t.won,
      },
    });
  }

  return {
    header,
    hb,
    lastLine,
    colors: ASSET_COLORS,
    assets: assetOrder.map((k) => assets[k] || ensure(k)),
    trades,
    skips: skips.slice(-40),
    recentEvents,
    pnlSeries: {
      assets: assetOrder,
      colors: ASSET_COLORS,
      points,
    },
    stats: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length
        ? Math.round((wins / trades.length) * 1000) / 10
        : null,
      totalPnl: Math.round(totalPnl * 100) / 100,
      open: Object.values(assets).filter((a) => a.status === 'open').length,
      skips: skips.length,
      maxEvents: header.maxEvents ?? hb.maxEvents,
      eventsSeen: eventsMap.size,
    },
    byAsset,
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
  let procLine = '';

  const remoteScript = `
set +e
C=${CONTAINER}
LOG=${LOG_PATH}
if ! docker exec "$C" test -f "$LOG" 2>/dev/null; then
  LOG=$(docker exec "$C" sh -c 'ls -1t /tmp/early-fav-rush*.log 2>/dev/null | head -n1')
fi
echo "__LOG__=$LOG"
echo "__ALIVE__"
docker exec "$C" sh -c 'ps -eo pid,etime,args' 2>/dev/null | grep '[e]arly-fav-rush-dry' || true
echo "__LOGTAIL__"
if [ -n "$LOG" ]; then docker exec "$C" tail -n 2500 "$LOG" 2>/dev/null || true; fi
echo "__REPORTS__"
docker exec "$C" sh -c 'ls -1t ${RUNS_DIR}/report-*.json 2>/dev/null | head -n 3' || true
`.trim();

  try {
    const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');
    const blob = await ssh(`echo ${b64} | base64 -d | bash`, 35_000);

    const logMatch = blob.match(/__LOG__=(.*)/);
    if (logMatch?.[1]?.trim()) logPathUsed = logMatch[1].trim();

    const alivePart = blob.split('__ALIVE__')[1]?.split('__LOGTAIL__')[0] || '';
    procLine = alivePart.trim().split(/\r?\n/).filter(Boolean)[0] || '';
    alive = /early-fav-rush-dry/.test(alivePart);

    logText = blob.split('__LOGTAIL__')[1]?.split('__REPORTS__')[0] || '';

    const reportList = (blob.split('__REPORTS__')[1] || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (reportList.length) {
      const fetchScript = reportList
        .slice(0, 2)
        .map((f) => `echo "__FILE__${f}"\ndocker exec ${CONTAINER} cat '${f}'\necho`)
        .join('\n');
      const fetchB64 = Buffer.from(fetchScript, 'utf8').toString('base64');
      const rawBundle = await ssh(`echo ${fetchB64} | base64 -d | bash`, 40_000);
      const chunks = rawBundle.split(/__FILE__/).slice(1);
      for (const chunk of chunks) {
        const nl = chunk.indexOf('\n');
        const body = nl >= 0 ? chunk.slice(nl + 1).trim() : '';
        try {
          if (body) {
            const j = JSON.parse(body);
            reports.push(j);
            if (!summary && j.summary) summary = j;
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    error = String(err?.message || err);
  }

  const parsed = parseLog(logText);
  if (summary?.summary && parsed.stats.trades === 0 && summary.summary.trades > 0) {
    parsed.stats = {
      ...parsed.stats,
      trades: summary.summary.trades,
      wins: summary.summary.wins,
      losses: summary.summary.trades - summary.summary.wins,
      winRate: summary.summary.winRatePct,
      totalPnl: summary.summary.pnl,
    };
  }

  return {
    fetchedAt,
    alive,
    procLine,
    logPath: logPathUsed,
    container: CONTAINER,
    error,
    ...parsed,
    reportSummary: summary?.summary || null,
    reportByAsset: summary?.byAsset || null,
    logTail: String(logText || '')
      .split(/\r?\n/)
      .slice(-50)
      .join('\n'),
  };
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Early Fav Rush · Dry</title>
<style>
  :root {
    --bg: #10131a;
    --panel: #1a2030;
    --line: #2c3548;
    --text: #e8eef7;
    --muted: #8b97ab;
    --win: #3dd68c;
    --loss: #ff6b6b;
    --run: #f0b429;
    --idle: #6b7c8f;
    --accent: #6cb6ff;
    --skip: #a78bfa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", "IBM Plex Sans", system-ui, sans-serif;
    background:
      radial-gradient(900px 480px at 85% -10%, #1e2d44 0%, transparent 55%),
      radial-gradient(700px 400px at 5% 0%, #1a2838 0%, var(--bg) 50%);
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
  h1 { margin: 0; font-size: 1.3rem; font-weight: 650; letter-spacing: 0.02em; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 999px;
    background: var(--panel); border: 1px solid var(--line); font-size: 0.85rem;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
  .dot.on { background: var(--win); box-shadow: 0 0 10px rgba(61,214,140,.5); }
  .dot.off { background: var(--loss); }
  main { padding: 8px 24px 32px; display: grid; gap: 16px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 12px;
  }
  .stat {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 14px 16px;
  }
  .stat .k { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; }
  .stat .v { font-size: 1.35rem; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat .v.win { color: var(--win); }
  .stat .v.loss { color: var(--loss); }
  .grid2 {
    display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px;
  }
  @media (max-width: 1100px) { .grid2 { grid-template-columns: 1fr; } }
  section {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 14px 16px; min-height: 100px;
  }
  section h2 {
    margin: 0 0 12px; font-size: 0.9rem; font-weight: 600;
    color: var(--muted); text-transform: uppercase; letter-spacing: .05em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th, td {
    text-align: left; padding: 7px 5px; border-bottom: 1px solid var(--line);
    font-variant-numeric: tabular-nums; vertical-align: top;
  }
  th { color: var(--muted); font-weight: 500; font-size: 0.7rem; text-transform: uppercase; }
  .badge {
    display: inline-block; padding: 2px 7px; border-radius: 6px;
    font-size: 0.7rem; font-weight: 600;
  }
  .badge.open, .badge.watching { background: rgba(240,180,41,.15); color: var(--run); }
  .badge.win { background: rgba(61,214,140,.15); color: var(--win); }
  .badge.loss { background: rgba(255,107,107,.15); color: var(--loss); }
  .badge.disaster { background: rgba(255,159,67,.2); color: #ff9f43; }
  .badge.skip { background: rgba(167,139,250,.18); color: var(--skip); }
  .badge.idle, .badge.flat { background: rgba(107,124,143,.2); color: var(--muted); }
  .live-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px;
  }
  .live-row .k { color: var(--muted); font-size: 0.72rem; }
  .live-row .v { font-weight: 600; margin-top: 2px; word-break: break-all; }
  .legend {
    display: flex; flex-wrap: wrap; gap: 10px 14px; margin-bottom: 10px; font-size: 0.78rem;
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .chart-wrap { position: relative; width: 100%; height: 280px; }
  .chart-wrap canvas { width: 100%; height: 100%; display: block; }
  .cell-pnl { font-weight: 650; }
  .asset-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
  }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 0.72rem; line-height: 1.45; color: #c5d0db;
    max-height: 280px; overflow: auto;
  }
  .err { color: var(--loss); font-size: 0.85rem; margin-top: 8px; }
  .scroll { overflow: auto; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Early Favorite Rush · Dry Multi-Asset</h1>
    <div class="meta">Giovanna · pair-path-micro · leitura apenas · auto-refresh</div>
  </div>
  <div class="pill"><span id="aliveDot" class="dot"></span><span id="aliveLabel">checando…</span></div>
</header>
<main>
  <div class="stats" id="stats"></div>

  <section>
    <h2>PnL acumulado no tempo</h2>
    <div class="legend" id="legend"></div>
    <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
  </section>

  <section>
    <h2>Últimos 5 eventos · trades por ativo</h2>
    <div class="scroll">
      <table>
        <thead id="eventsHead"></thead>
        <tbody id="eventsBody"></tbody>
      </table>
    </div>
  </section>

  <div class="grid2">
    <section>
      <h2>Por ativo (ao vivo)</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Asset</th><th>Status</th><th>Side</th><th>Ask</th>
              <th>τ entry</th><th>PnL</th><th>Regra</th>
            </tr>
          </thead>
          <tbody id="assets"></tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Heartbeat</h2>
      <div class="live-row" id="live"></div>
      <div id="err" class="err"></div>
    </section>
  </div>

  <div class="grid2">
    <section>
      <h2>Trades settled (todos)</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>#</th><th>Evento</th><th>Asset</th><th>Side</th><th>Ask</th><th>τ</th><th>Result</th><th>PnL</th></tr>
          </thead>
          <tbody id="trades"></tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Skips recentes</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Asset</th><th>Evento</th><th>Motivo</th></tr></thead>
          <tbody id="skips"></tbody>
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
const DEFAULT_COLORS = ${JSON.stringify(ASSET_COLORS)};

function fmt(n, d=3) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(d);
}
function money(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function colorOf(asset, colors) {
  const c = colors || DEFAULT_COLORS;
  return c[asset] || c[String(asset).toLowerCase()] || '#8b97ab';
}

function cellHtml(cell, asset, colors) {
  if (!cell || cell.status === 'flat') {
    return '<span class="badge flat">—</span>';
  }
  const badge = 'badge ' + cell.status;
  let main = esc(cell.status).toUpperCase();
  if (cell.status === 'open' || cell.status === 'win' || cell.status === 'loss' || cell.status === 'disaster') {
    main = esc(cell.side || '?') + '@' + fmt(cell.ask, 2);
    if (cell.status === 'disaster') main = 'D·' + main;
  } else if (cell.status === 'skip') {
    main = 'SKIP';
  } else if (cell.status === 'watching') {
    main = 'watch';
  }
  const pnl = cell.pnl != null
    ? '<div class="cell-pnl" style="color:'+(cell.pnl>=0?'var(--win)':'var(--loss)')+'">'+money(cell.pnl)+'</div>'
    : (cell.tauAtEntry != null ? '<div style="color:var(--muted);font-size:0.72rem">τ='+cell.tauAtEntry+'</div>' : '');
  const reason = cell.reason
    ? '<div style="color:var(--muted);font-size:0.68rem;max-width:110px;overflow:hidden;text-overflow:ellipsis" title="'+esc(cell.reason)+'">'+esc(cell.reason)+'</div>'
    : '';
  return '<span class="asset-dot" style="background:'+colorOf(asset, colors)+'"></span>' +
    '<span class="'+badge+'">'+main+'</span>' + pnl + reason;
}

function drawPnlChart(series) {
  const canvas = document.getElementById('pnlChart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 280;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const points = series?.points || [];
  const assets = series?.assets || [];
  const colors = series?.colors || DEFAULT_COLORS;
  const pad = { t: 16, r: 16, b: 36, l: 48 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#121826';
  ctx.fillRect(0, 0, cssW, cssH);

  if (points.length < 2) {
    ctx.fillStyle = '#8b97ab';
    ctx.font = '13px Segoe UI, sans-serif';
    ctx.fillText('Aguardando settles para montar a curva…', pad.l, pad.t + 24);
    return;
  }

  let ymin = 0, ymax = 0;
  for (const p of points) {
    ymin = Math.min(ymin, p.portfolio);
    ymax = Math.max(ymax, p.portfolio);
    for (const a of assets) {
      const v = p.byAsset?.[a];
      if (v != null) {
        ymin = Math.min(ymin, v);
        ymax = Math.max(ymax, v);
      }
    }
  }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const padY = (ymax - ymin) * 0.12;
  ymin -= padY;
  ymax += padY;

  const xAt = (i) => pad.l + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const yAt = (v) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * h;

  // grid
  ctx.strokeStyle = '#2c3548';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (g / 4) * h;
    const val = ymax - (g / 4) * (ymax - ymin);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
    ctx.fillStyle = '#8b97ab';
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(val.toFixed(2), 6, y + 4);
  }
  // zero line
  if (ymin < 0 && ymax > 0) {
    ctx.setLineDash([]);
    ctx.strokeStyle = '#4a5568';
    ctx.beginPath();
    ctx.moveTo(pad.l, yAt(0));
    ctx.lineTo(pad.l + w, yAt(0));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  function strokeSeries(getY, color, width, dashed) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [6, 4] : []);
    points.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(getY(p));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const a of assets) {
    strokeSeries((p) => p.byAsset?.[a] ?? 0, colorOf(a, colors), 2, false);
  }
  strokeSeries((p) => p.portfolio, colors.portfolio || '#e8eef7', 2.5, true);

  // x labels (sparse)
  ctx.fillStyle = '#8b97ab';
  ctx.font = '10px Segoe UI, sans-serif';
  const step = Math.max(1, Math.ceil((points.length - 1) / 6));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const label = p.seq === 0 ? '0' : (p.eventLabel || ('#' + p.seq));
    ctx.fillText(label, xAt(i) - 10, cssH - 12);
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const alive = !!data.alive;
    const colors = data.colors || DEFAULT_COLORS;
    const dot = document.getElementById('aliveDot');
    const label = document.getElementById('aliveLabel');
    dot.className = 'dot ' + (alive ? 'on' : 'off');
    label.textContent = alive
      ? 'dry ativo'
      : (data.stats?.trades ? 'dry parado / concluído' : 'processo não encontrado');

    const st = data.stats || {};
    const hdr = data.header || {};
    const pnlClass = st.totalPnl > 0 ? 'win' : (st.totalPnl < 0 ? 'loss' : '');
    document.getElementById('stats').innerHTML = [
      ['Trades', (st.trades ?? 0) + (st.maxEvents != null ? '/' + st.maxEvents : '')],
      ['Eventos', st.eventsSeen ?? 0],
      ['Open', st.open ?? 0],
      ['Wins', st.wins ?? 0],
      ['Losses', st.losses ?? 0],
      ['Win rate', st.winRate != null ? st.winRate + '%' : '—'],
      ['PnL shadow', money(st.totalPnl)],
      ['Budget', hdr.budget != null ? '$' + hdr.budget : '—'],
    ].map(([k,v], i) => {
      const cls = i === 6 ? pnlClass : '';
      return '<div class="stat"><div class="k">'+k+'</div><div class="v '+cls+'">'+v+'</div></div>';
    }).join('');

    const assetList = data.pnlSeries?.assets || hdr.assetsList || [];
    document.getElementById('legend').innerHTML =
      assetList.map(a =>
        '<span><i class="swatch" style="background:'+colorOf(a, colors)+'"></i>'+esc(a).toUpperCase()+'</span>'
      ).join('') +
      '<span><i class="swatch" style="background:'+(colors.portfolio||'#e8eef7')+';outline:1px dashed #8b97ab"></i>PORTFOLIO</span>';

    drawPnlChart(data.pnlSeries);

    // recent events matrix
    const recent = data.recentEvents || [];
    const headAssets = assetList.length
      ? assetList
      : (recent[0] ? Object.keys(recent[0].cells || {}) : []);
    document.getElementById('eventsHead').innerHTML =
      '<tr><th>Evento</th>' +
      headAssets.map(a =>
        '<th><span class="asset-dot" style="background:'+colorOf(a, colors)+'"></span>'+esc(a).toUpperCase()+'</th>'
      ).join('') +
      '<th>PnL evt</th></tr>';

    document.getElementById('eventsBody').innerHTML = recent.length
      ? recent.map(ev => {
          const cells = headAssets.map(a =>
            '<td>'+cellHtml(ev.cells?.[a], a, colors)+'</td>'
          ).join('');
          const ep = ev.eventPnl || 0;
          return '<tr>' +
            '<td><strong>'+esc(ev.label)+'</strong><div style="color:var(--muted);font-size:0.68rem">'+esc(ev.eventKey)+'</div></td>' +
            cells +
            '<td class="cell-pnl" style="color:'+(ep>0?'var(--win)':(ep<0?'var(--loss)':'inherit'))+'">'+money(ep)+'</td>' +
            '</tr>';
        }).join('')
      : '<tr><td colspan="'+(headAssets.length+2)+'">sem eventos ainda</td></tr>';

    const hb = data.hb || {};
    document.getElementById('live').innerHTML = [
      ['Trades', hb.trades != null ? hb.trades + '/' + (hb.maxEvents ?? '—') : '—'],
      ['Open (hb)', hb.open != null ? hb.open : '—'],
      ['min τ', hb.minTau != null ? hb.minTau + 's' : '—'],
      ['Modo', hb.sleeping ? ('sleep ' + (hb.sleepSec||'?') + 's') : (alive ? 'polling' : '—')],
      ['Assets', (hdr.assetsList || []).join(', ') || '—'],
      ['Última linha', data.lastLine || '—'],
    ].map(([k,v]) => '<div><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>').join('');

    document.getElementById('err').textContent = data.error || '';

    const assetRows = (data.assets || []).map(a => {
      const badge = 'badge ' + (a.status || 'idle');
      const pnlColor = a.pnl > 0 ? 'var(--win)' : (a.pnl < 0 ? 'var(--loss)' : 'inherit');
      return '<tr>' +
        '<td><span class="asset-dot" style="background:'+colorOf(a.asset, colors)+'"></span><strong>'+esc(a.asset).toUpperCase()+'</strong></td>' +
        '<td><span class="'+badge+'">'+esc(a.status)+(a.skipReason?' · '+esc(a.skipReason):'')+'</span></td>' +
        '<td>'+(a.side || '—')+'</td>' +
        '<td>'+(a.ask != null ? fmt(a.ask, 3) : '—')+'</td>' +
        '<td>'+(a.tauAtEntry != null ? a.tauAtEntry : '—')+'</td>' +
        '<td style="color:'+pnlColor+'">'+(a.pnl != null ? money(a.pnl) : '—')+'</td>' +
        '<td style="font-size:0.75rem;color:var(--muted)">'+esc(a.rule || '—')+'</td>' +
        '</tr>';
    }).join('');
    document.getElementById('assets').innerHTML =
      assetRows || '<tr><td colspan="7">aguardando assets…</td></tr>';

    const tradeRows = (data.trades || []).slice().reverse().map((t) => {
      const kind = t.exitKind === 'disaster' ? 'disaster' : (t.won ? 'win' : 'loss');
      const badge = 'badge ' + kind;
      const label = t.exitKind === 'disaster' ? 'DISASTER' : (t.won ? 'WIN' : 'LOSS');
      return '<tr>' +
        '<td>'+t.seq+'</td>' +
        '<td>'+esc(t.eventLabel || '—')+'</td>' +
        '<td><span class="asset-dot" style="background:'+colorOf(t.asset, colors)+'"></span>'+esc(t.asset).toUpperCase()+'</td>' +
        '<td>'+esc(t.side)+'</td>' +
        '<td>'+fmt(t.ask, 3)+'</td>' +
        '<td>'+t.tauAtEntry+'</td>' +
        '<td><span class="'+badge+'">'+label+'</span></td>' +
        '<td style="color:'+(t.pnl>0?'var(--win)':(t.pnl<0?'var(--loss)':'inherit'))+'">'+money(t.pnl)+'</td>' +
        '</tr>';
    }).join('');
    document.getElementById('trades').innerHTML =
      tradeRows || '<tr><td colspan="8">nenhum settle ainda</td></tr>';

    const skipRows = (data.skips || []).slice().reverse().slice(0, 20).map(s =>
      '<tr><td>'+esc(s.asset).toUpperCase()+'</td><td>'+esc(s.eventKey ? fmtEventLabelLocal(s.eventKey) : '—')+'</td><td>'+esc(s.reason)+'</td></tr>'
    ).join('');
    document.getElementById('skips').innerHTML =
      skipRows || '<tr><td colspan="3">sem skips</td></tr>';

    document.getElementById('log').textContent = data.logTail || '(vazio)';
    document.getElementById('footer').textContent =
      'Atualizado ' + data.fetchedAt +
      ' · poll ' + (POLL_MS/1000) + 's · log ' + data.logPath +
      (data.procLine ? ' · ' + data.procLine.replace(/\\s+/g, ' ').slice(0, 120) : '');
  } catch (err) {
    document.getElementById('err').textContent = String(err);
  }
}
function fmtEventLabelLocal(eventKey) {
  const n = Number(eventKey);
  if (!Number.isFinite(n) || n < 1e9) return String(eventKey || '—');
  try { return new Date(n * 1000).toISOString().slice(11, 16) + 'Z'; }
  catch { return String(eventKey); }
}
refresh();
setInterval(refresh, POLL_MS);
window.addEventListener('resize', () => {
  // re-fetch not needed; last draw lives until next poll — force soft redraw via poll soon
});
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
  console.log(`[early-fav-dashboard] http://${HOST}:${PORT}`);
  console.log(`[early-fav-dashboard] SSH ${SSH_HOST} · ${CONTAINER} · ${LOG_PATH}`);
  console.log('[early-fav-dashboard] read-only — não para o dry remoto');
});
