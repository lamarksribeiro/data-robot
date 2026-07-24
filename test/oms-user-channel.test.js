import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOmsSink } from '../src/oms/omsSink.js';

function createMockUserChannel() {
  const disconnects = new Set();
  const reconnects = new Set();
  let connected = true;
  let lastHeartbeatMs = Date.now();
  return {
    kind: 'ws',
    get connected() {
      return connected;
    },
    get lastHeartbeatMs() {
      return lastHeartbeatMs;
    },
    onEvent() {
      return () => {};
    },
    onDisconnect(fn) {
      disconnects.add(fn);
      return () => disconnects.delete(fn);
    },
    onReconnect(fn) {
      reconnects.add(fn);
      return () => reconnects.delete(fn);
    },
    async connect() {
      connected = true;
      lastHeartbeatMs = Date.now();
      return { ok: true, kind: 'ws' };
    },
    disconnect() {
      connected = false;
    },
    startHeartbeat() {
      return () => {};
    },
    emitDisconnect(detail = { code: 1006 }) {
      connected = false;
      for (const fn of disconnects) fn(detail);
    },
    emitReconnect(detail = {}) {
      connected = true;
      lastHeartbeatMs = Date.now();
      for (const fn of reconnects) fn(detail);
    },
  };
}

describe('omsSink user channel resilience', () => {
  it('não dispara critical imediato em disconnect transitório', async () => {
    const userChannel = createMockUserChannel();
    const critical = [];
    const canceled = [];
    const sink = createOmsSink({
      mode: 'live',
      withUserChannel: false,
      userChannel,
      userDisconnectHaltMs: 60_000,
      transport: {
        cancelAll: async () => {
          canceled.push('all');
          return { accepted: true };
        },
        async startHeartbeat() {
          return () => {};
        },
      },
    });
    sink.onCritical((detail) => critical.push(detail));
    await sink.start();

    userChannel.emitDisconnect({ code: 1006, reason: 'blip' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(canceled.length, 1);
    assert.equal(critical.length, 0);
    assert.equal(sink.lastChannelError?.reason, 'USER_CHANNEL_DISCONNECTED');

    userChannel.emitReconnect({ tsMs: Date.now() });
    assert.equal(sink.lastChannelError, null);
    assert.equal(critical.length, 0);

    sink.dispose();
  });

  it('halt crítico só após disconnect prolongado sem reconnect', async () => {
    const userChannel = createMockUserChannel();
    const critical = [];
    const sink = createOmsSink({
      mode: 'live',
      withUserChannel: false,
      userChannel,
      userDisconnectHaltMs: 40,
      transport: {
        cancelAll: async () => ({ accepted: true }),
        async startHeartbeat() {
          return () => {};
        },
      },
    });
    sink.onCritical((detail) => critical.push(detail));
    await sink.start();

    userChannel.emitDisconnect({ code: 1006 });
    assert.equal(critical.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(critical.length, 1);
    assert.equal(critical[0].reason, 'USER_CHANNEL_DISCONNECTED');

    sink.dispose();
  });
});
