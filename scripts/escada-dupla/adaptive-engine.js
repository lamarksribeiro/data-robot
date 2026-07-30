/**
 * Adaptive + Accumulate — política pura (sem I/O).
 *
 * Objetivo por tick: maximizar edge esperado − risco residual − fee.
 * Accumulate: só compra lado barato; hedge só se avgSum projetado ≤ alvo;
 * size sobe condicional ao preço; no fim (Rescue) só reduz residual.
 */

export const MIN_SHARES = 5;

export const ACCUMULATE = {
  lot: MIN_SHARES,
  maxSideShares: 15,
  openAskMax: 0.58,
  openPairSumMax: 0.98,
  hedgeAskMax: 0.4,
  hedgeLevels: [0.4, 0.36, 0.32],
  hedgeAvgSumMax: 0.94,
  eqAskMax: 0.05,
  escapeTau: 25,
  escapeAskMax: 0.45,
  escapeAvgSumMax: 0.98,
  bookSumMin: 0.88,
  bookSumMax: 1.05,
  maxNotional: 12,
  feeRate: 0.07,
  lambdaRisk: 1.2,
  epsilon: 0.0005,
  tauHarvestMin: 30,
  /**
   * Alavancagem por brecha (NÃO por virada):
   * pairSum = ask + opp → quantos lots de `lot` comprar.
   * Quanto mais barato o par projetado, maior o size.
   */
  scaleTiers: [
    { maxPairSum: 0.9, lots: 3 }, // 15 sh se lot=5
    { maxPairSum: 0.94, lots: 2 }, // 10 sh
    { maxPairSum: 0.98, lots: 1 }, // 5 sh
  ],
};

/**
 * Size em lots conforme barato está o par (ask + opp).
 * @returns {number} 0 = não operar
 */
export function scaleLots(pairSum, p = ACCUMULATE) {
  if (!Number.isFinite(pairSum)) return 0;
  const tiers = p.scaleTiers || [];
  for (const t of tiers) {
    if (pairSum <= t.maxPairSum + 1e-12) return Math.max(0, Number(t.lots) || 0);
  }
  return 0;
}

export function sharesForPair(pairSum, p = ACCUMULATE) {
  const lots = scaleLots(pairSum, p);
  if (lots <= 0) return 0;
  return Math.max(MIN_SHARES, lots * (p.lot || MIN_SHARES));
}

export function feeFor(px, sh, rate = ACCUMULATE.feeRate) {
  const p = Math.min(0.99, Math.max(0.01, Number(px)));
  return rate * p * (1 - p) * sh;
}

export function createAdaptiveState(overrides = {}) {
  const p = { ...ACCUMULATE, ...overrides };
  return {
    params: p,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    rests: [], // {side, px, sh, id?}
    fills: [],
    events: [],
    blocks: [],
    mode: 'harvest', // harvest | rescue | done
  };
}

export function invested(st) {
  return st.inv.UP.cost + st.inv.DOWN.cost;
}

export function avg(st, side) {
  const x = st.inv[side];
  return x.shares > 0 ? x.cost / x.shares : null;
}

export function avgSum(st) {
  const a = avg(st, 'UP');
  const b = avg(st, 'DOWN');
  return a != null && b != null ? a + b : null;
}

export function pairedShares(st) {
  return Math.min(st.inv.UP.shares, st.inv.DOWN.shares);
}

export function residual(st) {
  const d = st.inv.UP.shares - st.inv.DOWN.shares;
  if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
  return d > 0 ? { side: 'DOWN', shares: d } : { side: 'UP', shares: -d };
}

/** Proxy de edge até redeem (pares) menos haircut do residual + opção de hedge barato. */
export function edgeProxy(st, asks, tau) {
  const paired = pairedShares(st);
  const as = avgSum(st);
  const edgePaired = as != null ? (1 - as) * paired : 0;
  const fees = st.inv.UP.fees + st.inv.DOWN.fees;
  const res = residual(st);
  let haircut = 0;
  let option = 0;
  if (res.side && res.shares > 0) {
    const ask = asks?.[res.side];
    const other = res.side === 'UP' ? 'DOWN' : 'UP';
    const oAvg = avg(st, other);
    if (ask != null && oAvg != null) {
      const proj = oAvg + ask;
      if (proj < 1 - 1e-12) {
        // inventário ainda hedgeável com lucro estrutural
        option = (1 - proj) * res.shares * 0.85;
      } else {
        haircut = (proj - 1) * res.shares;
      }
    } else {
      haircut = 0.5 * res.shares;
    }
    if (tau != null && tau < st.params.escapeTau) {
      haircut *= 1.5;
      option *= 0.5;
    }
  }
  return edgePaired - fees + option - st.params.lambdaRisk * haircut;
}

