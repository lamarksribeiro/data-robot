#!/usr/bin/env node
/**
 * Live audit: ETH (e peers) — dist/ask/z, WR, reverse denied, contrafactual maxDistAbs.
 * Uso:
 *   node scripts/labs/lab-eth-dist-live-audit.mjs
 *   node scripts/labs/lab-eth-dist-live-audit.mjs runs/labs-audit/eth-2026-07-27.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(a, b) {
  return b ? +(100 * (a / b)).toFixed(1) : null;
}

function q(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - i) + s[hi] * (i - lo);
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function analyze(file) {
  const asset = path.basename(file).split('-')[0];
  const rows = readJsonl(file);
  const settles = rows.filter((r) => r.type === 'position_settled');
  const enters = rows.filter((r) => r.type === 'decision' && r.action === 'ENTER');

  const byM = new Map();
  for (const e of enters) {
    const m = e.marketId;
    if (!m) continue;
    const attempt = e.accepted?.[0]?.attempt ?? 1;
    const prev = byM.get(m);
    if (!prev || attempt < (prev.accepted?.[0]?.attempt ?? 99)) byM.set(m, e);
  }

  const joined = settles.map((s) => {
    const e = byM.get(s.marketId);
    const entry = e?.diagnostics?.entry || {};
    const pnl = num(s.pnlDelta);
    return {
      marketId: s.marketId,
      side: s.side,
      winner: s.winner,
      pnl,
      win: pnl != null ? pnl > 0 : null,
      dist: num(entry.dist),
      ask: num(entry.ask),
      z: num(entry.z ?? e?.diagnostics?.z),
      secs: num(e?.diagnostics?.secsLeft),
    };
  });

  const entryRows = [...byM.values()].map((e) => {
    const entry = e.diagnostics?.entry || {};
    return {
      marketId: e.marketId,
      dist: num(entry.dist),
      ask: num(entry.ask),
      z: num(entry.z ?? e.diagnostics?.z),
      secs: num(e.diagnostics?.secsLeft),
      vel: num(entry.gates?.velocity?.value),
    };
  });

  const dists = entryRows.map((e) => e.dist).filter((x) => x != null);
  const asks = entryRows.map((e) => e.ask).filter((x) => x != null);
  const zs = entryRows.map((e) => e.z).filter((x) => x != null);
  const vels = entryRows.map((e) => e.vel).filter((x) => x != null);

  const deniedRev = rows.filter((r) => r.type === 'decision' && r.action === 'denied:REVERSE');
  const revOk = rows.filter((r) => r.type === 'decision' && r.action === 'REVERSE');
  const deniedRevReasons = {};
  for (const r of deniedRev) {
    for (const d of r.denied || []) {
      const c = d.reasonCode || d.kind || '?';
      deniedRevReasons[c] = (deniedRevReasons[c] || 0) + 1;
    }
  }

  const lossLateFlip = [];
  for (const j of joined.filter((x) => x.win === false)) {
    const denied = deniedRev.filter((r) => r.marketId === j.marketId);
    const lfSeen = rows.some(
      (r) =>
        r.marketId === j.marketId &&
        r.type === 'decision' &&
        r.diagnostics?.lateFlip?.active === true,
    );
    lossLateFlip.push({
      marketId: j.marketId,
      pnl: j.pnl,
      dist: j.dist != null ? +j.dist.toFixed(3) : null,
      ask: j.ask,
      z: j.z != null ? +j.z.toFixed(2) : null,
      secs: j.secs != null ? +j.secs.toFixed(1) : null,
      lateFlipSeen: lfSeen,
      deniedReverseN: denied.length,
      deniedReasons: [
        ...new Set(
          denied.flatMap((r) => (r.denied || []).map((d) => d.reasonCode)).filter(Boolean),
        ),
      ],
    });
  }

  const pnlSum = sum(joined.map((j) => j.pnl || 0));
  const thresholds = [0.5, 1.2, 2, 5, 10, 15, 40];
  const cfDist = {};
  for (const t of thresholds) {
    const blocked = joined.filter((j) => j.dist != null && j.dist >= t);
    cfDist[String(t)] = {
      blocked: blocked.length,
      blockedPnl: +sum(blocked.map((j) => j.pnl || 0)).toFixed(3),
      pnlIfSkipBlocked: +(pnlSum - sum(blocked.map((j) => j.pnl || 0))).toFixed(3),
    };
  }

  const cheapLowZ = joined.filter((j) => j.ask != null && j.ask < 0.82 && j.z != null && j.z < 2);

  return {
    asset,
    settlements: {
      n: joined.length,
      wr: pct(
        joined.filter((j) => j.win).length,
        joined.length,
      ),
      pnl: +pnlSum.toFixed(3),
      wins: joined.filter((j) => j.win).length,
      losses: joined.filter((j) => j.win === false).length,
    },
    entryUniqueMarkets: byM.size,
    dist: dists.length
      ? {
          n: dists.length,
          min: +Math.min(...dists).toFixed(4),
          p50: +q(dists, 0.5).toFixed(4),
          p90: +q(dists, 0.9).toFixed(4),
          max: +Math.max(...dists).toFixed(4),
          mean: +(sum(dists) / dists.length).toFixed(4),
          ge1_2_pct: pct(
            dists.filter((d) => d >= 1.2).length,
            dists.length,
          ),
          ge5_pct: pct(
            dists.filter((d) => d >= 5).length,
            dists.length,
          ),
        }
      : null,
    ask: asks.length
      ? { p50: +q(asks, 0.5).toFixed(3), mean: +(sum(asks) / asks.length).toFixed(3) }
      : null,
    z: zs.length
      ? {
          p50: +q(zs, 0.5).toFixed(2),
          mean: +(sum(zs) / zs.length).toFixed(2),
          lt2_pct: pct(
            zs.filter((z) => z < 2).length,
            zs.length,
          ),
        }
      : null,
    velocityAbsMax: vels.length ? +Math.max(...vels.map(Math.abs)).toFixed(4) : null,
    reverse: { ok: revOk.length, denied: deniedRev.length, deniedReasons: deniedRevReasons },
    cheapAskLowZSettled: cheapLowZ.map((j) => ({
      marketId: j.marketId,
      pnl: j.pnl,
      win: j.win,
      ask: j.ask,
      z: j.z != null ? +j.z.toFixed(3) : null,
      dist: j.dist != null ? +j.dist.toFixed(3) : null,
    })),
    cfDist,
    trades: joined.map((j) => ({
      marketId: j.marketId,
      side: j.side,
      win: j.win,
      pnl: j.pnl,
      dist: j.dist != null ? +j.dist.toFixed(3) : null,
      ask: j.ask,
      z: j.z != null ? +j.z.toFixed(2) : null,
      secs: j.secs != null ? +j.secs.toFixed(1) : null,
    })),
    lossLateFlip,
  };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files =
  args.length > 0
    ? args
    : [
        'runs/labs-audit/eth-2026-07-27.jsonl',
        'runs/labs-audit/btc-2026-07-27.jsonl',
        'runs/labs-audit/sol-2026-07-27.jsonl',
        'runs/labs-audit/xrp-2026-07-27.jsonl',
        'runs/labs-audit/doge-2026-07-27.jsonl',
      ].filter((f) => fs.existsSync(f));

console.log(JSON.stringify(files.map((f) => analyze(f)), null, 2));
