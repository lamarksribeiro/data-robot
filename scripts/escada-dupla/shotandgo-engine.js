/**
 * Shotandgo / Phil Hopper — motor puro (sem I/O).
 *
 * Porta a escada dupla de Phil_Hopper_Real_1.0.py:
 *   SUB/DESC · re-arme · MULT · contagio · geração · EQ · congelamento
 *
 * Fill modes (dry):
 *   optimistic — fill no nível (Studio)
 *   honest     — SUB @ask se ≤ nível+cap senão MISS; DESC por atravessamento
 *
 * Profiles:
 *   tuned  — grade Phil, MULT=1, maxViradas=3, EQ gate 0.98
 *   phil   — MULT/contagio como no Python 1.0
 *   clip   — grade curta 55/60/65 · 45/40/35, MULT=1, maxVir=2
 *   hybrid — escada curta + gates Clip (avgSum 0.94, open hedge-ready, escape τ)
 */

export const PHIL_SUB = [55, 60, 62, 65, 70, 72, 75, 80, 85, 90];
export const PHIL_DESC = [45, 40, 38, 35, 30, 28, 25, 20, 15, 10];
export const PHIL_MULT = [2, 3, 4, 5, 6, 7, 8, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];

function sharesFromX(X) {
  return {
    sub: [X, X, X / 1.427, X / 1.66, X / 2.5, X / 2.5, X / 2.5, X / 2.5, X / 5, X / 10].map(
      (v) => Math.max(1, Math.round(v * 100) / 100),
    ),
    desc: [
      X / 3.33,
      X / 3.33,
      X / 3.33,
      X / 2.5,
      X / 2,
      X / 2,
      X / 2,
      X / 2,
      X / 1.427,
      X / 2,
    ].map((v) => Math.max(1, Math.round(v * 100) / 100)),
  };
}

