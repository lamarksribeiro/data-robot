import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  RUN_SCHEMA_VERSION,
  buildRunEnvelope,
  sanitizeRunRecord,
  redactValue,
} from '../src/runs/schema.js';
import { hasLiveFlag } from '../src/cli/liveGate.js';

describe('runs schema', () => {
  it('envelope inclui schemaVersion', () => {
    const env = buildRunEnvelope({ kind: 'watch', runId: 'x' });
    assert.equal(env.schemaVersion, RUN_SCHEMA_VERSION);
    assert.equal(env.kind, 'watch');
    assert.equal(env.live, false);
  });

  it('redacta secrets', () => {
    const cleaned = redactValue({
      apiSecret: 'shh',
      note: 'ok',
      nested: { passphrase: 'x', value: '0x' + 'a'.repeat(64) },
    });
    assert.equal(cleaned.apiSecret, '[REDACTED]');
    assert.equal(cleaned.note, 'ok');
    assert.equal(cleaned.nested.passphrase, '[REDACTED]');
    assert.equal(cleaned.nested.value, '[REDACTED]');
  });

  it('sanitize injeta schemaVersion se ausente', () => {
    const out = sanitizeRunRecord({ kind: 'latency' });
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.kind, 'latency');
  });
});

describe('liveGate', () => {
  it('detecta --live', () => {
    assert.equal(hasLiveFlag(['node', 'x.js', '--live']), true);
    assert.equal(hasLiveFlag(['node', 'x.js']), false);
  });

  it('tfc:latency sem --live sai com código 2', () => {
    const r = spawnSync(process.execPath, ['scripts/tfc/measure-order-latency.js'], {
      encoding: 'utf8',
      env: { ...process.env, POLYMARKET_PRIVATE_KEY: '' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--live/);
  });

  it('test:order sem --live sai com código 2', () => {
    const r = spawnSync(process.execPath, ['scripts/place-test-order.js'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--live/);
  });
});
