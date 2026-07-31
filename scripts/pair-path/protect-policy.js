const MODES = new Set(['off', 'sell', 'hedge', 'min']);

export function parseProtectMode(value) {
  const mode = String(value ?? 'off').toLowerCase();
  if (!MODES.has(mode)) {
    throw new Error(`unknown --protect=${mode} (use off|sell|hedge|min)`);
  }
  return mode;
}

export function feePerShare(price, feeRate = 0.07) {
  const p = Math.min(0.99, Math.max(0.01, Number(price)));
  return Number(feeRate) * p * (1 - p);
}

/**
 * Compares the incremental exit loss after an open fill.
 * The open fee is common to both choices, so it does not affect the decision.
 */
export function protectionCosts({
  openAvg,
  bidOpen,
  askOpp,
  feeRate = 0.07,
}) {
  const sellFee = feePerShare(bidOpen, feeRate);
  const hedgeFee = feePerShare(askOpp, feeRate);
  const sellLossPerShare = Number(openAvg) - Number(bidOpen) + sellFee;
  const hedgeLossPerShare =
    Number(openAvg) + Number(askOpp) - 1 + hedgeFee;
  return {
    sellFee,
    hedgeFee,
    sellLossPerShare,
    hedgeLossPerShare,
    prefer:
      sellLossPerShare <= hedgeLossPerShare + 1e-12 ? 'sell' : 'hedge',
  };
}

/**
 * Composite triggers — protection only when at least one is satisfied:
 * timeout (no cheap hedge for N sec), adverse (fav drop / opp rose beyond hedge),
 * or force-τ.
 */
export function evaluateProtectTriggers({
  elapsedSinceOpenSec = 0,
  protectTimeoutSec = 45,
  bidOpen,
  openAvg,
  protectAdverseCents = 4,
  askOpp,
  openOppAsk = null,
  hedgeAskMax = 0.42,
  protectOppBeyondHedge = true,
  tau,
  tauForceProtect = 20,
}) {
  const force =
    Number.isFinite(Number(tau)) &&
    Number(tau) <= Number(tauForceProtect) + 1e-12;
  if (force) {
    return {
      armed: true,
      force: true,
      reason: 'force_tau',
      timedOut: false,
      adverse: false,
      favDrop: false,
      oppBeyond: false,
    };
  }

  const timedOut =
    Number(elapsedSinceOpenSec) >= Number(protectTimeoutSec) - 1e-12;

  const favDrop =
    Number.isFinite(Number(bidOpen)) &&
    Number.isFinite(Number(openAvg)) &&
    Number(bidOpen) <=
      Number(openAvg) - Number(protectAdverseCents) / 100 + 1e-12;

  let oppBeyond = false;
  if (protectOppBeyondHedge) {
    const margin =
      typeof protectOppBeyondHedge === 'number'
        ? Number(protectOppBeyondHedge) / 100
        : 0;
    const threshold = Number(hedgeAskMax) + margin;
    const rose =
      openOppAsk != null &&
      Number.isFinite(Number(askOpp)) &&
      Number(askOpp) > Number(openOppAsk) + 1e-12;
    oppBeyond =
      Number.isFinite(Number(askOpp)) &&
      Number(askOpp) > threshold + 1e-12 &&
      (openOppAsk == null || rose);
  }

  const adverse = favDrop || oppBeyond;
  const armed = timedOut || adverse;

  return {
    armed,
    force: false,
    reason: timedOut
      ? 'timeout'
      : favDrop
        ? 'adverse_fav'
        : oppBeyond
          ? 'adverse_opp'
          : null,
    timedOut,
    adverse,
    favDrop,
    oppBeyond,
  };
}

export function chooseProtection({
  mode,
  tau,
  tauForceProtect,
  elapsedSinceOpenSec = 0,
  protectTimeoutSec = 45,
  protectAdverseCents = 4,
  protectOppBeyondHedge = true,
  hedgeAskMax = 0.42,
  openSide,
  openAvg,
  openOppAsk = null,
  residual,
  bidOpen,
  askOpp,
  cheapHedgeAvailable = false,
  feeRate = 0.07,
}) {
  const protectMode = parseProtectMode(mode);
  if (
    protectMode === 'off' ||
    cheapHedgeAvailable ||
    !openSide ||
    !(Number(residual) > 0) ||
    !Number.isFinite(Number(openAvg)) ||
    !Number.isFinite(Number(bidOpen)) ||
    !Number.isFinite(Number(askOpp))
  ) {
    return null;
  }

  const triggers = evaluateProtectTriggers({
    elapsedSinceOpenSec,
    protectTimeoutSec,
    bidOpen,
    openAvg,
    protectAdverseCents,
    askOpp,
    openOppAsk,
    hedgeAskMax,
    protectOppBeyondHedge,
    tau,
    tauForceProtect,
  });
  if (!triggers.armed) return null;

  const costs = protectionCosts({ openAvg, bidOpen, askOpp, feeRate });
  const action =
    protectMode === 'min' ? costs.prefer : protectMode;

  return {
    action,
    force: triggers.force,
    trigger: triggers.reason,
    triggers,
    side:
      action === 'sell'
        ? openSide
        : openSide === 'UP'
          ? 'DOWN'
          : 'UP',
    price: action === 'sell' ? Number(bidOpen) : Number(askOpp),
    shares: Number(residual),
    costs,
  };
}