export function profileParams(profile = 'tuned', overrides = {}) {
  const X = Number(overrides.X ?? overrides.sharesBase ?? 5);
  const sh = sharesFromX(X);
  const base = {
    profile,
    X,
    subLevels: [...PHIL_SUB],
    descLevels: [...PHIL_DESC],
    sharesSub: sh.sub,
    sharesDesc: sh.desc,
    mult: [1],
    contagio: 'off',
    contagioMin: 5,
    geracaoAtiva: true,
    maxViradas: 3,
    maxEventNotional: 40,
    fillMode: 'honest',
    subCapCents: 1,
    descTimeoutSec: 45,
    eqAskMax: 0.04,
    eqAvgSumMax: 0.98,
    eqEnabled: true,
    eqRefuseIfAvgSumAbove: true,
    descSoAtras: true,
    descSoAtrasVirada: 2,
    bookSumMin: 0.85,
    bookSumMax: 1.15,
    tauOpenMin: 40,
    tauOpenMax: 275,
    feeRate: 0.07,
    /** Janela viva Phil: odd UP entre 10–95¢ antes de armar. */
    filtroLo: 0.1,
    filtroHi: 0.95,
    /** Clip: só abre SUB-1 se ask oposto ≤ 1º DESC + slack. */
    openRequireDescReady: false,
    openDescSlackCents: 2,
    /** Clip escape tardio (EQ mais frouxo perto do fim). */
    tauEscape: null,
    escapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    /** Cruel dry: aproxima live (slip, profundidade, rest mínimo). */
    takerSlipCents: 0,
    depthUnknownCap: null, // null = ilimitado (honest); número = cap se size desconhecido
    descMinRestMs: 0,
    decisionLatencyMs: 0,
    eqRequireDepth: false,
  };

  if (profile === 'phil') {
    Object.assign(base, {
      mult: [...PHIL_MULT],
      contagio: 'global',
      contagioMin: 5,
      maxViradas: 20,
      maxEventNotional: Number(overrides.maxEventNotional ?? 200),
      eqAvgSumMax: 1.5, // Phil equaliza mesmo caro — para observar; use tuned p/ gate
      eqRefuseIfAvgSumAbove: false,
    });
  } else if (profile === 'clip') {
    Object.assign(base, {
      subLevels: [55, 60, 65],
      descLevels: [45, 40, 35],
      sharesSub: [X, X, X],
      sharesDesc: [X, X, X],
      mult: [1],
      contagio: 'off',
      geracaoAtiva: false,
      maxViradas: 2,
      maxEventNotional: 20,
    });
  } else if (profile === 'hybrid') {
    // Produto Phil útil = 1–2 viradas + avgSum gate Clip + DESC tight/deep3
    Object.assign(base, {
      subLevels: [55, 60, 65],
      descLevels: [40, 36, 32],
      sharesSub: [X, X, X],
      sharesDesc: [X, Math.round(X * 0.75 * 100) / 100, Math.round(X * 0.75 * 100) / 100],
      mult: [1],
      contagio: 'off',
      geracaoAtiva: false,
      maxViradas: 2,
      maxEventNotional: Number(overrides.maxEventNotional ?? 20),
      subCapCents: 2,
      eqAskMax: 0.04,
      eqAvgSumMax: 0.94,
      eqRefuseIfAvgSumAbove: true,
      openRequireDescReady: true,
      openDescSlackCents: 2,
      tauEscape: 20,
      escapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      descTimeoutSec: 60,
      descSoAtras: true,
      descSoAtrasVirada: 2,
    });
  }

  // fillMode cruel = honest + fricção de execução
  const fillMode = overrides.fillMode ?? base.fillMode;
  if (fillMode === 'cruel') {
    Object.assign(base, {
      fillMode: 'cruel',
      takerSlipCents: overrides.takerSlipCents ?? 1,
      depthUnknownCap: overrides.depthUnknownCap ?? 3,
      descMinRestMs: overrides.descMinRestMs ?? 100,
      decisionLatencyMs: overrides.decisionLatencyMs ?? 80,
      eqRequireDepth: overrides.eqRequireDepth ?? true,
      subCapCents: overrides.subCapCents ?? base.subCapCents ?? 2,
    });
  }

  // tuned = base already
  return { ...base, ...overrides, profile: overrides.profile ?? profile, fillMode: overrides.fillMode ?? base.fillMode };
}

function feeFor(px, sh, rate) {
  const p = Math.min(0.99, Math.max(0.01, Number(px)));
  return rate * p * (1 - p) * sh;
}

function escadaFresca(p) {
  const e = { UP: [], DOWN: [] };
  for (const lado of ['UP', 'DOWN']) {
    for (let i = 0; i < p.subLevels.length; i++) {
      e[lado].push({
        tipo: 'SUB',
        idx: i + 1,
        precoC: p.subLevels[i],
        shares: p.sharesSub[i] ?? p.sharesSub[0],
        armado: true,
        vezes: 0,
      });
    }
    for (let i = 0; i < p.descLevels.length; i++) {
      e[lado].push({
        tipo: 'DESC',
        idx: i + 1,
        precoC: p.descLevels[i],
        shares: p.sharesDesc[i] ?? p.sharesDesc[0],
        armado: true,
        vezes: 0,
      });
    }
  }
  return e;
}

export function createShotandgoState(paramsRaw = {}) {
  const profile = paramsRaw.profile || 'tuned';
  const p = profileParams(profile, paramsRaw);
  return {
    params: p,
    mode: 'idle', // idle | waiting_filter | active | done
    escada: escadaFresca(p),
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    histSub: [],
    ativo: { UP: 1, DOWN: 1, G: 1 },
    viradas: 0,
    geracao: 1,
    ladoVirada: null,
    escadaArmada: false,
    equalizou: false,
    congelado: false,
    fills: [],
    misses: [],
    blocks: [],
    events: [],
    resting: [],
    pending: [],
    prevAsks: { UP: null, DOWN: null },
    lastDepths: { UP: null, DOWN: null },
  };
}

