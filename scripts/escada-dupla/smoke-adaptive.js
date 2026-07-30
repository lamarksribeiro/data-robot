#!/usr/bin/env node
import {
  createAdaptiveState,
  proposeAction,
  recordBuy,
  scaleLots,
  sharesForPair,
  ACCUMULATE,
} from './adaptive-engine.js';

// scale table
if (scaleLots(0.89) !== 3) throw new Error('tier 0.89 → 3');
if (scaleLots(0.93) !== 2) throw new Error('tier 0.93 → 2');
if (scaleLots(0.97) !== 1) throw new Error('tier 0.97 → 1');
if (scaleLots(0.99) !== 0) throw new Error('tier 0.99 → 0');
if (sharesForPair(0.89) !== 15) throw new Error('shares 0.89');
if (sharesForPair(0.97) !== 5) throw new Error('shares 0.97');
console.log('scale ok', { 89: sharesForPair(0.89), 93: sharesForPair(0.93), 97: sharesForPair(0.97) });

// open caro recusado
{
  const st = createAdaptiveState();
  const a = proposeAction(st, { UP: 0.65, DOWN: 0.36 }, 200);
  if (a.type === 'BUY' && String(a.reason).includes('accumulate')) {
    console.error('refuse expensive', a);
    process.exit(1);
  }
  console.log('refuse expensive', a.type, a.reason);
}

// brecha boa → size 15 (pair 0.50+0.39=0.89)
{
  const st = createAdaptiveState();
  const a = proposeAction(st, { UP: 0.5, DOWN: 0.39 }, 200);
  if (a.type !== 'BUY' || a.sh < 15) {
    console.error('expected x3 size', a);
    process.exit(1);
  }
  console.log('fat gap', a);
  recordBuy(st, a.side, a.px, a.sh, a.reason);
}

// brecha ok → size 5 (pair 0.55+0.42=0.97)
{
  const st = createAdaptiveState();
  const a = proposeAction(st, { UP: 0.55, DOWN: 0.42 }, 200);
  if (a.type !== 'BUY' || a.sh !== 5) {
    console.error('expected x1 size', a);
    process.exit(1);
  }
  console.log('thin gap', a);
}

console.log('params', {
  openAskMax: ACCUMULATE.openAskMax,
  tiers: ACCUMULATE.scaleTiers,
  maxSide: ACCUMULATE.maxSideShares,
});
console.log('adaptive scale smoke ok');
