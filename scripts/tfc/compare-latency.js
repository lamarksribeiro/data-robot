#!/usr/bin/env node
/**
 * Compara relatórios de latência local vs servidor (runs/latency-*.json).
 *
 * Uso:
 *   npm run tfc:latency:compare
 *   npm run tfc:latency:compare -- --labels local,giovanna
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    dir: valueOf('--dir') ?? 'runs',
    labels: (valueOf('--labels') ?? 'local,giovanna').split(',').map((s) => s.trim()).filter(Boolean),
    json: args.includes('--json'),
  };
}

function loadReports(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('latency-') && f.endsWith('.json'))
    .map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, ...data };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pickLatestByLabel(reports, labels) {
  const byLabel = {};
  for (const r of reports) {
    const label = r.meta?.label ?? 'unknown';
    if (labels.length && !labels.includes(label)) continue;
    if (!byLabel[label] || (r.meta?.ts ?? '') > (byLabel[label].meta?.ts ?? '')) {
      byLabel[label] = r;
    }
  }
  return byLabel;
}

function metrics(report) {
  const agg = report.aggregateMs ?? report.last?.timingsMs ?? {};
  return {
    label: report.meta?.label ?? '?',
    host: report.meta?.hostname ?? '?',
    ts: report.meta?.ts ?? '?',
    clobPing: agg.clobPingMs ?? report.last?.clobPingMs ?? null,
    create: agg.create ?? agg.timingsMs?.create ?? null,
    getOpen: agg.getOpen ?? agg.timingsMs?.getOpen ?? null,
    cancel: agg.cancel ?? agg.timingsMs?.cancel ?? null,
    total: agg.total ?? agg.timingsMs?.total ?? null,
    repeat: report.aggregateMs?.repeat ?? report.attempts?.length ?? 1,
  };
}

function delta(a, b) {
  if (a == null || b == null) return null;
  return b - a;
}

function fmt(ms) {
  return ms == null ? '—' : `${ms} ms`;
}

function fmtDelta(ms) {
  if (ms == null) return '—';
  const sign = ms > 0 ? '+' : '';
  return `${sign}${ms} ms`;
}

function main() {
  const opts = parseArgs(process.argv);
  const reports = loadReports(opts.dir);
  const latest = pickLatestByLabel(reports, opts.labels);

  const rows = opts.labels.map((label) => metrics(latest[label] ?? { meta: { label } }));

  const baseline = rows.find((r) => r.label === opts.labels[0]);
  const target = rows.find((r) => r.label === opts.labels[1]);

  const comparison = baseline?.total != null && target?.total != null
    ? {
        baseline: opts.labels[0],
        target: opts.labels[1],
        totalDeltaMs: delta(baseline.total, target.total),
        createDeltaMs: delta(baseline.create, target.create),
        improvementPct: baseline.total > 0
          ? Math.round((1 - target.total / baseline.total) * 1000) / 10
          : null,
      }
    : null;

  const output = { rows, comparison, files: Object.fromEntries(
    Object.entries(latest).map(([k, v]) => [k, v.file]),
  ) };

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('=== Comparação de latência ===\n');
  console.log('label      | host           | ping   | create | getOpen | cancel | total  | reps');
  console.log('-----------|----------------|--------|--------|---------|--------|--------|-----');
  for (const r of rows) {
    const host = (r.host ?? '').slice(0, 14).padEnd(14);
    console.log(
      `${r.label.padEnd(10)} | ${host} | ${String(r.clobPing ?? '—').padStart(6)} | ${String(r.create ?? '—').padStart(6)} | ${String(r.getOpen ?? '—').padStart(7)} | ${String(r.cancel ?? '—').padStart(6)} | ${String(r.total ?? '—').padStart(6)} | ${r.repeat}`,
    );
  }

  if (comparison) {
    console.log('');
    console.log(`${comparison.target} vs ${comparison.baseline}:`);
    console.log(`  total:  ${fmtDelta(comparison.totalDeltaMs)} (${comparison.improvementPct}% ${comparison.totalDeltaMs < 0 ? 'mais rápido' : 'mais lento'})`);
    console.log(`  create: ${fmtDelta(comparison.createDeltaMs)}`);
  } else {
    console.log('\nFaltam relatórios. Rode em cada ambiente:');
    console.log(`  npm run tfc:latency -- --label=${opts.labels[0]} --repeat=3`);
    console.log(`  npm run tfc:latency -- --label=${opts.labels[1]} --repeat=3`);
  }

  const missing = opts.labels.filter((l) => !latest[l]);
  if (missing.length) {
    console.log(`\nSem arquivo para: ${missing.join(', ')}`);
  }
}

main();
