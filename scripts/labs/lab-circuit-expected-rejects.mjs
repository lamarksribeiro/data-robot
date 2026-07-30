/**
 * Lab unitário: política de circuit sob rejects esperados.
 * Roda sem audits — prova mecânica baseline vs proposed.
 *
 *   node scripts/labs/lab-circuit-expected-rejects.mjs
 */
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../../src/risk/circuitBreaker.js';

const EXPECTED = [
  'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
  'order 0xabc is invalid. Size (2) lower than the minimum: 5',
  'post-only mode: only post-only orders and cancels are allowed',
];

function isExpected(reason) {
  const r = String(reason).toLowerCase();
  return (
    /no orders found to match with fak/.test(r) ||
    /lower than the minimum|minimum:\s*\d/.test(r) ||
    /post-only mode/.test(r) ||
    /couldn't be fully filled/.test(r)
  );
}

function shouldRecordFailure(kind, reason, policy) {
  if (policy === 'baseline') return true;
  // proposed: expected CLOB business rejects não abrem circuit
  if (isExpected(reason)) return false;
  // proposed: EXIT/REVERSE nunca abrem circuit por reject (proteção)
  if (kind === 'EXIT' || kind === 'REVERSE') return false;
  return true;
}

function shouldAllowProtective(kind, circuitEval, policy) {
  if (policy === 'proposed' && (kind === 'EXIT' || kind === 'REVERSE')) return true;
  return circuitEval.allow;
}

function runPolicy(policy) {
  let now = 0;
  const circuit = createCircuitBreaker({
    failureThreshold: 5,
    cooldownMs: 60_000,
    clock: () => now,
  });
  const timeline = [];

  // 5 FAK miss ENTER
  for (let i = 0; i < 5; i += 1) {
    now += 100;
    const reason = EXPECTED[0];
    if (shouldRecordFailure('ENTER', reason, policy)) circuit.recordFailure();
    timeline.push({ now, kind: 'ENTER', recorded: shouldRecordFailure('ENTER', reason, policy), state: circuit.state });
  }

  // REVERSE protetivo
  now += 100;
  const revEval = circuit.evaluate();
  const revAllow = shouldAllowProtective('REVERSE', revEval, policy);
  timeline.push({ now, kind: 'REVERSE', allow: revAllow, circuitAllow: revEval.allow, state: circuit.state });

  // EXIT minSize (expected)
  now += 100;
  const minReason = EXPECTED[1];
  if (shouldRecordFailure('EXIT', minReason, policy)) circuit.recordFailure();
  const exitEval = circuit.evaluate();
  const exitAllow = shouldAllowProtective('EXIT', exitEval, policy);
  timeline.push({
    now,
    kind: 'EXIT',
    allow: exitAllow,
    recorded: shouldRecordFailure('EXIT', minReason, policy),
    state: circuit.state,
  });

  // ENTER balance real (should still record in both — real risk)
  now += 100;
  const bal = 'not enough balance / allowance';
  if (shouldRecordFailure('ENTER', bal, policy)) circuit.recordFailure();
  timeline.push({
    now,
    kind: 'ENTER',
    reason: 'balance',
    recorded: shouldRecordFailure('ENTER', bal, policy),
    state: circuit.state,
  });

  return {
    policy,
    reverseAllowed: revAllow,
    exitAllowed: exitAllow,
    circuitAfterFakMiss: timeline.find((t) => t.kind === 'REVERSE')?.state,
    timeline,
  };
}

const baseline = runPolicy('baseline');
const proposed = runPolicy('proposed');

assert.equal(baseline.reverseAllowed, false, 'baseline deve bloquear REVERSE após 5 FAK miss');
assert.equal(proposed.reverseAllowed, true, 'proposed deve permitir REVERSE');
assert.equal(proposed.exitAllowed, true, 'proposed deve permitir EXIT');

const report = {
  ok: true,
  baseline: {
    reverseAllowed: baseline.reverseAllowed,
    exitAllowed: baseline.exitAllowed,
    circuitAfterFakMiss: baseline.circuitAfterFakMiss,
  },
  proposed: {
    reverseAllowed: proposed.reverseAllowed,
    exitAllowed: proposed.exitAllowed,
    circuitAfterFakMiss: proposed.circuitAfterFakMiss,
  },
  helps: proposed.reverseAllowed && !baseline.reverseAllowed,
  conclusion:
    'Não contar FAK miss/minSize no circuit + bypass EXIT/REVERSE desbloqueia proteção após misses de entrada.',
};

console.log(JSON.stringify(report, null, 2));