function depthFor(st, side, depths) {
  const d = depths?.[side];
  if (d != null && Number.isFinite(d) && d > 0) return d;
  const cap = st.params.depthUnknownCap;
  if (cap != null && Number.isFinite(cap)) return cap;
  return Infinity;
}

function isCruel(st) {
  return st.params.fillMode === 'cruel';
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

function fator(st, idx, lado) {
  const p = st.params;
  const n = st.histSub.filter((h) => h.idx === idx).length;
  let f = n === 0 ? 1 : p.mult[Math.min(n, p.mult.length) - 1];
  const travadoLado = st.ativo[lado] >= p.contagioMin;
  const travadoG = st.ativo.G >= p.contagioMin;
  if (p.contagio === 'lado' && travadoLado) f = Math.max(f, st.ativo[lado]);
  else if (p.contagio === 'global' && travadoG) f = Math.max(f, st.ativo.G);
  else if (p.contagio === 'piso' && travadoLado) f = Math.max(f, p.mult[0] || 1);
  if (f > 1) {
    st.ativo[lado] = Math.max(st.ativo[lado], f);
    st.ativo.G = Math.max(st.ativo.G, f);
  }
  return f;
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
  const fill = { side, px, sh, kind, fee, notional, geracao: st.geracao, ...meta };
  st.fills.push(fill);
  st.events.push({ type: 'fill', ...fill });
  return sh;
}

function rearmPair(st, lado, tipo, idx) {
  const comp = tipo === 'SUB' ? 'DESC' : 'SUB';
  for (const c of st.escada[lado]) {
    if (c.tipo === comp && c.idx === idx) {
      c.armado = true;
      break;
    }
  }
}

function novaGeracao(st, ladoQueVirou) {
  st.geracao = st.viradas;
  st.escada = escadaFresca(st.params);
  st.resting = [];
  for (const c of st.escada[ladoQueVirou]) {
    if (c.tipo === 'SUB' && c.idx === 1) {
      c.armado = false;
      c.vezes = 1;
      break;
    }
  }
  st.events.push({ type: 'nova_geracao', geracao: st.geracao, lado: ladoQueVirou });
}

/**
 * @param {ReturnType<typeof createShotandgoState>} st
 * @param {{UP:number|null,DOWN:number|null}} asks
 * @param {number|null} tau
 * @param {number} [ts]
 * @param {{UP?:number|null,DOWN?:number|null}|null} [depths] size no best ask
 */
export function onTick(st, asks, tau, ts = Date.now(), depths = null) {
  if (st.mode === 'done') return;
  const up = asks.UP;
  const dn = asks.DOWN;
  if (depths) st.lastDepths = { UP: depths.UP ?? null, DOWN: depths.DOWN ?? null };
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

  // Filtro Phil: só arma escada quando UP entra na faixa viva
  if (!st.escadaArmada) {
    if (up >= st.params.filtroLo && up <= st.params.filtroHi) {
      st.escadaArmada = true;
      st.mode = 'active';
      st.events.push({ type: 'escada_armada', up, dn, tau });
    } else {
      st.mode = 'waiting_filter';
      st.prevAsks = { UP: up, DOWN: dn };
      return;
    }
  }

  processPending(st, { UP: up, DOWN: dn }, depths, tau, ts);
  processResting(st, { UP: up, DOWN: dn }, depths, tau, ts);

  st.congelado = st.viradas >= st.params.maxViradas;

  if (!st.congelado) {
    let brokeForGeneration = false;
    for (const lado of ['UP', 'DOWN']) {
      if (brokeForGeneration) break;
      const ask = lado === 'UP' ? up : dn;
      const askC = ask * 100;
      for (const n of st.escada[lado]) {
        if (!n.armado) continue;
        const dispSub = n.tipo === 'SUB' && askC + 1e-9 >= n.precoC;
        const dispDesc = n.tipo === 'DESC' && askC <= n.precoC + 1e-9;
        if (!dispSub && !dispDesc) continue;

        if (dispDesc && st.params.descSoAtras && st.viradas >= st.params.descSoAtrasVirada) {
          const meu = st.inv[lado].shares;
          const opo = st.inv[lado === 'UP' ? 'DOWN' : 'UP'].shares;
          if (meu > opo) {
            n.armado = false;
            rearmPair(st, lado, 'DESC', n.idx);
            st.blocks.push({ reason: 'DESC_LADO_NA_FRENTE', lado, idx: n.idx, meu, opo });
            continue;
          }
        }

        if (dispSub) {
          const oppAsk = lado === 'UP' ? dn : up;
          const didGen = trySub(st, lado, n, ask, oppAsk, depths, tau, ts);
          if (didGen) {
            brokeForGeneration = true;
            break;
          }
        } else {
          tryDesc(st, lado, n, ask, tau, ts);
        }
      }
    }
  }

  tryEq(st, { UP: up, DOWN: dn }, depths, tau, ts);
  if (st.equalizou) st.mode = 'done';
  st.prevAsks = { UP: up, DOWN: dn };
}

function trySub(st, lado, n, ask, oppAsk, depths, tau, ts) {
  const levelPx = n.precoC / 100;
  const f = fator(st, n.idx, lado);
  const shWant = Math.round(n.shares * f * 100) / 100;
  const gapC = ask * 100 - n.precoC;
  const mode = st.params.fillMode || 'honest';
  const label = `SUB${st.geracao}-${n.idx}`;

  if (
    st.params.openRequireDescReady &&
    n.idx === 1 &&
    st.viradas === 0 &&
    invested(st) < 1e-9
  ) {
    const firstDescC = st.params.descLevels[0];
    const slack = (st.params.openDescSlackCents ?? 0) / 100;
    const maxOpp = firstDescC / 100 + slack;
    if (oppAsk == null || oppAsk > maxOpp + 1e-12) {
      st.blocks.push({
        reason: 'OPEN_DESC_NOT_READY',
        lado,
        ask,
        oppAsk,
        maxOpp,
        tau,
      });
      return false;
    }
  }

  const afterFill = (fillPx, filled) => {
    if (!filled) return false;
    st.histSub.push({ lado, idx: n.idx });
    n.armado = false;
    n.vezes += 1;
    rearmPair(st, lado, 'SUB', n.idx);

    let geracaoReset = false;
    if (n.idx === 1) {
      st.viradas += 1;
      st.ladoVirada = lado;
      if (st.params.geracaoAtiva && st.viradas > 1) {
        novaGeracao(st, lado);
        geracaoReset = true;
      }
    }
    st.events.push({
      type: 'sub_fill',
      lado,
      idx: n.idx,
      px: fillPx,
      sh: filled,
      fator: f,
      gapC,
      mode,
      tau,
      geracao: st.geracao,
    });
    return geracaoReset;
  };

  if (mode === 'optimistic') {
    const got = buy(st, lado, levelPx, shWant, label, {
      fillMode: 'optimistic',
      levelC: n.precoC,
      ask,
      gapC,
      fator: f,
      tau,
      ts,
    });
    return afterFill(levelPx, got > 0 ? got : 0);
  }

  const slip = (st.params.takerSlipCents || 0) / 100;
  const fillPx = ask + slip;
  const cap = st.params.subCapCents / 100;
  if (fillPx > levelPx + cap + 1e-12) {
    st.misses.push({
      kind: 'SUB_MISS_CAP',
      lado,
      idx: n.idx,
      levelC: n.precoC,
      ask,
      fillPx,
      gapC,
      fator: f,
      tau,
      ts,
    });
    st.events.push({ type: 'sub_miss', lado, idx: n.idx, ask, fillPx, gapC, fator: f, tau });
    n.armado = false;
    rearmPair(st, lado, 'SUB', n.idx);
    return false;
  }

  const depth = depthFor(st, lado, depths);
  const sh = Math.min(shWant, depth);
  if (sh + 1e-9 < 1) {
    st.misses.push({ kind: 'SUB_MISS_DEPTH', lado, idx: n.idx, ask, depth, shWant, tau, ts });
    n.armado = false;
    rearmPair(st, lado, 'SUB', n.idx);
    return false;
  }

  const latency = st.params.decisionLatencyMs || 0;
  if (isCruel(st) && latency > 0) {
    if (st.pending.some((p) => p.kind === 'SUB' && p.lado === lado && p.idx === n.idx)) return false;
    n.armado = false; // consome gatilho; pending tenta fill
    st.pending.push({
      kind: 'SUB',
      lado,
      idx: n.idx,
      levelC: n.precoC,
      shWant: sh,
      fator: f,
      label,
      readyAt: ts + latency,
      gapC,
    });
    rearmPair(st, lado, 'SUB', n.idx);
    st.events.push({ type: 'sub_pending', lado, idx: n.idx, readyAt: ts + latency, tau });
    return false;
  }

  const got = buy(st, lado, fillPx, sh, label, {
    fillMode: mode,
    levelC: n.precoC,
    ask,
    gapC,
    fator: f,
    tau,
    ts,
    depth,
  });
  return afterFill(fillPx, got);
}

function tryDesc(st, lado, n, ask, tau, ts) {
  const levelPx = n.precoC / 100;
  const sh = n.shares;
  const mode = st.params.fillMode || 'honest';
  const label = `DESC${st.geracao}-${n.idx}`;

  if (mode === 'optimistic') {
    const got = buy(st, lado, levelPx, sh, label, {
      fillMode: 'optimistic',
      levelC: n.precoC,
      ask,
      tau,
      ts,
    });
    if (got > 0) {
      n.armado = false;
      rearmPair(st, lado, 'DESC', n.idx);
      st.events.push({ type: 'desc_fill', lado, idx: n.idx, px: levelPx, sh, mode, tau });
    }
    return;
  }

  if (st.resting.some((r) => r.side === lado && r.idx === n.idx && r.geracao === st.geracao)) {
    return;
  }
  n.armado = false;
  st.resting.push({
    side: lado,
    idx: n.idx,
    precoC: n.precoC,
    shares: sh,
    placedTau: tau,
    placedTs: ts,
    geracao: st.geracao,
  });
  rearmPair(st, lado, 'DESC', n.idx);
  st.events.push({ type: 'desc_rest', lado, idx: n.idx, levelC: n.precoC, sh, tau });
}

function processPending(st, asks, depths, tau, ts) {
  if (!st.pending?.length) return;
  const keep = [];
  for (const p of st.pending) {
    if (ts < p.readyAt) {
      keep.push(p);
      continue;
    }
    if (p.kind === 'SUB') {
      const ask = asks[p.lado];
      if (ask == null) {
        st.misses.push({ kind: 'SUB_MISS_LATENCY', ...p, tau });
        continue;
      }
      const levelPx = p.levelC / 100;
      const slip = (st.params.takerSlipCents || 0) / 100;
      const fillPx = ask + slip;
      const cap = st.params.subCapCents / 100;
      if (fillPx > levelPx + cap + 1e-12) {
        st.misses.push({ kind: 'SUB_MISS_CAP', lado: p.lado, idx: p.idx, ask, fillPx, tau, via: 'latency' });
        continue;
      }
      const depth = depthFor(st, p.lado, depths);
      const sh = Math.min(p.shWant, depth);
      if (sh + 1e-9 < 1) {
        st.misses.push({ kind: 'SUB_MISS_DEPTH', lado: p.lado, idx: p.idx, depth, tau });
        continue;
      }
      const got = buy(st, p.lado, fillPx, sh, p.label, {
        fillMode: 'cruel',
        levelC: p.levelC,
        ask,
        fator: p.fator,
        tau,
        ts,
        via: 'latency',
      });
      if (got > 0) {
        st.histSub.push({ lado: p.lado, idx: p.idx });
        if (p.idx === 1) {
          st.viradas += 1;
          st.ladoVirada = p.lado;
          if (st.params.geracaoAtiva && st.viradas > 1) novaGeracao(st, p.lado);
        }
        st.events.push({
          type: 'sub_fill',
          lado: p.lado,
          idx: p.idx,
          px: fillPx,
          sh: got,
          mode: 'cruel',
          tau,
          via: 'latency',
        });
      }
      continue;
    }
    if (p.kind === 'EQ' || p.kind === 'ESCAPE') {
      tryEq(st, asks, depths, tau, ts, { force: true, escape: p.kind === 'ESCAPE' });
      continue;
    }
    keep.push(p);
  }
  st.pending = keep;
}

function processResting(st, asks, depths, tau, ts) {
  if (!st.resting.length) return;
  const keep = [];
  for (const r of st.resting) {
    const prev = st.prevAsks[r.side];
    const curr = asks[r.side];
    const level = r.precoC / 100;
    const age = r.placedTau != null && tau != null ? r.placedTau - tau : null;
    const ageMs = r.placedTs != null ? ts - r.placedTs : 0;
    if (age != null && age > st.params.descTimeoutSec) {
      st.misses.push({ kind: 'DESC_TIMEOUT', lado: r.side, idx: r.idx, levelC: r.precoC, tau });
      st.events.push({ type: 'desc_timeout', lado: r.side, idx: r.idx, tau });
      continue;
    }
    if (prev == null || curr == null) {
      keep.push(r);
      continue;
    }
    if (prev > level + 1e-12 && curr <= level + 1e-12) {
      if (ageMs < (st.params.descMinRestMs || 0)) {
        keep.push(r);
        continue;
      }
      const depth = depthFor(st, r.side, depths);
      const sh = Math.min(r.shares, depth);
      if (sh + 1e-9 < 1) {
        st.misses.push({ kind: 'DESC_MISS_DEPTH', lado: r.side, idx: r.idx, depth, tau });
        continue;
      }
      const label = `DESC${r.geracao}-${r.idx}`;
      const got = buy(st, r.side, level, sh, label, {
        fillMode: st.params.fillMode,
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
          sh: got,
          mode: st.params.fillMode,
          tau,
        });
        if (got + 1e-9 < r.shares) {
          keep.push({ ...r, shares: Math.round((r.shares - got) * 100) / 100 });
        }
      } else {
        keep.push(r);
      }
      continue;
    }
    keep.push(r);
  }
  st.resting = keep;
}

