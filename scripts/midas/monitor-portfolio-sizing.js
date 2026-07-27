#!/usr/bin/env node
/**
 * Baseline / monitor de sizing portfolio MIDAS no audit live.
 * Uso (no container engine):
 *   node scripts/midas/monitor-portfolio-sizing.js
 *   node scripts/midas/monitor-portfolio-sizing.js --days 2
 */

import fs from 'node:fs';
import path from 'node:path';

const days = Math.max(1, Number(process.argv.find((a, i, arr) => arr[i - 1] === '--days') || 3));
const sinceArg = process.argv.find((a, i, arr) => arr[i - 1] === '--since') || null;
const sinceMs = sinceArg ? Date.parse(sinceArg) : null;
const root =
  process.env.ENGINE_AUDIT_DIR ||
  path.join(process.env.ENGINE_STATE_DIR || 'runs', 'instances');

function listAuditFiles() {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const inst of fs.readdirSync(root)) {
    const auditDir = path.join(root, inst, 'execution-audit');
    if (!fs.existsSync(auditDir)) continue;
    for (const name of fs.readdirSync(auditDir)) {
      if (!/^engine-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      out.push({ inst, file: path.join(auditDir, name), day: name.slice(7, 17) });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

const cutoff = new Date();
cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
const cutoffDay = cutoff.toISOString().slice(0, 10);

const enters = [];
const exposureBlocks = [];
const settles = [];

for (const { inst, file, day } of listAuditFiles()) {
  if (day < cutoffDay) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'order_terminal' && row.filled === true && String(row.kind).toUpperCase() === 'ENTER') {
      const price = Number(row.price);
      const qty = Number(row.qty);
      if (![price, qty].every(Number.isFinite) || qty <= 0) continue;
      if (Number.isFinite(sinceMs) && Number(row.tsMs) < sinceMs) continue;
      enters.push({
        inst,
        day,
        ts: row.tsMs,
        marketId: row.marketId,
        price,
        qty,
        cost: price * qty,
      });
    }
    if (row.type === 'position_settled') {
      if (Number.isFinite(sinceMs) && Number(row.tsMs) < sinceMs) continue;
      settles.push({
        inst,
        day,
        marketId: row.marketId,
        pnlDelta: Number(row.pnlDelta),
        qty: Number(row.qty),
        avgPrice: Number(row.avgPrice),
      });
    }
    const reason = String(row.reason || row.code || row.riskReason || '');
    if (/MAX_ACCOUNT_EXPOSURE|maxAccountExposure/i.test(reason) || /MAX_ACCOUNT_EXPOSURE/i.test(JSON.stringify(row))) {
      if (Number.isFinite(sinceMs) && Number(row.tsMs) < sinceMs) continue;
      exposureBlocks.push({ inst, day, ts: row.tsMs, type: row.type, reason });
    }
  }
}

function summarize(list) {
  if (!list.length) return null;
  const costs = list.map((e) => e.cost).sort((a, b) => a - b);
  const avg = costs.reduce((s, x) => s + x, 0) / costs.length;
  return {
    n: list.length,
    cost_min: +Math.min(...costs).toFixed(3),
    cost_p50: +costs[Math.floor(costs.length / 2)].toFixed(3),
    cost_max: +Math.max(...costs).toFixed(3),
    cost_avg: +avg.toFixed(3),
    ask_avg: +(list.reduce((s, e) => s + e.price, 0) / list.length).toFixed(3),
    overBudget4: list.filter((e) => e.cost > 4.01).length,
    overBudget3_75: list.filter((e) => e.cost > 3.76).length,
  };
}

const byInst = {};
for (const e of enters) {
  byInst[e.inst] = byInst[e.inst] || [];
  byInst[e.inst].push(e);
}

const report = {
  generatedAt: new Date().toISOString(),
  days,
  cutoffDay,
  since: sinceArg,
  enters: summarize(enters),
  byInstance: Object.fromEntries(Object.entries(byInst).map(([k, v]) => [k, summarize(v)])),
  settles: {
    n: settles.length,
    sumPnlDelta: +settles.reduce((s, x) => s + (Number.isFinite(x.pnlDelta) ? x.pnlDelta : 0), 0).toFixed(3),
  },
  exposureBlocks: exposureBlocks.length,
  exposureBlockSamples: exposureBlocks.slice(-5),
  ok:
    enters.length === 0 ||
    (summarize(enters).cost_max <= 4.05 && summarize(enters).overBudget4 === 0),
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 2);
