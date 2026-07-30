/**
 * Escada Dupla — motor puro (sem I/O).
 *
 * Mecânica básica Shotandgo/Phil, enxuta:
 *   - SUB: compra quando ask sobe até o nível
 *   - DESC: compra quando ask cai até o nível (maker resting no honest)
 *   - re-arme do par complementar (mesmo idx)
 *   - MULT = 1 (sem martingale nesta fase)
 *   - EQ opcional no lado menor se barato e avgSum ok
 *
 * Dois modelos de fill para confrontar invalidação do lab:
 *   optimistic — fill no preço do nível (Studio fantasma)
 *   honest     — SUB: fill @ask só se ask ≤ nível+cap; senão MISS
 *                DESC: fill só por atravessamento (prev > nível ≥ curr)
 */

export const DEFAULT_LADDER = {
  subLevels: [55, 60, 65],
  descLevels: [45, 40, 35],
  sharesSub: [5, 5, 5],
  sharesDesc: [5, 5, 5],
  /** Fill model: optimistic | honest */
  fillMode: 'honest',
  /** Cap em centavos acima do nível SUB (só honest). */
  subCapCents: 1,
  /** Timeout DESC resting (segundos de tau decorridos). */
  descTimeoutSec: 45,
  maxViradas: 2,
  maxEventNotional: 12,
  eqAskMax: 0.05,
  eqAvgSumMax: 0.98,
  eqEnabled: true,
  tauOpenMin: 40,
  tauOpenMax: 275,
  feeRate: 0.07,
  /** Anti-glitch book. */
  bookSumMin: 0.85,
  bookSumMax: 1.15,
};

function feeFor(px, sh, rate) {
  const p = Math.min(0.99, Math.max(0.01, Number(px)));
  return rate * p * (1 - p) * sh;
}

function cloneLevels(params) {
  const out = { UP: [], DOWN: [] };
  for (const side of ['UP', 'DOWN']) {
    for (let i = 0; i < params.subLevels.length; i++) {
      out[side].push({
        tipo: 'SUB',
        idx: i + 1,
        precoC: params.subLevels[i],
        shares: params.sharesSub[i] ?? params.sharesSub[0],
        armado: true,
        vezes: 0,
      });
    }
    for (let i = 0; i < params.descLevels.length; i++) {
      out[side].push({
        tipo: 'DESC',
        idx: i + 1,
        precoC: params.descLevels[i],
        shares: params.sharesDesc[i] ?? params.sharesDesc[0],
        armado: true,
        vezes: 0,
      });
    }
  }
  return out;
}

