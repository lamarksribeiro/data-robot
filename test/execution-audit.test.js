import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { createExecutionAudit } from '../src/observability/executionAudit.js';

describe('executionAudit.listRecent filters', () => {
  let dir;
  let audit;
  let t = 1_700_000_000_000;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-audit-'));
    audit = createExecutionAudit({
      dir,
      clock: () => {
        t += 1000;
        return t;
      },
    });
    audit.append('decision', { marketId: 'm1', intentCount: 1 });
    audit.append('checkpoint', { state: 'RUNNING' });
    audit.append('operator_action', { action: 'arm', ok: true });
    audit.append('operator_action', { action: 'pause', ok: false, reason: 'busy' });
    audit.append('protective_halt', { reason: 'market-rotated' });
    audit.append('decision', { marketId: 'm2', intentCount: 0 });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aceita limit numérico (compat)', () => {
    const rows = audit.listRecent(3);
    assert.equal(rows.length, 3);
  });

  it('excludeTypes remove decision/checkpoint', () => {
    const rows = audit.listRecent({
      limit: 50,
      excludeTypes: 'decision,checkpoint',
    });
    assert.ok(rows.every((r) => r.type !== 'decision' && r.type !== 'checkpoint'));
    assert.ok(rows.some((r) => r.type === 'operator_action'));
    assert.ok(rows.some((r) => r.type === 'protective_halt'));
  });

  it('filtra por type e action', () => {
    const rows = audit.listRecent({
      limit: 50,
      types: 'operator_action',
      action: 'arm',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'arm');
    assert.equal(rows[0].ok, true);
  });

  it('filtra por ok=false', () => {
    const rows = audit.listRecent({ limit: 50, ok: false });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'pause');
  });

  it('busca q no JSON', () => {
    const rows = audit.listRecent({ limit: 50, q: 'market-rotated' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'protective_halt');
  });

  it('limit aplica após filtros', () => {
    const rows = audit.listRecent({
      limit: 2,
      excludeTypes: 'decision,checkpoint',
    });
    assert.equal(rows.length, 2);
  });
});
