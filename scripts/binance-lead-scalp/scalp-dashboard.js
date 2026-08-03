#!/usr/bin/env node
/**
 * Painel local read-only do Binance-lead scalp (dry ou LIVE) na Giovanna.
 *
 *   node scripts/binance-lead-scalp/scalp-dashboard.js
 *   npm run scalp-e:dashboard
 *
 * Prefere log LIVE se existir. Abre http://127.0.0.1:3211
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';

const PORT = Number(process.env.SCALP_DASH_PORT || 3211);
const HOST = process.env.SCALP_DASH_HOST || '127.0.0.1';
const SSH_HOST = process.env.SCALP_SSH_HOST || 'Giovanna';
const CONTAINER = process.env.SCALP_CONTAINER || 'pair-path-micro';
const LOG_PATH = process.env.SCALP_LOG || '/tmp/scalp-e-adapt-live.log';
const RUNS_DIR_LIVE = '/usr/src/app/runs/binance-lead-scalp-live';
const RUNS_DIR_DRY = '/usr/src/app/runs/binance-lead-scalp-dry';
const POLL_MS = Math.max(3000, Number(process.env.SCALP_DASH_POLL_MS || 4000));

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

function parseLog(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  const events = [];
  const trades = [];
  const rescues = [];
  let current = null;
  const config = {
    variant: null,
    impulse: null,
    stale: null,
    ladder: null,
    rescue: null,
    stop: null,
    timeout: null,
    budget: null,
    sessionNotional: null,
    sessionLoss: null,
    fill: null,
    mode: null,
    raw: null,
  };
  const live = {
    eventIndex: null,
    maxEvents: null,
    slug: null,
    tau: null,
    upAsk: null,
    upBid: null,
    dnAsk: null,
    dnBid: null,
    bn: null,
    thr: null,
    tradesN: 0,
    pnl: 0,
    open: null,
    inRescue: false,
    bookLag: null,
    spotAge: null,
    fresh: null,
    skip: null,
    blocks: null,
    lastLine: null,
    waiting: false,
    procLine: null,
    isLive: false,
  };
  const skipHist = {};

  for (const line of lines) {
    if (/Binance-lead scalp LIVE|live=1|ordens reais/.test(line)) {
      live.isLive = true;
      config.mode = 'LIVE';
    }
    if (/Binance-lead scalp dry|zero ordens/.test(line) && !live.isLive) {
      config.mode = 'DRY';
    }
    if (/^fill=live/.test(line.trim())) {
      config.fill = 'live';
      live.isLive = true;
      config.mode = 'LIVE';
    }

    const cfgLine = line.match(
      /^(e-adapt|e-freq|e):\s+(.+?)\s+staleMid≤([\d.]+).*?ladder=\+([0-9.+\/]+)\s+stop=-([\d.]+)\s+timeout=(\d+)s(.*?)(?:\s+maxTrades=|$)/,
    );
    if (cfgLine) {
      config.variant = cfgLine[1];
      config.impulse = cfgLine[2].trim();
      config.stale = Number(cfgLine[3]);
      config.ladder = cfgLine[4];
      config.stop = Number(cfgLine[5]);
      config.timeout = Number(cfgLine[6]);
      const rest = cfgLine[7] || '';
      const rescueM = rest.match(/rescue=\+([\d.]+)(\/hold|\/ds-[\d.]+)?/);
      if (rescueM) config.rescue = `+${rescueM[1]}${rescueM[2] || ''}`;
      config.raw = line.trim();
    }
    const fillLine = line.match(/fill=(honest|cruel)/);
    if (fillLine && !config.fill) config.fill = fillLine[1];
    const budgetLine = line.match(/budget=\$([\d.]+)/);
    if (budgetLine) config.budget = Number(budgetLine[1]);
    const sessN = line.match(/sessionNotional≤\$([\d.]+)/);
    if (sessN) config.sessionNotional = Number(sessN[1]);
    const sessL = line.match(/sessionLoss≤\$([\d.]+)/);
    if (sessL) config.sessionLoss = Number(sessL[1]);
    const maxEv = line.match(/maxEvents=(\d+)/);
    if (maxEv) live.maxEvents = Number(maxEv[1]);

    const wait = line.match(/waiting… slug=(\S+)\s+tau=(\d+)/);
    if (wait) {
      live.waiting = true;
      live.slug = wait[1];
      live.tau = Number(wait[2]);
      live.lastLine = line.trim();
      continue;
    }

    const hdr = line.match(/--- event (\d+)\/(\d+) ---/);
    if (hdr) {
      if (current) events.push(current);
      current = {
        index: Number(hdr[1]),
        max: Number(hdr[2]),
        slug: null,
        status: 'running',
        trades: 0,
        enters: 0,
        rescues: 0,
        pnl: 0,
        fees: null,
        wr: null,
        variant: config.variant,
      };
      live.eventIndex = current.index;
      live.maxEvents = current.max;
      live.waiting = false;
      live.inRescue = false;
      continue;
    }

    const ev = line.match(/^event=(\S+)\s+tau≈(\d+)/);
    if (ev && current) {
      current.slug = ev[1];
      live.slug = ev[1];
      live.tau = Number(ev[2]);
    }

    const intent = line.match(
      /ENTER intent (\w+) ask=([\d.]+) binRet=([-\d.]+) thr=([\d.]+) τ=(\d+)/,
    );
    if (intent) {
      trades.push({
        type: 'intent',
        side: intent[1],
        px: Number(intent[2]),
        binRet: Number(intent[3]),
        thr: Number(intent[4]),
        tau: Number(intent[5]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      });
    }

    const enter = line.match(
      /ENTER fill (\w+) @([\d.]+)\s+sh=([\d.]+)(?:\s+fee=[\d.]+)?(?:\s+binRet=([-\d.]+))?(?:\s+thr=([\d.]+))?(?:\s+ladder=([\d.,]+))?(?:\s+realPx=([\d.]+))?/,
    );
    if (enter) {
      live.open = `${enter[1]}@${enter[2]}`;
      live.inRescue = false;
      const t = {
        type: 'enter',
        side: enter[1],
        px: Number(enter[2]),
        shares: Number(enter[3]),
        binRet: enter[4] != null ? Number(enter[4]) : null,
        thr: enter[5] != null ? Number(enter[5]) : null,
        ladder: enter[6],
        realPx: enter[7] != null ? Number(enter[7]) : null,
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      };
      trades.push(t);
      if (current) {
        current.enters += 1;
        current.status = 'in_trade';
      }
    }

    const fillReal = line.match(/fill px real=([\d.]+) limit=([\d.]+) Δsh=([\d.]+)/);
    if (fillReal) {
      trades.push({
        type: 'fill_px',
        realPx: Number(fillReal[1]),
        limitPx: Number(fillReal[2]),
        shares: Number(fillReal[3]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      });
    }

    const fallback = line.match(/fallback rest SELL @([\d.]+) sh=([\d.]+)/);
    if (fallback) {
      trades.push({
        type: 'fallback',
        px: Number(fallback[1]),
        shares: Number(fallback[2]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      });
    }

    const rescue = line.match(
      /RESCUE enter (\w+) trigger=(\S+) entry=([\d.]+) ask=([\d.]+) rem=([\d.]+)/,
    );
    if (rescue) {
      live.inRescue = true;
      live.open = `${rescue[1]}@${rescue[3]}/R→${rescue[4]}`;
      const r = {
        type: 'rescue',
        side: rescue[1],
        trigger: rescue[2],
        entry: Number(rescue[3]),
        ask: Number(rescue[4]),
        rem: Number(rescue[5]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      };
      trades.push(r);
      rescues.push(r);
      if (current) {
        current.rescues += 1;
        current.status = 'rescue';
      }
    }

    const exit = line.match(
      /EXIT (\S+) (\w+) entry=([\d.]+) exit≈([\d.]+) pnl=([-\d.]+) hold=([\d.]+)s makerSh=([\d.]+) takerSh=([\d.]+) fees=([\d.]+)/,
    );
    if (exit) {
      const t = {
        type: 'exit',
        reason: exit[1],
        side: exit[2],
        entry: Number(exit[3]),
        exitPx: Number(exit[4]),
        pnl: Number(exit[5]),
        hold: Number(exit[6]),
        makerSh: Number(exit[7]),
        takerSh: Number(exit[8]),
        fees: Number(exit[9]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      };
      trades.push(t);
      live.open = '-';
      live.inRescue = false;
      if (current) {
        current.trades += 1;
        current.pnl += t.pnl;
        current.status = 'active';
      }
    }

    const exitShort = line.match(/EXIT (\S+) (\w+) pnl=([-\d.]+) hold=([\d.]+)s/);
    if (!exit && exitShort) {
      const t = {
        type: 'exit',
        reason: exitShort[1],
        side: exitShort[2],
        pnl: Number(exitShort[3]),
        hold: Number(exitShort[4]),
        event: current?.index ?? live.eventIndex,
        slug: current?.slug || live.slug,
      };
      trades.push(t);
      live.open = '-';
      live.inRescue = false;
      if (current) {
        current.trades += 1;
        current.pnl += t.pnl;
      }
    }

    const hb = line.match(
      /… hb tau=(\d+)\s+up=([\d.]+)\/([\d.]+)\s+dn=([\d.]+)\/([\d.]+)\s+bn=([\d.]+)\s+thr=([\d.]+)\s+trades=(\d+)\s+pnl=([-\d.]+)\s+open=(\S+)\s+bookLag=(\d+|null)\s+spotAge=(\d+|null)\s+fresh=(true|false)\s+skip=(\S+)(?:\s+blocks=(\S+))?/,
    );
    if (hb) {
      live.waiting = false;
      live.tau = Number(hb[1]);
      live.upAsk = Number(hb[2]);
      live.upBid = Number(hb[3]);
      live.dnAsk = Number(hb[4]);
      live.dnBid = Number(hb[5]);
      live.bn = Number(hb[6]);
      live.thr = Number(hb[7]);
      live.tradesN = Number(hb[8]);
      live.pnl = Number(hb[9]);
      live.open = hb[10];
      live.inRescue = String(hb[10]).includes('/R');
      live.bookLag = hb[11] === 'null' ? null : Number(hb[11]);
      live.spotAge = hb[12] === 'null' ? null : Number(hb[12]);
      live.fresh = hb[13] === 'true';
      live.skip = hb[14] === '-' ? null : hb[14];
      live.blocks = hb[15] && hb[15] !== '-' ? hb[15] : null;
      if (live.skip) skipHist[live.skip] = (skipHist[live.skip] || 0) + 1;
    } else {
      // fallback hb antigo (sem thr)
      const hbOld = line.match(
        /… hb tau=(\d+)\s+up=([\d.]+)\/([\d.]+)\s+dn=([\d.]+)\/([\d.]+)\s+bn=([\d.]+)\s+trades=(\d+)\s+pnl=([-\d.]+)\s+open=(\S+)\s+bookLag=(\d+|null)\s+spotAge=(\d+|null).*skip=(\S+)/,
      );
      if (hbOld) {
        live.waiting = false;
        live.tau = Number(hbOld[1]);
        live.upAsk = Number(hbOld[2]);
        live.upBid = Number(hbOld[3]);
        live.dnAsk = Number(hbOld[4]);
        live.dnBid = Number(hbOld[5]);
        live.bn = Number(hbOld[6]);
        live.tradesN = Number(hbOld[7]);
        live.pnl = Number(hbOld[8]);
        live.open = hbOld[9];
        live.bookLag = hbOld[10] === 'null' ? null : Number(hbOld[10]);
        live.spotAge = hbOld[11] === 'null' ? null : Number(hbOld[11]);
        live.skip = hbOld[12] === '-' ? null : hbOld[12];
        if (live.skip) skipHist[live.skip] = (skipHist[live.skip] || 0) + 1;
      }
    }

    const result = line.match(
      /result trades=(\d+)\s+wr=([\d.]+|null)%?\s+bruto=([-\d.]+)\s+fees=([\d.]+)\s+liquido=([-\d.]+)\s+pf=([\d.]+|null|Infinity)/,
    );
    if (result && current) {
      current.status = 'done';
      current.trades = Number(result[1]);
      current.wr = result[2] === 'null' ? null : Number(result[2]);
      current.bruto = Number(result[3]);
      current.fees = Number(result[4]);
      current.pnl = Number(result[5]);
      current.pf = result[6] === 'null' || result[6] === 'Infinity' ? result[6] : Number(result[6]);
    }

    if (line.trim()) live.lastLine = line.trim();
  }
  if (current) events.push(current);

  const closed = trades.filter((t) => t.type === 'exit' && t.pnl != null);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const totalPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const fees = closed.reduce((a, t) => a + (t.fees || 0), 0);
  const bruto = totalPnl + fees;
  const byReason = {};
  for (const t of closed) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const rescueFull = closed.filter((t) => t.reason === 'rescue_full');
  const rescueEod = closed.filter((t) => t.reason === 'rescue_eod');
  const ladderFull = closed.filter((t) => t.reason === 'ladder_full');

  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  return {
    config,
    live,
    events,
    trades: trades.slice(-120),
    rescues: rescues.slice(-40),
    skipHist,
    stats: {
      eventsSeen: events.length,
      eventsDone: events.filter((e) => e.status === 'done').length,
      trades: closed.length,
      enters: trades.filter((t) => t.type === 'enter').length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
      lucroBruto: Math.round(bruto * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      lucroLiquido: Math.round(totalPnl * 100) / 100,
      profitFactor: grossL > 0 ? Math.round((grossW / grossL) * 100) / 100 : wins.length ? Infinity : null,
      avgPnl: closed.length ? Math.round((totalPnl / closed.length) * 1000) / 1000 : null,
      avgHold:
        closed.length && closed.every((t) => t.hold != null)
          ? Math.round((closed.reduce((a, t) => a + t.hold, 0) / closed.length) * 10) / 10
          : null,
      exitReasons: byReason,
      rescueEnters: rescues.length,
      rescueFull: rescueFull.length,
      rescueEod: rescueEod.length,
      rescueFullPnl: Math.round(rescueFull.reduce((a, t) => a + t.pnl, 0) * 100) / 100,
      rescueEodPnl: Math.round(rescueEod.reduce((a, t) => a + t.pnl, 0) * 100) / 100,
      ladderFull: ladderFull.length,
      ladderFullPnl: Math.round(ladderFull.reduce((a, t) => a + t.pnl, 0) * 100) / 100,
      running: events.some((e) =>
        ['running', 'in_trade', 'active', 'rescue'].includes(e.status),
      ),
    },
  };
}

async function collectStatus() {
  const fetchedAt = new Date().toISOString();
  let alive = false;
  let logText = '';
  let summary = null;
  let error = null;
  let logPathUsed = LOG_PATH;
  let reportsN = 0;
  let reportsLiveN = 0;
  let reportsDryN = 0;
  let procLine = null;
  let sumLiveFile = '';
  let sumDryFile = '';

  const remoteScript = `
set +e
C=${CONTAINER}
LOG=""
# Prefer LIVE log if live process is up OR live log exists; else dry
LIVE_PROC=$(docker exec "$C" sh -c 'ps -eo pid,etime,args' 2>/dev/null | grep -E '[n]ode scripts/binance-lead-scalp/scalp-live' || true)
DRY_PROC=$(docker exec "$C" sh -c 'ps -eo pid,etime,args' 2>/dev/null | grep -E '[n]ode scripts/binance-lead-scalp/scalp-dry' || true)
if [ -n "$LIVE_PROC" ] && docker exec "$C" test -f /tmp/scalp-e-adapt-live.log 2>/dev/null; then
  LOG=/tmp/scalp-e-adapt-live.log
elif [ -n "$LIVE_PROC" ]; then
  LOG=$(docker exec "$C" sh -c 'ls -1t /tmp/scalp*live*.log 2>/dev/null | head -n1')
elif docker exec "$C" test -f /tmp/scalp-e-adapt-live.log 2>/dev/null && [ -z "$DRY_PROC" ]; then
  # live log sem processo dry ativo → ainda preferir live (sessão recente)
  LOG=/tmp/scalp-e-adapt-live.log
elif docker exec "$C" test -f /tmp/scalp-e-adapt-dry.log 2>/dev/null; then
  LOG=/tmp/scalp-e-adapt-dry.log
elif docker exec "$C" test -f /tmp/scalp-e-freq-dry.log 2>/dev/null; then
  LOG=/tmp/scalp-e-freq-dry.log
elif docker exec "$C" test -f /tmp/scalp-e-dry.log 2>/dev/null; then
  LOG=/tmp/scalp-e-dry.log
else
  LOG=$(docker exec "$C" sh -c 'ls -1t /tmp/scalp*live*.log /tmp/scalp*dry*.log 2>/dev/null | head -n1')
fi
echo "__LOG__=$LOG"
echo "__ALIVE__"
printf '%s\\n' "$LIVE_PROC"
printf '%s\\n' "$DRY_PROC"
echo "__LOGTAIL__"
if [ -n "$LOG" ]; then docker exec "$C" tail -n 1200 "$LOG" 2>/dev/null || true; fi
echo "__REPORTS__"
N_LIVE=$(docker exec "$C" sh -c 'ls -1t ${RUNS_DIR_LIVE}/scE_*.json 2>/dev/null | wc -l' || echo 0)
N_DRY=$(docker exec "$C" sh -c 'ls -1t ${RUNS_DIR_DRY}/scE_*.json 2>/dev/null | wc -l' || echo 0)
echo "$N_LIVE $N_DRY"
echo "__SUMMARY_LIVE__"
docker exec "$C" sh -c 'ls -1t ${RUNS_DIR_LIVE}/summary_*.json 2>/dev/null | head -n1' || true
echo "__SUMMARY_DRY__"
docker exec "$C" sh -c 'ls -1t ${RUNS_DIR_DRY}/summary_*.json 2>/dev/null | head -n1' || true
`.trim();

  try {
    const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');
    const blob = await ssh(`echo ${b64} | base64 -d | bash`, 35_000);

    const logMatch = blob.match(/__LOG__=(.*)/);
    if (logMatch?.[1]?.trim()) logPathUsed = logMatch[1].trim();

    const alivePart = blob.split('__ALIVE__')[1]?.split('__LOGTAIL__')[0] || '';
    alive = /scalp-(live|dry)\.js/.test(alivePart);
    procLine =
      alivePart
        .trim()
        .split(/\r?\n/)
        .find((l) => /scalp-(live|dry)/.test(l)) || null;

    logText = blob.split('__LOGTAIL__')[1]?.split('__REPORTS__')[0] || '';
    const reportsRaw = (blob.split('__REPORTS__')[1]?.split('__SUMMARY_LIVE__')[0] || '').trim();
    const counts = reportsRaw.split(/\s+/).map((x) => Number(x) || 0);
    reportsLiveN = counts[0] || 0;
    reportsDryN = counts[1] || 0;

    sumLiveFile = (blob.split('__SUMMARY_LIVE__')[1]?.split('__SUMMARY_DRY__')[0] || '')
      .trim()
      .split(/\r?\n/)[0]
      ?.trim() || '';
    sumDryFile = (blob.split('__SUMMARY_DRY__')[1] || '').trim().split(/\r?\n/)[0]?.trim() || '';
  } catch (err) {
    error = String(err?.message || err);
  }

  const parsed = parseLog(logText);
  if (procLine) parsed.live.procLine = procLine;
  const isLive =
    /scalp-live/.test(procLine || '') ||
    /live\.log/.test(logPathUsed) ||
    parsed.live.isLive ||
    parsed.config.mode === 'LIVE';
  if (isLive) {
    parsed.live.isLive = true;
    parsed.config.mode = 'LIVE';
    reportsN = reportsLiveN;
  } else {
    if (!parsed.config.mode) parsed.config.mode = 'DRY';
    reportsN = reportsDryN;
  }

  const sumFile = isLive ? sumLiveFile : sumDryFile;
  if (sumFile) {
    try {
      const catScript = `docker exec ${CONTAINER} cat '${sumFile}'`;
      const catB64 = Buffer.from(catScript, 'utf8').toString('base64');
      const raw = await ssh(`echo ${catB64} | base64 -d | bash`, 20_000);
      const parsedSum = JSON.parse(raw);
      const sumIsLive = parsedSum?.live === true || parsedSum?.dry === false;
      const sumIsDry = parsedSum?.dry === true || parsedSum?.live === false;
      if (isLive && sumIsLive) summary = parsedSum;
      else if (!isLive && sumIsDry) summary = parsedSum;
      else if (isLive && !sumIsDry && sumIsLive !== false && parsedSum?.strategy) {
        // live summary sem flags explícitas
        if (String(sumFile).includes('binance-lead-scalp-live')) summary = parsedSum;
      } else if (!isLive && String(sumFile).includes('binance-lead-scalp-dry')) {
        summary = parsedSum;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    fetchedAt,
    alive,
    logPath: logPathUsed,
    container: CONTAINER,
    reportsN,
    reportsLiveN,
    reportsDryN,
    error,
    ...parsed,
    summary,
    logTail: String(logText || '')
      .split(/\r?\n/)
      .slice(-60)
      .join('\n'),
  };
}

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Scalp Adapt+Rescue</title>
<style>
  :root {
    --bg: #0f1216;
    --panel: #171c23;
    --line: #2a3340;
    --text: #e7eef6;
    --muted: #8795a8;
    --win: #3dd68c;
    --loss: #ff6b6b;
    --run: #e8b84a;
    --accent: #6aa6d8;
    --rescue: #c084fc;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(1200px 500px at 10% -10%, #1a2433 0%, var(--bg) 55%);
    color: var(--text);
    min-height: 100vh;
  }
  header {
    padding: 16px 22px 10px;
    display: flex; flex-wrap: wrap; gap: 12px 20px;
    align-items: baseline; justify-content: space-between;
    border-bottom: 1px solid var(--line);
  }
  h1 { margin: 0; font-size: 1.2rem; font-weight: 650; letter-spacing: -0.02em; }
  .meta { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border: 1px solid var(--line);
    background: var(--panel); font-size: 0.84rem;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--win); box-shadow: 0 0 8px rgba(61,214,140,.45); }
  .dot.off { background: var(--loss); }
  main { padding: 14px 22px 28px; display: grid; gap: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
  .stat { background: var(--panel); border: 1px solid var(--line); padding: 10px 12px; }
  .stat .k { color: var(--muted); font-size: 0.66rem; text-transform: uppercase; letter-spacing: .05em; }
  .stat .v { font-size: 1.2rem; font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .stat .v.win { color: var(--win); } .stat .v.loss { color: var(--loss); } .stat .v.rescue { color: var(--rescue); }
  .grid2 { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  @media (max-width: 1100px) { .grid2, .grid3 { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--line); padding: 12px 14px; }
  section h2 {
    margin: 0 0 10px; font-size: 0.74rem; font-weight: 600;
    color: var(--muted); text-transform: uppercase; letter-spacing: .06em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th, td { text-align: left; padding: 6px 5px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 0.68rem; text-transform: uppercase; }
  .badge { display: inline-block; padding: 2px 7px; font-size: 0.7rem; font-weight: 600; border: 1px solid var(--line); }
  .badge.done.win { color: var(--win); border-color: var(--win); }
  .badge.done.loss { color: var(--loss); border-color: var(--loss); }
  .badge.running, .badge.in_trade, .badge.active { color: var(--run); border-color: var(--run); }
  .badge.rescue { color: var(--rescue); border-color: var(--rescue); }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 0.68rem; line-height: 1.45; color: #c5d0db;
    max-height: 320px; overflow: auto;
  }
  .live-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(95px, 1fr)); gap: 8px; }
  .live-row .k { color: var(--muted); font-size: 0.68rem; }
  .live-row .v { font-weight: 600; margin-top: 2px; font-size: 0.88rem; }
  .err { color: var(--loss); font-size: 0.84rem; margin-top: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips span {
    border: 1px solid var(--line); padding: 4px 8px; font-size: 0.76rem; color: var(--muted);
  }
  .chips span b { color: var(--text); font-weight: 650; }
  .cfg { font-size: 0.8rem; color: var(--muted); line-height: 1.5; }
  .cfg b { color: var(--text); }
</style>
</head>
<body>
<header>
  <div>
    <h1 id="title">Scalp Adapt + Rescue</h1>
    <div class="meta" id="subtitle">Giovanna · pair-path-micro · auto-refresh</div>
  </div>
  <div class="pill"><span id="aliveDot" class="dot"></span><span id="aliveLabel">checando…</span></div>
</header>
<main>
  <section>
    <h2>Config ativa (do log)</h2>
    <div class="cfg" id="config">—</div>
  </section>
  <div class="stats" id="stats"></div>
  <div class="grid3">
    <section>
      <h2>Saídas (exit reasons)</h2>
      <div class="chips" id="reasons"></div>
    </section>
    <section>
      <h2>Skips (último motivo no hb)</h2>
      <div class="chips" id="skips"></div>
    </section>
    <section>
      <h2>Resgate</h2>
      <div class="chips" id="rescueStats"></div>
    </section>
  </div>
  <div class="grid2">
    <section>
      <h2>Ao vivo</h2>
      <div class="live-row" id="live"></div>
      <div id="err" class="err"></div>
    </section>
    <section>
      <h2>Eventos</h2>
      <div style="overflow:auto; max-height:300px">
        <table>
          <thead>
            <tr><th>#</th><th>Slug</th><th>Status</th><th>In</th><th>R</th><th>Out</th><th>Líquido</th><th>WR</th></tr>
          </thead>
          <tbody id="events"></tbody>
        </table>
      </div>
    </section>
  </div>
  <section>
    <h2>Fluxo recente (intent → enter → rescue → exit)</h2>
    <div style="overflow:auto; max-height:300px">
      <table>
        <thead>
          <tr><th>Evt</th><th>Tipo</th><th>Side</th><th>Detalhe</th><th>PnL</th></tr>
        </thead>
        <tbody id="trades"></tbody>
      </table>
    </div>
  </section>
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
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2);
}
function chips(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<span>sem dados</span>';
  return entries
    .sort((a,b) => b[1]-a[1])
    .map(([k,v]) => '<span>'+k+': <b>'+v+'</b></span>')
    .join('');
}
async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const alive = !!data.alive;
    const isLive = !!(data.live?.isLive || data.config?.mode === 'LIVE');
    const modeTag = isLive ? 'LIVE $$' : 'DRY';
    const dot = document.getElementById('aliveDot');
    const label = document.getElementById('aliveLabel');
    dot.className = 'dot ' + (alive ? 'on' : 'off');
    label.textContent = alive
      ? (data.live?.waiting
          ? modeTag + ' · aguardando janela'
          : (data.live?.inRescue ? modeTag + ' · em resgate' : modeTag + ' · ativo'))
      : (data.stats?.trades ? modeTag + ' parado / concluído' : 'processo não encontrado');
    document.getElementById('title').textContent =
      'Scalp Adapt + Rescue · ' + (isLive ? 'LIVE' : 'Dry');

    const cfg = data.config || {};
    document.getElementById('config').innerHTML =
      '<b>mode</b>='+(cfg.mode || (isLive ? 'LIVE' : 'DRY'))+
      ' · <b>variant</b>='+(cfg.variant||'—')+
      ' · <b>impulse</b>='+(cfg.impulse||'—')+
      ' · <b>stale</b>≤'+(cfg.stale ?? '—')+
      ' · <b>ladder</b>+'+(cfg.ladder||'—')+
      ' · <b>stop</b>=-'+(cfg.stop ?? '—')+
      ' · <b>timeout</b>='+(cfg.timeout ?? '—')+'s'+
      ' · <b>rescue</b>='+(cfg.rescue || 'off')+
      ' · <b>fill</b>='+(cfg.fill||'—')+
      ' · <b>budget</b>=$'+(cfg.budget ?? '—')+
      (cfg.sessionNotional != null ? ' · <b>sessNotional</b>≤$'+cfg.sessionNotional : '')+
      (cfg.sessionLoss != null ? ' · <b>sessLoss</b>≤$'+cfg.sessionLoss : '');
    document.getElementById('subtitle').textContent =
      'Giovanna · '+ (data.container||'pair-path-micro') +
      ' · ' + (cfg.variant || 'scalp') +
      ' · budget $' + (cfg.budget ?? '—') +
      ' · ' + (isLive ? 'ORDENS REAIS' : 'zero ordens') +
      ' · poll ' + (POLL_MS/1000) + 's';

    const st = data.stats || {};
    const pnlClass = st.lucroLiquido > 0 ? 'win' : (st.lucroLiquido < 0 ? 'loss' : '');
    const stats = [
      ['Eventos', (st.eventsDone ?? 0) + '/' + (data.live?.maxEvents ?? st.eventsSeen ?? '—'), ''],
      ['Trades', st.trades ?? 0, ''],
      ['Enters', st.enters ?? 0, ''],
      ['WR', st.winRate != null ? st.winRate + '%' : '—', ''],
      ['Líquido', money(st.lucroLiquido), pnlClass],
      ['Bruto', money(st.lucroBruto), ''],
      ['Taxas', st.fees != null ? '$' + fmt(st.fees, 2) : '—', ''],
      ['PF', st.profitFactor == null ? '—' : st.profitFactor, ''],
      ['Avg PnL', money(st.avgPnl), ''],
      ['Avg hold', st.avgHold != null ? st.avgHold + 's' : '—', ''],
      ['Rescue in', st.rescueEnters ?? 0, 'rescue'],
      ['Thr agora', data.live?.thr != null ? '$' + fmt(data.live.thr, 2) : '—', ''],
    ];
    document.getElementById('stats').innerHTML = stats.map(([k,v,cls]) =>
      '<div class="stat"><div class="k">'+k+'</div><div class="v '+cls+'">'+v+'</div></div>'
    ).join('');

    document.getElementById('reasons').innerHTML = chips(st.exitReasons);
    document.getElementById('skips').innerHTML = chips(data.skipHist);
    document.getElementById('rescueStats').innerHTML = [
      ['enters', st.rescueEnters ?? 0],
      ['rescue_full', (st.rescueFull ?? 0) + ' (' + money(st.rescueFullPnl) + ')'],
      ['rescue_eod', (st.rescueEod ?? 0) + ' (' + money(st.rescueEodPnl) + ')'],
      ['ladder_full', (st.ladderFull ?? 0) + ' (' + money(st.ladderFullPnl) + ')'],
    ].map(([k,v]) => '<span>'+k+': <b>'+v+'</b></span>').join('');

    const lv = data.live || {};
    document.getElementById('live').innerHTML = [
      ['Evento', (lv.eventIndex && lv.maxEvents) ? (lv.eventIndex + '/' + lv.maxEvents) : '—'],
      ['Slug', lv.slug ? String(lv.slug).replace(/^btc-updown-5m-/, '…') : '—'],
      ['τ', lv.tau != null ? lv.tau + 's' : '—'],
      ['Thr σ', lv.thr != null ? '$' + fmt(lv.thr, 2) : '—'],
      ['UP', (lv.upAsk!=null) ? (fmt(lv.upAsk,2)+'/'+fmt(lv.upBid,2)) : '—'],
      ['DN', (lv.dnAsk!=null) ? (fmt(lv.dnAsk,2)+'/'+fmt(lv.dnBid,2)) : '—'],
      ['Binance', lv.bn != null ? fmt(lv.bn, 1) : '—'],
      ['Open', lv.open || '—'],
      ['Resgate?', lv.inRescue ? 'SIM' : 'não'],
      ['Skip', lv.skip || '—'],
      ['Blocks', lv.blocks || '—'],
      ['Book lag', lv.bookLag != null ? lv.bookLag + 'ms' : '—'],
      ['Spot age', lv.spotAge != null ? lv.spotAge + 'ms' : '—'],
      ['Fresh', lv.fresh == null ? '—' : String(lv.fresh)],
      ['PnL evt', money(lv.pnl)],
      ['Trades evt', lv.tradesN ?? 0],
    ].map(([k,v]) => '<div><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');

    document.getElementById('err').textContent = data.error || '';

    const rows = (data.events || []).slice().reverse().map(e => {
      const win = e.pnl != null && e.pnl > 0;
      const badgeCls = 'badge ' + e.status + (e.status === 'done' ? (win ? ' win' : ' loss') : '');
      return '<tr>' +
        '<td>'+e.index+'</td>' +
        '<td>'+(e.slug || '—').replace(/^btc-updown-5m-/, '…')+'</td>' +
        '<td><span class="'+badgeCls+'">'+e.status+'</span></td>' +
        '<td>'+(e.enters ?? 0)+'</td>' +
        '<td>'+(e.rescues ?? 0)+'</td>' +
        '<td>'+(e.trades ?? 0)+'</td>' +
        '<td style="color:'+(e.pnl>0?'var(--win)':(e.pnl<0?'var(--loss)':'inherit'))+'">'+(e.pnl!=null?money(e.pnl):'—')+'</td>' +
        '<td>'+(e.wr != null ? e.wr + '%' : '—')+'</td>' +
        '</tr>';
    }).join('');
    document.getElementById('events').innerHTML = rows || '<tr><td colspan="8">sem eventos ainda</td></tr>';

    const trows = (data.trades || []).slice().reverse().slice(0, 60).map(t => {
      let detail = '—';
      if (t.type === 'intent') detail = 'ask='+fmt(t.px,3)+' Δ$'+fmt(t.binRet,1)+' thr=$'+fmt(t.thr,2)+' τ='+t.tau;
      if (t.type === 'enter') detail = '@'+fmt(t.px,3)+' sh='+fmt(t.shares,1)+
        (t.realPx!=null?' real='+fmt(t.realPx,3):'')+
        (t.binRet!=null?' Δ$'+fmt(t.binRet,1):'')+
        (t.thr!=null?' thr=$'+fmt(t.thr,2):'')+
        ' L='+t.ladder;
      if (t.type === 'fill_px') detail = 'real='+fmt(t.realPx,3)+' limit='+fmt(t.limitPx,3)+' sh='+fmt(t.shares,1);
      if (t.type === 'fallback') detail = 'maker @'+fmt(t.px,3)+' sh='+fmt(t.shares,1)+' (ladder fail)';
      if (t.type === 'rescue') detail = 'trigger='+t.trigger+' entry='+fmt(t.entry,3)+' → ask '+fmt(t.ask,3)+' rem='+fmt(t.rem,1);
      if (t.type === 'exit') detail = t.reason +
        (t.exitPx!=null?' exit≈'+fmt(t.exitPx,3):'')+
        (t.hold!=null?' hold='+fmt(t.hold,1)+'s':'')+
        (t.makerSh!=null?' m/t='+fmt(t.makerSh,1)+'/'+fmt(t.takerSh,1):'');
      const typeColor = t.type === 'rescue' ? 'var(--rescue)' : (t.type === 'exit' ? 'inherit' : 'var(--accent)');
      return '<tr>' +
        '<td>'+(t.event ?? '—')+'</td>' +
        '<td style="color:'+typeColor+'">'+t.type+'</td>' +
        '<td>'+(t.side || '—')+'</td>' +
        '<td>'+detail+'</td>' +
        '<td style="color:'+(t.pnl>0?'var(--win)':(t.pnl<0?'var(--loss)':'inherit'))+'">'+(t.pnl!=null?money(t.pnl):'—')+'</td>' +
        '</tr>';
    }).join('');
    document.getElementById('trades').innerHTML = trows || '<tr><td colspan="5">sem fluxo ainda</td></tr>';

    document.getElementById('log').textContent = data.logTail || '(vazio)';
    const sumNote = data.summary
      ? (' · summary ' + (data.summary.live ? 'LIVE' : 'DRY') +
         ' liquido=' + money(data.summary.lucroLiquido) +
         ' trades=' + (data.summary.trades ?? '—'))
      : ' · summary —';
    document.getElementById('footer').textContent =
      'Atualizado ' + data.fetchedAt +
      ' · ' + modeTag +
      ' · log ' + data.logPath +
      ' · reports ' + (data.reportsN ?? 0) +
      sumNote +
      (data.live?.procLine ? ' · ' + data.live.procLine.trim().replace(/\\s+/g,' ').slice(0,100) : '');
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
  console.log(`[scalp-e-dashboard] http://${HOST}:${PORT}`);
  console.log(`[scalp-e-dashboard] SSH ${SSH_HOST} · ${CONTAINER} · prefer ${LOG_PATH}`);
  console.log('[scalp-e-dashboard] read-only — não para o dry remoto');
});