function tryEq(st, asks, depths, tau, ts, opts = {}) {
  if (!st.params.eqEnabled || st.equalizou) return;
  const res = residual(st);
  if (!res.side || res.shares < 1) return;
  const ask = asks[res.side];
  if (ask == null) return;

  const escape =
    opts.escape ||
    (st.params.tauEscape != null && tau != null && tau <= st.params.tauEscape);
  const askMax = escape ? st.params.escapeAskMax : st.params.eqAskMax;
  const avgMax = escape ? st.params.escapeAvgSumMax : st.params.eqAvgSumMax;
  const slip = (st.params.takerSlipCents || 0) / 100;
  const fillPx = ask + slip;
  if (fillPx > askMax + 1e-12) return;

  const latency = st.params.decisionLatencyMs || 0;
  if (isCruel(st) && latency > 0 && !opts.force) {
    if (st.pending.some((p) => p.kind === 'EQ' || p.kind === 'ESCAPE')) return;
    st.pending.push({
      kind: escape ? 'ESCAPE' : 'EQ',
      readyAt: ts + latency,
      side: res.side,
    });
    return;
  }

  const depth = depthFor(st, res.side, depths);
  let sh = Math.min(res.shares, depth);
  if (st.params.eqRequireDepth && (!Number.isFinite(depth) || depth < 1)) {
    st.blocks.push({ reason: 'EQ_NO_DEPTH', side: res.side, depth, tau });
    return;
  }
  if (sh + 1e-9 < 1) {
    st.blocks.push({ reason: 'EQ_DEPTH_TOO_SMALL', side: res.side, depth, need: res.shares, tau });
    return;
  }

  const cur = st.inv[res.side];
  const newSh = cur.shares + sh;
  const newAvg = (cur.cost + sh * fillPx) / newSh;
  const other = res.side === 'UP' ? 'DOWN' : 'UP';
  const oAvg = avg(st, other);
  if (oAvg == null) return;
  const proj = newAvg + oAvg;

  if (st.params.eqRefuseIfAvgSumAbove && proj > avgMax + 1e-12) {
    st.blocks.push({
      reason: escape ? 'ESCAPE_REFUSE_AVGSUM' : 'EQ_REFUSE_AVGSUM',
      proj,
      ask: fillPx,
      avgMax,
      tau,
    });
    return;
  }

  const got = buy(st, res.side, fillPx, sh, escape ? 'ESCAPE' : 'EQUALIZA', {
    fillMode: st.params.fillMode,
    proj,
    tau,
    ts,
    escape: Boolean(escape),
    depth,
  });
  if (got > 0) {
    const left = residual(st);
    st.equalizou = !left.side || left.shares < 1e-6;
    if (st.equalizou) st.resting = [];
    st.events.push({
      type: escape ? 'escape' : 'eq',
      side: res.side,
      px: fillPx,
      sh: got,
      proj,
      tau,
      equalizou: st.equalizou,
    });
    if (!st.equalizou) {
      st.misses.push({
        kind: 'EQ_PARTIAL',
        side: res.side,
        got,
        left: left.shares,
        depth,
        tau,
      });
    }
  }
}

