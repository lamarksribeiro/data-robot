import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseProtection,
  evaluateProtectTriggers,
  parseProtectMode,
  protectionCosts,
} from '../scripts/pair-path/protect-policy.js';

test('valida modos de proteção', () => {
  assert.equal(parseProtectMode('MIN'), 'min');
  assert.throws(() => parseProtectMode('unknown'), /off\|sell\|hedge\|min/);
});

test('prefere SELL quando o bid entrega maior valor líquido', () => {
  const costs = protectionCosts({
    openAvg: 0.57,
    bidOpen: 0.5,
    askOpp: 0.55,
  });
  assert.equal(costs.prefer, 'sell');
  assert.ok(costs.sellLossPerShare < costs.hedgeLossPerShare);
});

test('prefere HEDGE quando o oposto fecha mais barato', () => {
  const costs = protectionCosts({
    openAvg: 0.57,
    bidOpen: 0.2,
    askOpp: 0.35,
  });
  assert.equal(costs.prefer, 'hedge');
  assert.ok(costs.hedgeLossPerShare < costs.sellLossPerShare);
});

test('não protege quando o hedge barato normal está disponível', () => {
  const intent = chooseProtection({
    mode: 'min',
    tau: 100,
    tauForceProtect: 20,
    openSide: 'UP',
    openAvg: 0.57,
    residual: 5,
    bidOpen: 0.58,
    askOpp: 0.38,
    cheapHedgeAvailable: true,
  });
  assert.equal(intent, null);
});

test('não protege cedo sem gatilho (spread leve, timeout não atingido)', () => {
  const intent = chooseProtection({
    mode: 'min',
    tau: 100,
    tauForceProtect: 20,
    elapsedSinceOpenSec: 2,
    protectTimeoutSec: 45,
    protectAdverseCents: 4,
    openSide: 'DOWN',
    openAvg: 0.58,
    openOppAsk: 0.43,
    residual: 5,
    bidOpen: 0.57,
    askOpp: 0.43,
    hedgeAskMax: 0.42,
    protectOppBeyondHedge: true,
  });
  assert.equal(intent, null);
});

test('protege após timeout sem hedge barato', () => {
  const intent = chooseProtection({
    mode: 'min',
    tau: 80,
    tauForceProtect: 20,
    elapsedSinceOpenSec: 50,
    protectTimeoutSec: 45,
    openSide: 'DOWN',
    openAvg: 0.58,
    openOppAsk: 0.43,
    residual: 5,
    bidOpen: 0.57,
    askOpp: 0.44,
    hedgeAskMax: 0.42,
  });
  assert.ok(intent);
  assert.equal(intent.trigger, 'timeout');
  assert.equal(intent.force, false);
});

test('protege em movimento adverso do favorito', () => {
  const intent = chooseProtection({
    mode: 'min',
    tau: 100,
    tauForceProtect: 20,
    elapsedSinceOpenSec: 3,
    protectAdverseCents: 4,
    openSide: 'DOWN',
    openAvg: 0.57,
    openOppAsk: 0.43,
    residual: 5,
    bidOpen: 0.52,
    askOpp: 0.44,
    hedgeAskMax: 0.42,
  });
  assert.ok(intent);
  assert.equal(intent.trigger, 'adverse_fav');
});

test('protege quando oposto sobe além do hedgeAskMax desde o open', () => {
  const triggers = evaluateProtectTriggers({
    elapsedSinceOpenSec: 5,
    protectTimeoutSec: 45,
    bidOpen: 0.56,
    openAvg: 0.57,
    protectAdverseCents: 4,
    askOpp: 0.48,
    openOppAsk: 0.43,
    hedgeAskMax: 0.42,
    protectOppBeyondHedge: true,
    tau: 100,
    tauForceProtect: 20,
  });
  assert.equal(triggers.reason, 'adverse_opp');
  assert.equal(triggers.armed, true);
});

test('marca proteção obrigatória na janela final', () => {
  const intent = chooseProtection({
    mode: 'min',
    tau: 15,
    tauForceProtect: 20,
    openSide: 'DOWN',
    openAvg: 0.57,
    residual: 5,
    bidOpen: 0.1,
    askOpp: 0.9,
  });
  assert.equal(intent.force, true);
  assert.equal(intent.trigger, 'force_tau');
  assert.ok(['sell', 'hedge'].includes(intent.action));
});
