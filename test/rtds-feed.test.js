import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketState } from '../src/feeds/marketState.js';
import { startRtdsFeed } from '../src/feeds/rtdsFeed.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.terminated = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  static reset() {
    FakeWebSocket.instances = [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('rtdsFeed stale watchdog', () => {
  it('força reconnect quando o socket fica aberto sem ticks', async () => {
    FakeWebSocket.reset();
    let nowMs = 1_000_000;
    const state = createMarketState();
    const staleEvents = [];

    const stop = startRtdsFeed(state, {
      WebSocket: FakeWebSocket,
      clock: () => nowMs,
      staleMs: 50,
      watchdogMs: 20,
      onStaleReconnect: (info) => staleEvents.push(info),
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    const first = FakeWebSocket.instances[0];
    first.open();
    assert.equal(state.wsRtdsConnected, true);

    first.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { value: '100', timestamp: String(nowMs) },
    });
    assert.equal(state.btc, 100);
    assert.equal(state.rtdsReceivedAt, nowMs);

    nowMs += 120;
    await sleep(80);

    assert.ok(staleEvents.length >= 1);
    assert.equal(staleEvents[0].reason, 'RTDS_STALE');
    assert.equal(first.terminated, true);
    assert.equal(state.wsRtdsConnected, false);

    await sleep(600);
    assert.ok(FakeWebSocket.instances.length >= 2);
    const second = FakeWebSocket.instances[1];
    second.open();
    second.emitMessage({
      topic: 'crypto_prices_chainlink',
      payload: { value: '101.5', timestamp: String(nowMs) },
    });
    assert.equal(state.btc, 101.5);
    assert.equal(state.wsRtdsConnected, true);

    stop();
  });

  it('não reconecta enquanto os ticks continuam frescos', async () => {
    FakeWebSocket.reset();
    let nowMs = 2_000_000;
    const state = createMarketState();
    const staleEvents = [];

    const stop = startRtdsFeed(state, {
      WebSocket: FakeWebSocket,
      clock: () => nowMs,
      staleMs: 80,
      watchdogMs: 20,
      onStaleReconnect: (info) => staleEvents.push(info),
    });

    const socket = FakeWebSocket.instances[0];
    socket.open();
    for (let i = 0; i < 4; i += 1) {
      nowMs += 30;
      socket.emitMessage({
        topic: 'crypto_prices_chainlink',
        payload: { value: String(200 + i), timestamp: String(nowMs) },
      });
      await sleep(25);
    }

    assert.equal(staleEvents.length, 0);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(state.wsRtdsConnected, true);
    stop();
  });
});
