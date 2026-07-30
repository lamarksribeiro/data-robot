#!/usr/bin/env node
/** Smoke do motor escada — ticks sintéticos, sem rede. */
import { createLadderState, onTick, summarize } from './ladder-engine.js';

function run(fillMode) {
  const st = createLadderState({
    fillMode,
    subLevels: [55, 60, 65],
    descLevels: [45, 40, 35],
    sharesSub: [5, 5, 5],
    sharesDesc: [5, 5, 5],
    subCapCents: 1,
    maxViradas: 2,
    maxEventNotional: 20,
  });

  // Abre com UP @55 exact (honest fill @0.55), DOWN @45
  onTick(st, { UP: 0.55, DOWN: 0.45 }, 200);
  // Momentum gap: UP jumps to 0.62 — honest miss on 60 if cap=1 from 60? level 60 needs ask<=0.61
  onTick(st, { UP: 0.62, DOWN: 0.39 }, 180);
  // DOWN crosses 40 → DESC rest / optimistic fill
  onTick(st, { UP: 0.61, DOWN: 0.4 }, 170);
  onTick(st, { UP: 0.61, DOWN: 0.39 }, 169); // cross for honest DESC 40
  // EQ path: leave residual cheap
  onTick(st, { UP: 0.04, DOWN: 0.96 }, 20);

  return summarize(st);
}

const opt = run('optimistic');
const hon = run('honest');
console.log('optimistic', JSON.stringify(opt, null, 2));
console.log('honest', JSON.stringify(hon, null, 2));
if (opt.counts.subFills < 1) {
  console.error('FAIL: optimistic should fill SUB');
  process.exit(1);
}
console.log('smoke ok');