export function summarize(st) {
  const subFills = st.fills.filter((f) => String(f.kind).startsWith('SUB'));
  const descFills = st.fills.filter((f) => String(f.kind).startsWith('DESC'));
  const eqFills = st.fills.filter(
    (f) => String(f.kind).startsWith('EQUALIZA') || String(f.kind).startsWith('ESCAPE'),
  );
  const subMisses = st.misses.filter((m) => m.kind === 'SUB_MISS_CAP');
  const descTimeouts = st.misses.filter((m) => m.kind === 'DESC_TIMEOUT');
  const gaps = subFills.map((f) => Number(f.gapC)).filter((g) => Number.isFinite(g));
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

  return {
    profile: st.params.profile,
    fillMode: st.params.fillMode,
    mode: st.mode,
    viradas: st.viradas,
    geracao: st.geracao,
    congelado: st.congelado,
    equalizou: st.equalizou,
    invested: Math.round(invested(st) * 100) / 100,
    fees: Math.round((st.inv.UP.fees + st.inv.DOWN.fees) * 1000) / 1000,
    avgSum: avgSum(st) != null ? Math.round(avgSum(st) * 1000) / 1000 : null,
    residual: residual(st),
    inv: { UP: { ...st.inv.UP }, DOWN: { ...st.inv.DOWN } },
    counts: {
      subFills: subFills.length,
      descFills: descFills.length,
      eqFills: eqFills.length,
      subMisses: subMisses.length,
      descTimeouts: descTimeouts.length,
      descRestingOpen: st.resting.length,
      eqPartials: st.misses.filter((m) => m.kind === 'EQ_PARTIAL').length,
      depthMisses: st.misses.filter((m) => String(m.kind).includes('DEPTH')).length,
      blocks: st.blocks.length,
    },
    avgGapCents: avgGap != null ? Math.round(avgGap * 10) / 10 : null,
    verdictHint: (() => {
      if (st.equalizou && avgSum(st) != null && avgSum(st) >= 1) return 'EQ_CARO';
      if (st.equalizou && avgSum(st) != null && avgSum(st) < 0.98) return 'EQ_OK';
      if (st.misses.some((m) => m.kind === 'EQ_PARTIAL')) return 'EQ_PARTIAL';
      if (subMisses.length >= Math.max(1, subFills.length) && subMisses.length > 0) return 'SUB_MISS_HEAVY';
      if (descTimeouts.length > descFills.length && descTimeouts.length > 0) return 'DESC_WEAK';
      return 'INCONCLUSIVE';
    })(),
  };
}
