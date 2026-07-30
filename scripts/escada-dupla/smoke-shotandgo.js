#!/usr/bin/env node
import { createShotandgoState, onTick, summarize, profileParams } from './shotandgo-engine.js';

const p = profileParams('hybrid', { fillMode: 'cruel', X: 5 });
if (p.takerSlipCents < 1) throw new Error('cruel needs slip');
if (p.depthUnknownCap == null) throw new Error('cruel needs depthUnknownCap');

const st = createShotandgoState({ profile: 'hybrid', X: 5, fillMode: 'cruel' });
// opp too expensive
onTick(st, { UP: 0.55, DOWN: 0.5 }, 200, Date.now(), { UP: 20, DOWN: 20 });
if (st.fills.length !== 0) throw new Error('should block OPEN_DESC_NOT_READY');

// ready + depth — pending latency, then fill
const t0 = Date.now();
onTick(st, { UP: 0.55, DOWN: 0.4 }, 199, t0, { UP: 2, DOWN: 10 });
onTick(st, { UP: 0.56, DOWN: 0.39 }, 198, t0 + 100, { UP: 2, DOWN: 10 });
const s = summarize(st);
console.log(JSON.stringify({
  fills: s.counts.subFills,
  depthMiss: s.counts.depthMisses,
  pending: st.pending.length,
  invested: s.invested,
  slip: st.fills[0]?.px,
}, null, 2));
if (s.counts.subFills < 1 && st.pending.length < 1) {
  console.error('expected pending or fill');
  process.exit(1);
}
// EQ mop-up should be depth-capped (not full 10@0.04)
const st2 = createShotandgoState({ profile: 'hybrid', X: 5, fillMode: 'cruel', decisionLatencyMs: 0 });
st2.inv.UP = { shares: 10, cost: 6, fees: 0 };
st2.inv.DOWN = { shares: 0, cost: 0, fees: 0 };
st2.escadaArmada = true;
st2.mode = 'active';
onTick(st2, { UP: 0.9, DOWN: 0.04 }, 10, Date.now(), { UP: 50, DOWN: 2 });
const s2 = summarize(st2);
console.log('eq-partial', { eq: s2.equalizou, downSh: st2.inv.DOWN.shares, hint: s2.verdictHint });
if (st2.inv.DOWN.shares > 2.01) {
  console.error('cruel EQ should respect depth=2');
  process.exit(1);
}
console.log('shotandgo cruel smoke ok');