function cloneInv(st) {
  return {
    UP: { ...st.inv.UP },
    DOWN: { ...st.inv.DOWN },
  };
}

function applyBuyHyp(st, side, px, sh) {
  const inv = cloneInv(st);
  const fee = feeFor(px, sh, st.params.feeRate);
  inv[side].shares += sh;
  inv[side].cost += sh * px;
  inv[side].fees += fee;
  return { inv, fee };
}

function edgeWithInv(inv, params, asks, tau) {
  const fake = { inv, params, rests: [] };
  return edgeProxy(fake, asks, tau);
}

/**
 * Gera candidatos e devolve a melhor ação (ou HOLD).
 * @returns {{type:string, side?:string, px?:number, sh?:number, score:number, reason:string}}
 */
export function proposeAction(st, asks, tau) {
  const p = st.params;
  const up = asks?.UP;
  const dn = asks?.DOWN;
  if (up == null || dn == null) {
    return { type: 'HOLD', score: 0, reason: 'no_book' };
  }
  const sum = up + dn;
  if (sum < p.bookSumMin || sum > p.bookSumMax) {
    return { type: 'HOLD', score: 0, reason: 'book_sum' };
  }

  const rescue = tau != null && tau <= p.escapeTau;
  st.mode = rescue ? 'rescue' : pairedShares(st) >= p.lot && residual(st).shares < 0.5 ? 'done' : 'harvest';
  if (st.mode === 'done') {
    return { type: 'HOLD', score: 0, reason: 'balanced' };
  }

  const base = edgeProxy(st, asks, tau);
  const candidates = [];

  const pushBuy = (side, px, sh, reason, force = false) => {
    if (sh + 1e-9 < MIN_SHARES) return;
    if (invested(st) + sh * px > p.maxNotional + 1e-9) return;
    if (!force && st.inv[side].shares + sh > p.maxSideShares + 1e-9) return;
    const { inv } = applyBuyHyp(st, side, px, sh);
    const score = edgeWithInv(inv, p, asks, tau) - base;
    candidates.push({ type: 'BUY', side, px, sh, score, reason });
  };

  const res = residual(st);

  // --- Harvest: accumulate lado barato (size = scale por pairSum) ---
  if (!rescue) {
    for (const [side, ask] of [
      ['UP', up],
      ['DOWN', dn],
    ]) {
      if (ask > p.openAskMax + 1e-12) continue;
      const opp = side === 'UP' ? dn : up;
      const pairSum = ask + opp;
      if (pairSum > p.openPairSumMax + 1e-12) continue;
      const shWant = sharesForPair(pairSum, p);
      if (shWant < MIN_SHARES) continue;
      const room = p.maxSideShares - st.inv[side].shares;
      const sh = Math.min(shWant, Math.floor(room / MIN_SHARES) * MIN_SHARES || room);
      if (sh + 1e-9 < MIN_SHARES) continue;
      const lots = scaleLots(pairSum, p);
      pushBuy(side, ask, sh, `accumulate_x${lots}_pair${pairSum.toFixed(2)}`);
    }

    // Hedge taker: size até residual, prioriza fechar com projSum bom
    if (res.side && res.shares + 1e-9 >= MIN_SHARES) {
      const ask = asks[res.side];
      const other = res.side === 'UP' ? 'DOWN' : 'UP';
      const oAvg = avg(st, other);
      if (ask != null && oAvg != null && ask <= p.hedgeAskMax + 1e-12) {
        const newAvgSide =
          st.inv[res.side].shares > 0
            ? (st.inv[res.side].cost + Math.min(res.shares, p.lot) * ask) /
              (st.inv[res.side].shares + Math.min(res.shares, p.lot))
            : ask;
        const projSum = oAvg + newAvgSide;
        if (projSum <= p.hedgeAvgSumMax + 1e-12) {
          // se o hedge está muito barato, fecha mais residual de uma vez
          const hedgeLots = scaleLots(oAvg + ask, p) || 1;
          const sh = Math.max(
            MIN_SHARES,
            Math.min(res.shares, hedgeLots * p.lot, p.maxSideShares),
          );
          pushBuy(res.side, ask, sh, `hedge_taker_x${hedgeLots}`, true);
        }
      }
    }

    // Resting hedge nos níveis (ação REST — harness posta GTC)
    if (res.side && res.shares >= MIN_SHARES - 1e-9) {
      for (const lvl of p.hedgeLevels) {
        const already = st.rests.some((r) => r.side === res.side && Math.abs(r.px - lvl) < 1e-9);
        if (already) continue;
        const other = res.side === 'UP' ? 'DOWN' : 'UP';
        const oAvg = avg(st, other);
        if (oAvg == null) continue;
        const projSum = oAvg + lvl;
        if (projSum > p.hedgeAvgSumMax + 1e-12) continue;
        const hedgeLots = scaleLots(projSum, p) || 1;
        const sh = Math.max(MIN_SHARES, Math.min(res.shares, hedgeLots * p.lot));
        const score = (p.hedgeAvgSumMax - projSum) * sh + (p.hedgeAskMax - lvl) * 0.1;
        candidates.push({
          type: 'REST',
          side: res.side,
          px: lvl,
          sh,
          score,
          reason: `rest_${lvl}_x${hedgeLots}`,
        });
      }
    }
  }

  // --- Rescue / EQ / escape ---
  if (res.side && res.shares + 1e-9 >= MIN_SHARES) {
    const ask = asks[res.side];
    const other = res.side === 'UP' ? 'DOWN' : 'UP';
    const oAvg = avg(st, other);
    if (ask != null && oAvg != null) {
      const askMax = rescue ? p.escapeAskMax : p.eqAskMax;
      const avgMax = rescue ? p.escapeAvgSumMax : p.hedgeAvgSumMax;
      if (ask <= askMax + 1e-12) {
        const sh = Math.max(MIN_SHARES, Math.ceil(res.shares * 100) / 100);
        const newAvg =
          st.inv[res.side].shares > 0
            ? (st.inv[res.side].cost + sh * ask) / (st.inv[res.side].shares + sh)
            : ask;
        const projSum = oAvg + newAvg;
        if (projSum <= avgMax + 1e-12 || rescue) {
          pushBuy(res.side, ask, Math.min(sh, p.lot * 2), rescue ? 'escape' : 'equalize', true);
        }
      }
    }
  }

  // EQ barato mesmo fora de rescue se ask ≤ eqAskMax
  if (!rescue && res.side && res.shares >= MIN_SHARES - 1e-9) {
    const ask = asks[res.side];
    if (ask != null && ask <= p.eqAskMax + 1e-12) {
      pushBuy(res.side, ask, Math.max(MIN_SHARES, Math.ceil(res.shares * 100) / 100), 'eq_cheap', true);
    }
  }

  if (!candidates.length) return { type: 'HOLD', score: 0, reason: rescue ? 'rescue_wait' : 'no_edge' };

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best.score < p.epsilon && best.type !== 'REST') {
    // REST com score pequeno ainda pode valer (opção)
    const rest = candidates.find((c) => c.type === 'REST');
    if (rest && rest.score > 0) return rest;
    return { type: 'HOLD', score: best.score, reason: 'below_epsilon', best };
  }
  return best;
}

export function recordBuy(st, side, px, sh, kind, meta = {}) {
  const fee = feeFor(px, sh, st.params.feeRate);
  st.inv[side].shares += sh;
  st.inv[side].cost += sh * px;
  st.inv[side].fees += fee;
  const fill = { side, px, sh, kind, fee, ...meta };
  st.fills.push(fill);
  st.events.push({ type: 'fill', ...fill });
  return fill;
}

export function summarize(st, asks = null, tau = null) {
  const res = residual(st);
  return {
    mode: st.mode,
    invested: Math.round(invested(st) * 100) / 100,
    fees: Math.round((st.inv.UP.fees + st.inv.DOWN.fees) * 1000) / 1000,
    avgSum: avgSum(st) != null ? Math.round(avgSum(st) * 1000) / 1000 : null,
    paired: pairedShares(st),
    residual: res,
    inv: { UP: { ...st.inv.UP }, DOWN: { ...st.inv.DOWN } },
    fills: st.fills.length,
    edge: asks ? Math.round(edgeProxy(st, asks, tau) * 1000) / 1000 : null,
    rests: st.rests.length,
  };
}