export function createLadderState(paramsRaw = {}) {
  const params = { ...DEFAULT_LADDER, ...paramsRaw };
  if (params.sharesSub.length < params.subLevels.length) {
    params.sharesSub = params.subLevels.map(() => params.sharesSub[0] ?? 5);
  }
  if (params.sharesDesc.length < params.descLevels.length) {
    params.sharesDesc = params.descLevels.map(() => params.sharesDesc[0] ?? 5);
  }
  return {
    params,
    mode: 'idle', // idle | active | done | blocked
    escada: cloneLevels(params),
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    viradas: 0,
    fills: [],
    misses: [],
    blocks: [],
    events: [],
    /** DESC resting: { side, idx, precoC, shares, placedTau } */
    resting: [],
    prevAsks: { UP: null, DOWN: null },
    equalizou: false,
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
  if (a == null || b == null) return null;
  return a + b;
}

export function residual(st) {
  const d = st.inv.UP.shares - st.inv.DOWN.shares;
  if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
  return d > 0 ? { side: 'DOWN', shares: d } : { side: 'UP', shares: -d };
}

function buy(st, side, px, sh, kind, meta = {}) {
  if (sh <= 0) return 0;
  const notional = sh * px;
  if (invested(st) + notional > st.params.maxEventNotional + 1e-9) {
    st.blocks.push({ reason: 'TETO', side, sh, px, kind });
    return 0;
  }
  const fee = feeFor(px, sh, st.params.feeRate);
  st.inv[side].shares += sh;
  st.inv[side].cost += notional;
  st.inv[side].fees += fee;
  const fill = { side, px, sh, kind, fee, notional, ...meta };
  st.fills.push(fill);
  st.events.push({ type: 'fill', ...fill });
  return sh;
}

function rearmPair(st, lado, tipo, idx) {
  const oppositeTipo = tipo === 'SUB' ? 'DESC' : 'SUB';
  for (const n of st.escada[lado]) {
    if (n.tipo === oppositeTipo && n.idx === idx) {
      n.armado = true;
      break;
    }
  }
}

function disarm(st, lado, tipo, idx) {
  for (const n of st.escada[lado]) {
    if (n.tipo === tipo && n.idx === idx) {
      n.armado = false;
      n.vezes += 1;
      break;
    }
  }
}

/**
 * Processa um tick de asks.
 * @param {object} st
 * @param {{UP:number|null, DOWN:number|null}} asks
 * @param {number|null} tau
 * @param {number} [ts]
 */
export function onTick(st, asks, tau, ts = Date.now()) {
  if (st.mode === 'done' || st.mode === 'blocked') return;

  const up = asks.UP;
  const dn = asks.DOWN;
  if (up == null || dn == null) {
    st.prevAsks = { ...asks };
    return;
  }

  const sum = up + dn;
  if (sum < st.params.bookSumMin || sum > st.params.bookSumMax) {
    st.blocks.push({ reason: 'BOOK_SUM', sum, tau });
    st.prevAsks = { UP: up, DOWN: dn };
    return;
  }

  if (tau != null && (tau < st.params.tauOpenMin || tau > st.params.tauOpenMax)) {
    // ainda processa DESC resting / EQ se já ativo
    if (st.mode === 'idle') {
      st.prevAsks = { UP: up, DOWN: dn };
      return;
    }
  }

  if (st.mode === 'idle') st.mode = 'active';

  // 1) DESC resting fills / timeouts (honest)
  processResting(st, { UP: up, DOWN: dn }, tau, ts);

  // 2) Level triggers (congela após maxViradas — só resting/EQ seguem)
  const congelado = st.viradas >= st.params.maxViradas;
  if (!congelado) {
    for (const lado of ['UP', 'DOWN']) {
      const ask = lado === 'UP' ? up : dn;
      const askC = ask * 100;
      for (const n of st.escada[lado]) {
        if (!n.armado) continue;
        if (n.tipo === 'SUB' && askC + 1e-9 >= n.precoC) {
          trySub(st, lado, n, ask, tau, ts);
        } else if (n.tipo === 'DESC' && askC <= n.precoC + 1e-9) {
          tryDesc(st, lado, n, ask, tau, ts);
        }
      }
    }
  }

  // 3) EQ
  if (st.params.eqEnabled) tryEq(st, { UP: up, DOWN: dn }, tau, ts);

  // freeze after max viradas: no new triggers already handled; mark done if equalized
  if (st.equalizou) st.mode = 'done';

  st.prevAsks = { UP: up, DOWN: dn };
}

function trySub(st, lado, n, ask, tau, ts) {
  const levelPx = n.precoC / 100;
  const sh = n.shares;
  const gapC = ask * 100 - n.precoC;
  const mode = st.params.fillMode || 'honest';

  if (mode === 'optimistic') {
    const got = buy(st, lado, levelPx, sh, `SUB-${n.idx}`, {
      fillMode: 'optimistic',
      levelC: n.precoC,
      ask,
      gapC,
      tau,
      ts,
    });
    if (got > 0) {
      disarm(st, lado, 'SUB', n.idx);
      rearmPair(st, lado, 'SUB', n.idx);
      if (n.idx === 1) st.viradas += 1;
      st.events.push({ type: 'sub_fill', lado, idx: n.idx, px: levelPx, sh, gapC, mode, tau });
    }
    return;
  }

  // honest
  const cap = st.params.subCapCents / 100;
  if (ask > levelPx + cap + 1e-12) {
    st.misses.push({
      kind: 'SUB_MISS_CAP',
      lado,
      idx: n.idx,
      levelC: n.precoC,
      ask,
      gapC,
      tau,
      ts,
    });
    st.events.push({ type: 'sub_miss', lado, idx: n.idx, ask, gapC, tau });
    // Consome o cruzamento (não spam a 50Hz). Par DESC re-arma; SUB só volta se DESC disparar.
    disarm(st, lado, 'SUB', n.idx);
    rearmPair(st, lado, 'SUB', n.idx);
    return;
  }
  const fillPx = ask;
  const got = buy(st, lado, fillPx, sh, `SUB-${n.idx}`, {
    fillMode: 'honest',
    levelC: n.precoC,
    ask,
    gapC,
    tau,
    ts,
  });
  if (got > 0) {
    disarm(st, lado, 'SUB', n.idx);
    rearmPair(st, lado, 'SUB', n.idx);
    if (n.idx === 1) st.viradas += 1;
    st.events.push({ type: 'sub_fill', lado, idx: n.idx, px: fillPx, sh, gapC, mode: 'honest', tau });
  }
}

function tryDesc(st, lado, n, ask, tau, ts) {
  const levelPx = n.precoC / 100;
  const sh = n.shares;
  const mode = st.params.fillMode || 'honest';

  if (mode === 'optimistic') {
    const got = buy(st, lado, levelPx, sh, `DESC-${n.idx}`, {
      fillMode: 'optimistic',
      levelC: n.precoC,
      ask,
      tau,
      ts,
    });
    if (got > 0) {
      disarm(st, lado, 'DESC', n.idx);
      rearmPair(st, lado, 'DESC', n.idx);
      st.events.push({ type: 'desc_fill', lado, idx: n.idx, px: levelPx, sh, mode, tau });
    }
    return;
  }

  // honest: posta resting (se ainda não) e espera atravessamento
  const already = st.resting.some((r) => r.side === lado && r.idx === n.idx);
  if (already) return;

  // Dispara quando ask <= nível: posta resting @ nível
  disarm(st, lado, 'DESC', n.idx);
  st.resting.push({
    side: lado,
    idx: n.idx,
    precoC: n.precoC,
    shares: sh,
    placedTau: tau,
    placedTs: ts,
  });
  st.events.push({ type: 'desc_rest', lado, idx: n.idx, levelC: n.precoC, sh, tau });
  // re-arme só após fill (como maker que ainda não executou — Phil rearma ao disparar;
  // aqui rearma ao postar para manter grade viva)
  rearmPair(st, lado, 'DESC', n.idx);
}

function processResting(st, asks, tau, ts) {
  if (!st.resting.length) return;
  const keep = [];
  for (const r of st.resting) {
    const prev = st.prevAsks[r.side];
    const curr = asks[r.side];
    const level = r.precoC / 100;
    const age = r.placedTau != null && tau != null ? r.placedTau - tau : null;

    if (age != null && age > st.params.descTimeoutSec) {
      st.misses.push({
        kind: 'DESC_TIMEOUT',
        lado: r.side,
        idx: r.idx,
        levelC: r.precoC,
        tau,
        ts,
      });
      st.events.push({ type: 'desc_timeout', lado: r.side, idx: r.idx, tau });
      continue;
    }

    if (prev == null || curr == null) {
      keep.push(r);
      continue;
    }

    // atravessamento: prev > level e curr <= level
    const thr = level;
    if (prev > thr + 1e-12 && curr <= thr + 1e-12) {
      const got = buy(st, r.side, level, r.shares, `DESC-${r.idx}`, {
        fillMode: 'honest',
        levelC: r.precoC,
        ask: curr,
        via: 'cross',
        tau,
        ts,
      });
      if (got > 0) {
        st.events.push({
          type: 'desc_fill',
          lado: r.side,
          idx: r.idx,
          px: level,
          sh: r.shares,
          mode: 'honest',
          tau,
        });
      }
      continue;
    }
    keep.push(r);
  }
  st.resting = keep;
}

function tryEq(st, asks, tau, ts) {
  const res = residual(st);
  if (!res.side || res.shares < 1) return;
  const ask = asks[res.side];
  if (ask == null || ask > st.params.eqAskMax + 1e-12) return;

  // projected avgSum
  const cur = st.inv[res.side];
  const newSh = cur.shares + res.shares;
  const newAvg = (cur.cost + res.shares * ask) / newSh;
  const other = res.side === 'UP' ? 'DOWN' : 'UP';
  const oAvg = avg(st, other);
  if (oAvg == null) return;
  const proj = newAvg + oAvg;
  if (proj > st.params.eqAvgSumMax + 1e-12) {
    st.blocks.push({ reason: 'EQ_REFUSE_AVGSUM', proj, ask, tau });
    return;
  }

  const got = buy(st, res.side, ask, res.shares, 'EQUALIZA', {
    fillMode: st.params.fillMode,
    tau,
    ts,
  });
  if (got > 0) {
    st.equalizou = Math.abs(st.inv.UP.shares - st.inv.DOWN.shares) < 1e-6;
    st.events.push({ type: 'eq', side: res.side, px: ask, sh: got, proj, tau });
    // cancela resting
    st.resting = [];
  }
}

export function summarize(st) {
  const subFills = st.fills.filter((f) => String(f.kind).startsWith('SUB'));
  const descFills = st.fills.filter((f) => String(f.kind).startsWith('DESC'));
  const eqFills = st.fills.filter((f) => String(f.kind).startsWith('EQUALIZA'));
  const subMisses = st.misses.filter((m) => m.kind === 'SUB_MISS_CAP');
  const descTimeouts = st.misses.filter((m) => m.kind === 'DESC_TIMEOUT');
  const gaps = subFills.map((f) => Number(f.gapC)).filter((g) => Number.isFinite(g));
  const avgGap =
    gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

  return {
    fillMode: st.params.fillMode,
    mode: st.mode,
    viradas: st.viradas,
    equalizou: st.equalizou,
    invested: Math.round(invested(st) * 100) / 100,
    fees: Math.round((st.inv.UP.fees + st.inv.DOWN.fees) * 1000) / 1000,
    avgSum: avgSum(st) != null ? Math.round(avgSum(st) * 1000) / 1000 : null,
    residual: residual(st),
    inv: {
      UP: { ...st.inv.UP },
      DOWN: { ...st.inv.DOWN },
    },
    counts: {
      subFills: subFills.length,
      descFills: descFills.length,
      eqFills: eqFills.length,
      subMisses: subMisses.length,
      descTimeouts: descTimeouts.length,
      descRestingOpen: st.resting.length,
      blocks: st.blocks.length,
    },
    avgGapCents: avgGap != null ? Math.round(avgGap * 10) / 10 : null,
    /** Heurística de invalidação: miss alto ou avgSum>1 quando equaliza. */
    verdictHint: (() => {
      if (st.equalizou && avgSum(st) != null && avgSum(st) >= 1) return 'EQ_CARO';
      if (subMisses.length > 0 && subFills.length === 0) return 'SUB_ALL_MISS';
      if (subMisses.length >= subFills.length && subMisses.length > 0) return 'SUB_MISS_HEAVY';
      if (st.equalizou && avgSum(st) != null && avgSum(st) < 0.98) return 'EQ_OK';
      if (descTimeouts.length > descFills.length && descTimeouts.length > 0) return 'DESC_WEAK';
      return 'INCONCLUSIVE';
    })(),
  };
}
