const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashboardView = $('dashboard-view');
const alertBox = $('dashboard-alert');
const menuButton = $('menu-button');
const mobileNav = $('mobile-nav');
let pollTimer = null;
let actionRunning = false;
let lastStatus = null;
let currentView = 'overview';

/**
 * Séries só enquanto a sessão do dashboard está ativa.
 * No logout: clearInterval + clearSeries — zero poll e zero desenho.
 */
const SERIES_MAX = 90;
const series = {
  ts: [],
  btc: [],
  ptb: [],
  signedDist: [],
  ask: [],
  bid: [],
  pnl: [],
  fav: [],
};

function clearSeries() {
  for (const key of Object.keys(series)) series[key] = [];
}

function pushSeries(sample) {
  if (!document.body.classList.contains('dashboard-active')) return;
  series.ts.push(sample.ts);
  series.btc.push(sample.btc);
  series.ptb.push(sample.ptb);
  series.signedDist.push(sample.signedDist);
  series.ask.push(sample.ask);
  series.bid.push(sample.bid);
  series.pnl.push(sample.pnl);
  series.fav.push(sample.fav);
  while (series.ts.length > SERIES_MAX) {
    for (const key of Object.keys(series)) series[key].shift();
  }
}

function prepareCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width || 640;
  const cssH = canvas.clientHeight || canvas.height || 200;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, cssW, cssH, pad: { t: 14, r: 14, b: 22, l: 52 } };
}

function formatChartValue(v, opts = {}) {
  if (!Number.isFinite(v)) return '—';
  if (opts.unit === '$') return `$${v.toFixed(2)}`;
  if (opts.digits != null) return v.toFixed(opts.digits);
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function finiteCount(values) {
  return values.filter((v) => Number.isFinite(v)).length;
}

/**
 * Multi-linha com detecção de cruzamento entre as duas primeiras séries.
 * lines: [{ values, color, width?, fill? }]
 */
function drawMultiChart(canvas, lines, opts = {}) {
  if (!canvas) return;
  const emptyEl = opts.emptyId ? $(opts.emptyId) : null;
  const primary = lines?.[0]?.values ?? [];
  if (finiteCount(primary) < 2) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    prepareCanvas(canvas);
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, cssW, cssH, pad } = prepared;
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const n = Math.max(...lines.map((l) => l.values.length), 1);

  const all = [];
  for (const line of lines) {
    for (const v of line.values) if (Number.isFinite(v)) all.push(v);
  }
  if (all.length < 2) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (opts.zeroLine) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  // margem visual
  const padY = (max - min) * 0.08 || 1;
  min -= padY;
  max += padY;
  const range = max - min || 1;

  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * w;
  const yAt = (v) => pad.t + h - ((v - min) / range) * h;

  // grid
  ctx.strokeStyle = 'rgba(16,185,129,0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  }

  // zero
  if (opts.zeroLine && min < 0 && max > 0) {
    const zy = yAt(0);
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, zy);
    ctx.lineTo(pad.l + w, zy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0', pad.l + 4, zy - 4);
  }

  // labels
  ctx.fillStyle = '#64748b';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(formatChartValue(max, opts), pad.l - 6, pad.t + 8);
  ctx.fillText(formatChartValue(min, opts), pad.l - 6, pad.t + h);

  // bands (optional horizontal guides)
  for (const band of opts.bands ?? []) {
    if (!Number.isFinite(band.y)) continue;
    const by = yAt(band.y);
    ctx.strokeStyle = band.color || 'rgba(245,158,11,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, by);
    ctx.lineTo(pad.l + w, by);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // draw lines
  for (const line of lines) {
    const path = [];
    for (let i = 0; i < line.values.length; i++) {
      const v = line.values[i];
      if (!Number.isFinite(v)) continue;
      path.push({ i, x: xAt(i), y: yAt(v), v });
    }
    if (path.length < 2) continue;

    if (line.fill) {
      const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
      grad.addColorStop(0, `${line.color}40`);
      grad.addColorStop(1, `${line.color}00`);
      ctx.beginPath();
      ctx.moveTo(path[0].x, pad.t + h);
      for (const p of path) ctx.lineTo(p.x, p.y);
      ctx.lineTo(path[path.length - 1].x, pad.t + h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width ?? 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const last = path[path.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = line.color;
    ctx.fill();
  }

  // crossovers between first two series
  if (opts.crosses && lines.length >= 2) {
    const a = lines[0].values;
    const b = lines[1].values;
    const len = Math.min(a.length, b.length);
    for (let i = 1; i < len; i++) {
      if (![a[i - 1], a[i], b[i - 1], b[i]].every(Number.isFinite)) continue;
      const prev = a[i - 1] - b[i - 1];
      const cur = a[i] - b[i];
      if (prev === 0 || cur === 0 || prev * cur > 0) continue;
      // interpolate cross fraction
      const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(cur) || 1);
      const x = xAt(i - 1 + t);
      const y = yAt(a[i - 1] + (a[i] - a[i - 1]) * t);
      const upCross = cur > 0;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = upCross ? '#10b981' : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // vertical guide
      ctx.strokeStyle = upCross ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // zero-cross markers for single signed series
  if (opts.zeroCrosses && lines[0]) {
    const vals = lines[0].values;
    for (let i = 1; i < vals.length; i++) {
      if (!Number.isFinite(vals[i - 1]) || !Number.isFinite(vals[i])) continue;
      if (vals[i - 1] === 0 || vals[i] === 0 || vals[i - 1] * vals[i] > 0) continue;
      const t = Math.abs(vals[i - 1]) / (Math.abs(vals[i - 1]) + Math.abs(vals[i]) || 1);
      const x = xAt(i - 1 + t);
      const y = yAt(0);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = vals[i] > 0 ? '#10b981' : '#f59e0b';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function countCrosses(a, b) {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 1; i < len; i++) {
    if (![a[i - 1], a[i], b[i - 1], b[i]].every(Number.isFinite)) continue;
    const prev = a[i - 1] - b[i - 1];
    const cur = a[i] - b[i];
    if (prev !== 0 && cur !== 0 && prev * cur < 0) n += 1;
  }
  return n;
}

function renderCharts() {
  if (!document.body.classList.contains('dashboard-active')) return;

  const btc = lastFinite(series.btc);
  const ptb = lastFinite(series.ptb);
  const dist = lastFinite(series.signedDist);
  const ask = lastFinite(series.ask);
  const bid = lastFinite(series.bid);
  const pnl = lastFinite(series.pnl);
  const crosses = countCrosses(series.btc, series.ptb);

  const crossLabel =
    btc != null && ptb != null
      ? `BTC ${btc.toFixed(1)} · PTB ${ptb.toFixed(1)} · ${crosses} flip(s)`
      : '—';
  text('chart-cross-badge', crossLabel);
  text('chart-cross-market-badge', crossLabel);
  text(
    'chart-dist-badge',
    dist != null ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}` : '—',
  );
  text(
    'chart-dist-pos-badge',
    dist != null ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}` : '—',
  );
  text(
    'chart-book-badge',
    ask != null
      ? `ask ${number(ask, 3)}${bid != null ? ` · bid ${number(bid, 3)}` : ''}`
      : '—',
  );
  text('chart-pnl-pos-badge', pnl != null ? money(pnl) : '—');

  const crossLines = [
    { values: series.btc, color: '#10b981', width: 2.4, fill: true },
    { values: series.ptb, color: '#f59e0b', width: 2.2 },
  ];
  drawMultiChart($('chart-cross'), crossLines, {
    crosses: true,
    emptyId: 'chart-cross-empty',
    digits: 1,
  });
  drawMultiChart($('chart-cross-market'), crossLines, {
    crosses: true,
    emptyId: 'chart-cross-market-empty',
    digits: 1,
  });

  drawMultiChart(
    $('chart-dist'),
    [{ values: series.signedDist, color: '#38bdf8', width: 2.3, fill: true }],
    { zeroLine: true, zeroCrosses: true, emptyId: 'chart-dist-empty', digits: 2 },
  );
  drawMultiChart(
    $('chart-dist-pos'),
    [{ values: series.signedDist, color: '#38bdf8', width: 2.3, fill: true }],
    { zeroLine: true, zeroCrosses: true, emptyId: 'chart-dist-pos-empty', digits: 2 },
  );

  drawMultiChart(
    $('chart-book'),
    [
      { values: series.ask, color: '#f59e0b', width: 2.2, fill: true },
      { values: series.bid, color: '#a78bfa', width: 2 },
    ],
    { emptyId: 'chart-book-empty', digits: 3 },
  );

  drawMultiChart(
    $('chart-pnl-pos'),
    [
      {
        values: series.pnl,
        color: Number(pnl) < 0 ? '#ef4444' : '#10b981',
        width: 2.3,
        fill: true,
      },
    ],
    { zeroLine: true, unit: '$', emptyId: 'chart-pnl-pos-empty' },
  );
}

const MODE_COPY = {
  shadow: {
    title: 'SHADOW',
    explain: 'Mercado real, decisões reais, sem ordens na Polymarket.',
    badge: 'Shadow · sem dinheiro real',
    tone: 'warn',
  },
  live: {
    title: 'LIVE',
    explain: 'Ordens reais no CLOB. Canário + preflight obrigatórios.',
    badge: 'Live · capital em risco',
    tone: 'err',
  },
  'dry-run': {
    title: 'DRY-RUN',
    explain: 'Teste local: intents sem exchange.',
    badge: 'Dry-run',
    tone: 'idle',
  },
};

const SECTION_TITLES = {
  overview: 'Visão geral',
  market: 'Mercado & Gates',
  position: 'Posição & PnL',
  orders: 'Ordens',
  controls: 'Controles',
  strategies: 'Estratégias',
  audit: 'Auditoria',
  system: 'Sistema',
};

/** Metadados dos 9 gates de evaluateEntryGates (MIDAS/TFC). */
const GATE_META = {
  terminalWindow: {
    label: 'Janela terminal',
    group: 'timing',
    need: 'secsLeft entre 5s e 30s',
  },
  distance: {
    label: 'Distância BTC↔PTB',
    group: 'spot',
    need: '|btc−ptb| < 40',
  },
  flips: {
    label: 'Flips do favorito',
    group: 'spot',
    need: 'flips ≥ min (MIDAS: 0)',
  },
  favoriteSide: {
    label: 'Lado favorito',
    group: 'spot',
    need: 'UP ou DOWN definido',
  },
  velocity: {
    label: 'Velocidade adversa',
    group: 'spot',
    need: '|Δspot| em 5s ≤ 8',
  },
  askBand: {
    label: 'Faixa de ask',
    group: 'book',
    need: 'ask entre 0.55 e 0.94',
  },
  spread: {
    label: 'Spread',
    group: 'book',
    need: 'ask−bid ≤ 0.03',
  },
  oddsSum: {
    label: 'Soma das odds',
    group: 'book',
    need: 'upAsk+downAsk ∈ [0.98, 1.06]',
  },
  obi: {
    label: 'OBI (book imbalance)',
    group: 'book',
    need: 'obi ≥ 0 (MIDAS)',
  },
};

const GATE_GROUPS = [
  { id: 'timing', title: '1 · Timing da janela 5m' },
  { id: 'spot', title: '2 · Spot BTC × Price-to-Beat' },
  { id: 'book', title: '3 · Book Polymarket (lado favorito)' },
];

const GATE_LABELS = Object.fromEntries(
  Object.entries(GATE_META).map(([k, v]) => [k, v.label]),
);

const ENTRY_GATE_ORDER = [
  'terminalWindow',
  'distance',
  'flips',
  'favoriteSide',
  'velocity',
  'askBand',
  'spread',
  'oddsSum',
  'obi',
];

const TERMINAL_ORDER_STATES = new Set(['MATCHED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

function text(id, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = value == null || value === '' ? '—' : String(value);
}

function number(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

function money(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function duration(ms) {
  const total = Math.floor(Number(ms || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('pt-BR', { hour12: false });
}

function shortId(value, n = 10) {
  if (!value) return '—';
  const s = String(value);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function setPnlTone(el, value) {
  if (!el) return;
  const n = Number(value);
  el.classList.toggle('is-pos', Number.isFinite(n) && n > 0);
  el.classList.toggle('is-neg', Number.isFinite(n) && n < 0);
}

function showAlert(message, kind = 'error') {
  alertBox.textContent = message;
  alertBox.dataset.kind = kind;
  alertBox.classList.remove('hidden');
}

function clearAlert() {
  alertBox.classList.add('hidden');
  alertBox.textContent = '';
}

/** ——— Dialogs e toasts no layout do app (sem window.alert/confirm/prompt) ——— */
function showToast(message, kind = 'ok', opts = {}) {
  const stack = $('toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.kind = kind;
  const title =
    kind === 'error' ? 'Erro' : kind === 'warning' ? 'Atenção' : kind === 'ok' ? 'OK' : 'Info';
  toast.innerHTML = `<span class="toast__title">${title}</span><span>${escapeHtml(message)}</span>`;
  stack.append(toast);
  const ttl = Number(opts.ttlMs ?? 4200);
  const timer = setTimeout(() => {
    toast.remove();
  }, ttl);
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    toast.remove();
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function closeModal() {
  const root = $('modal-root');
  if (!root) return;
  root.classList.remove('is-open');
  root.setAttribute('aria-hidden', 'true');
  root.replaceChildren();
  document.body.classList.remove('modal-open');
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.kicker]
 * @param {'default'|'warning'|'danger'} [opts.kind]
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {boolean} [opts.typed] — exige digitar confirmToken
 * @param {string} [opts.confirmToken]
 * @returns {Promise<boolean|string|null>} true/false em confirm; string|null em typed
 */
function openAppDialog(opts = {}) {
  const root = $('modal-root');
  if (!root) return Promise.resolve(opts.typed ? null : false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };

    const kind = opts.kind || 'default';
    const typed = opts.typed === true;
    const token = String(opts.confirmToken || opts.confirmLabel || 'OK');

    root.replaceChildren();
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('aria-label', 'Fechar');
    backdrop.addEventListener('click', () => finish(typed ? null : false));

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
    dialog.dataset.kind = kind;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'app-modal-title');

    const kicker = document.createElement('p');
    kicker.className = 'modal-dialog__kicker';
    kicker.textContent = opts.kicker || (typed ? 'Confirmação sensível' : 'Confirmar ação');

    const title = document.createElement('h2');
    title.className = 'modal-dialog__title';
    title.id = 'app-modal-title';
    title.textContent = opts.title || 'Confirmar';

    const body = document.createElement('p');
    body.className = 'modal-dialog__body';
    body.textContent = opts.body || '';

    dialog.append(kicker, title, body);

    let input = null;
    if (typed) {
      const field = document.createElement('label');
      field.className = 'modal-dialog__field';
      const span = document.createElement('span');
      span.textContent = `Digite ${token} para confirmar`;
      input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = token;
      const hint = document.createElement('p');
      hint.className = 'modal-dialog__hint';
      hint.textContent = `Token: ${token}`;
      field.append(span, input, hint);
      dialog.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--ghost btn--sm';
    cancelBtn.textContent = opts.cancelLabel || 'Cancelar';
    cancelBtn.addEventListener('click', () => finish(typed ? null : false));

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className =
      kind === 'danger'
        ? 'btn btn--danger btn--sm'
        : kind === 'warning'
          ? 'btn btn--warning btn--sm'
          : 'btn btn--primary btn--sm';
    confirmBtn.textContent = opts.confirmLabel || 'Confirmar';
    confirmBtn.addEventListener('click', () => {
      if (typed) {
        if (input.value !== token) {
          input.focus();
          input.select();
          showToast(`Digite exatamente ${token}`, 'warning');
          return;
        }
        finish(input.value);
        return;
      }
      finish(true);
    });

    actions.append(cancelBtn, confirmBtn);
    dialog.append(actions);
    root.append(backdrop, dialog);

    const onKey = (event) => {
      if (!root.classList.contains('is-open')) {
        document.removeEventListener('keydown', onKey);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        document.removeEventListener('keydown', onKey);
        finish(typed ? null : false);
        return;
      }
      if (event.key === 'Enter' && typed && document.activeElement === input) {
        event.preventDefault();
        confirmBtn.click();
      }
    };
    document.addEventListener('keydown', onKey);

    (input || confirmBtn).focus();
  });
}

function appConfirm(opts) {
  return openAppDialog({
    kind: opts.kind || 'warning',
    kicker: opts.kicker || 'Confirmar',
    title: opts.title,
    body: opts.body,
    confirmLabel: opts.confirmLabel || 'Confirmar',
    cancelLabel: opts.cancelLabel || 'Cancelar',
  }).then((ok) => ok === true);
}

function appPromptToken(opts) {
  return openAppDialog({
    kind: opts.kind || 'danger',
    kicker: opts.kicker || 'Ação sensível',
    title: opts.title,
    body: opts.body,
    confirmLabel: opts.confirmLabel || 'Confirmar',
    cancelLabel: opts.cancelLabel || 'Cancelar',
    typed: true,
    confirmToken: opts.token,
  });
}

function showLoginMessage(message = '') {
  const messageBox = $('login-message');
  messageBox.textContent = message;
  messageBox.classList.toggle('hidden', !message);
}

function setConnectionState(health) {
  const dot = $('connection-dot');
  const label = $('connection-label');
  const processUp = Boolean(health?.healthy) || Boolean(health?.state);
  const ready = Boolean(health?.ready);
  const ok = Boolean(health?.ok);
  const degraded = processUp && !ok;
  dot.className = `dot ${ready ? 'dot--ok' : processUp ? 'dot--warn' : 'dot--err'}`;
  label.textContent = ready
    ? 'Engine pronta'
    : processUp
      ? degraded
        ? 'Engine degradada'
        : 'Engine online'
      : 'Engine indisponível';
}

async function api(url, options = {}) {
  const { acceptError = false, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !acceptError) {
    const error = new Error(body.reason || `HTTP_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function emptyRow(body, columns, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columns;
  cell.className = 'empty';
  cell.textContent = message;
  row.append(cell);
  body.append(row);
}

function appendCells(row, values, opts = {}) {
  for (const raw of values) {
    const value = raw == null || raw === '' ? '—' : String(raw);
    const cell = document.createElement('td');
    cell.textContent = value;
    cell.title = value;
    if (opts.mono !== false) cell.classList.add('mono-cell');
    row.append(cell);
  }
}

function stateChip(state) {
  const s = String(state || '').toUpperCase();
  const span = document.createElement('span');
  span.className = 'state-chip';
  span.textContent = s || '—';
  if (['MATCHED', 'FILLED'].includes(s)) span.classList.add('state-chip--ok');
  else if (['CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(s)) span.classList.add('state-chip--bad');
  else if (['LIVE', 'OPEN', 'DELAYED', 'PENDING', 'SUBMITTED'].includes(s)) span.classList.add('state-chip--open');
  else span.classList.add('state-chip--idle');
  return span;
}

function orderRow(order) {
  return [
    fmtTime(order.updatedAtMs || order.createdAtMs),
    order.intentId ? shortId(order.intentId, 14) : '—',
    order.kind,
    order.tokenSide,
    order.state,
    `${number(order.qtyFilled)} / ${number(order.qty)}`,
    number(order.price),
    order.orderType,
    order.marketId ? shortId(order.marketId, 22) : '—',
    order.reason ? shortId(order.reason, 24) : '—',
  ];
}

function appendOrderCells(row, values, stateIndex = -1) {
  values.forEach((raw, idx) => {
    if (idx === stateIndex) {
      const cell = document.createElement('td');
      cell.className = 'cell-state';
      cell.append(stateChip(raw));
      row.append(cell);
      return;
    }
    const value = raw == null || raw === '' ? '—' : String(raw);
    const cell = document.createElement('td');
    cell.textContent = value;
    cell.title = value;
    cell.classList.add('mono-cell');
    row.append(cell);
  });
}

function renderOpenOrders(orders = [], targetId = 'open-orders-body', cols = 10) {
  const body = $(targetId);
  if (!body) return;
  body.replaceChildren();
  const colCount = targetId === 'overview-open-orders-body' ? 6 : cols;
  if (!orders.length) return emptyRow(body, colCount, 'Nenhuma ordem aberta');
  for (const order of orders) {
    const row = document.createElement('tr');
    row.className = 'row--open';
    if (targetId === 'overview-open-orders-body') {
      appendOrderCells(
        row,
        [
          fmtTime(order.updatedAtMs || order.createdAtMs),
          order.kind,
          order.tokenSide,
          order.state,
          `${number(order.qtyFilled)} / ${number(order.qty)}`,
          number(order.price),
        ],
        3,
      );
    } else {
      appendOrderCells(
        row,
        [
          fmtTime(order.updatedAtMs || order.createdAtMs),
          order.kind,
          order.tokenSide,
          order.state,
          `${number(order.qtyFilled)} / ${number(order.qty)}`,
          number(order.price),
          order.orderType,
          order.hasExchangeId ? 'sim' : 'não',
          order.marketId ? shortId(order.marketId, 22) : '—',
          order.reason ? shortId(order.reason, 24) : '—',
        ],
        3,
      );
    }
    body.append(row);
  }
}

function renderOrders(orders = []) {
  const body = $('orders-body');
  body.replaceChildren();
  text('orders-count', `${orders.length} total`);
  const matched = orders.filter((o) => String(o.state).toUpperCase() === 'MATCHED').length;
  const canceled = orders.filter((o) =>
    ['CANCELED', 'CANCELLED'].includes(String(o.state).toUpperCase()),
  ).length;
  const rejected = orders.filter((o) => String(o.state).toUpperCase() === 'REJECTED').length;
  text('orders-stat-matched', matched);
  text('orders-stat-canceled', canceled);
  text('orders-stat-rejected', rejected);

  if (!orders.length) return emptyRow(body, 10, 'Nenhuma ordem');
  for (const order of [...orders].reverse()) {
    const row = document.createElement('tr');
    if (!TERMINAL_ORDER_STATES.has(String(order.state).toUpperCase())) {
      row.className = 'row--open';
    }
    appendOrderCells(row, orderRow(order), 4);
    body.append(row);
  }
}

function renderCatalog(catalog = {}, activeStrategyId = null, activePresetId = null) {
  const body = $('catalog-body');
  body.replaceChildren();
  const entries = catalog.strategies ?? [];
  if (!entries.length) return emptyRow(body, 7, 'Catálogo indisponível');
  for (const entry of entries) {
    const row = document.createElement('tr');
    const active =
      entry.strategyId === activeStrategyId &&
      (!activePresetId || entry.presetId === activePresetId);
    if (active) row.classList.add('row--active');
    const mark = document.createElement('td');
    mark.textContent = active ? 'ATIVA' : '';
    mark.className = active ? 'tag-active' : '';
    row.append(mark);
    appendCells(row, [
      entry.strategyId,
      entry.version,
      entry.presetId,
      (entry.marketScope ?? []).join(', '),
      entry.approval,
      entry.canary?.hardCapUsd != null ? money(entry.canary.hardCapUsd) : '—',
    ]);
    body.append(row);
  }
}

function renderAudit(rows = []) {
  const body = $('audit-body');
  body.replaceChildren();
  text('audit-count', rows.length);
  if (!rows.length) return emptyRow(body, 5, 'Nenhum evento');
  for (const entry of rows) {
    const row = document.createElement('tr');
    const detail = { ...entry };
    delete detail.schemaVersion;
    delete detail.tsMs;
    delete detail.type;
    delete detail.action;
    appendCells(row, [
      entry.tsMs ? new Date(entry.tsMs).toLocaleString('pt-BR') : '—',
      entry.type,
      entry.action,
      entry.ok == null ? '—' : entry.ok ? 'OK' : 'FALHA',
      JSON.stringify(detail),
    ]);
    body.append(row);
  }
}

/** Monta mapa de gates a partir de entry.gates ou diagnostics de fixture. */
function resolveGates(status) {
  const entry = status?.diagnostics?.entry;
  if (entry?.gates && Object.keys(entry.gates).length) {
    return { entry, gates: entry.gates, source: 'entry' };
  }
  const diag = status?.diagnostics ?? {};
  const pseudo = {};
  if (diag.btc != null || diag.threshold != null) {
    const btc = Number(diag.btc);
    const threshold = Number(diag.threshold);
    const crossed = Number.isFinite(btc) && Number.isFinite(threshold) && btc >= threshold;
    pseudo.btc = {
      pass: Number.isFinite(btc),
      detail: Number.isFinite(btc) ? `btc=${btc.toFixed(2)}` : 'btc indisponível',
    };
    pseudo.threshold = {
      pass: Number.isFinite(threshold),
      detail: Number.isFinite(threshold) ? `threshold=${threshold}` : 'threshold n/a',
    };
    pseudo.cross = {
      pass: crossed,
      detail: crossed ? 'btc >= threshold (ENTER UP)' : 'btc < threshold (sem enter)',
    };
  }
  if (diag.skip) {
    pseudo.skip = { pass: false, detail: String(diag.skip) };
  }
  if (diag.feedsHealthy === false) {
    pseudo.feeds = { pass: false, detail: 'feeds unhealthy' };
  }
  if (Object.keys(pseudo).length) {
    return {
      entry: { ok: Object.values(pseudo).every((g) => g.pass), gates: pseudo },
      gates: pseudo,
      source: 'diagnostics',
    };
  }
  return { entry: entry ?? null, gates: {}, source: 'none' };
}

function gateLabel(key) {
  return GATE_META[key]?.label || GATE_LABELS[key] || key;
}

function renderGatesList(listEl, entry, { rich = false, limit = null, emptyMessage = null } = {}) {
  if (!listEl) return { pass: 0, total: 0 };
  listEl.replaceChildren();
  const gates = entry?.gates ?? {};
  const knownKeys = ENTRY_GATE_ORDER.filter((k) => k in gates);
  const extraKeys = Object.keys(gates).filter((k) => !ENTRY_GATE_ORDER.includes(k));
  let keys = [...knownKeys, ...extraKeys];
  if (limit != null) keys = keys.slice(0, limit);

  let pass = 0;
  for (const key of Object.keys(gates)) {
    if (gates[key]?.pass) pass += 1;
  }
  const total = Object.keys(gates).length;

  if (!keys.length) {
    if (rich) {
      const empty = document.createElement('div');
      empty.className = 'gates-list__empty';
      empty.textContent =
        emptyMessage ||
        'Sem avaliação de gates neste tick (feed stale, skip ou estratégia sem gates).';
      listEl.append(empty);
    } else {
      const li = document.createElement('li');
      li.className = 'gates-list__empty';
      li.textContent =
        emptyMessage ||
        'Sem avaliação de gates neste tick (fora da janela, feed stale ou estratégia sem gates).';
      listEl.append(li);
    }
    return { pass: 0, total: 0 };
  }

  if (rich) {
    for (const group of GATE_GROUPS) {
      const groupKeys = keys.filter((k) => (GATE_META[k]?.group || 'book') === group.id);
      if (!groupKeys.length) continue;
      const section = document.createElement('section');
      section.className = 'gates-group';
      const title = document.createElement('h4');
      title.className = 'gates-group__title';
      const gPass = groupKeys.filter((k) => gates[k]?.pass).length;
      title.textContent = `${group.title} · ${gPass}/${groupKeys.length}`;
      section.append(title);
      const grid = document.createElement('div');
      grid.className = 'gates-group__grid';
      for (const key of groupKeys) {
        const g = gates[key] ?? {};
        const card = document.createElement('article');
        card.className = `gate-card ${g.pass ? 'gate--ok' : 'gate--fail'}`;
        card.innerHTML = `
          <div class="gate-head">
            <span class="gate-name">${gateLabel(key)}</span>
            <span class="gate-status">${g.pass ? 'OK' : 'BLOQUEIA'}</span>
          </div>
          <p class="gate-need">${GATE_META[key]?.need || ''}</p>
          <span class="gate-detail">${g.detail ?? (g.pass ? 'critério satisfeito' : 'falhou')}</span>
        `;
        grid.append(card);
      }
      section.append(grid);
      listEl.append(section);
    }
    // unknown keys
    const unknown = keys.filter((k) => !GATE_META[k]);
    if (unknown.length) {
      const section = document.createElement('section');
      section.className = 'gates-group';
      section.innerHTML = `<h4 class="gates-group__title">Outros</h4>`;
      const grid = document.createElement('div');
      grid.className = 'gates-group__grid';
      for (const key of unknown) {
        const g = gates[key] ?? {};
        const card = document.createElement('article');
        card.className = `gate-card ${g.pass ? 'gate--ok' : 'gate--fail'}`;
        card.innerHTML = `
          <div class="gate-head">
            <span class="gate-name">${gateLabel(key)}</span>
            <span class="gate-status">${g.pass ? 'OK' : 'BLOQUEIA'}</span>
          </div>
          <span class="gate-detail">${g.detail ?? '—'}</span>
        `;
        grid.append(card);
      }
      section.append(grid);
      listEl.append(section);
    }
    return { pass, total };
  }

  // compact list (overview)
  for (const key of keys) {
    const g = gates[key] ?? {};
    const li = document.createElement('li');
    li.className = g.pass ? 'gate--ok' : 'gate--fail';
    li.innerHTML = `<strong>${gateLabel(key)}</strong><span>${g.detail ?? (g.pass ? 'ok' : 'falhou')}</span>`;
    listEl.append(li);
  }
  return { pass, total };
}

function renderGates(entry, emptyMessage = null) {
  // market view uses #gates-list as grouped container
  const stats = renderGatesList($('gates-list'), entry, { rich: true, emptyMessage });
  const score = stats.total ? `${stats.pass}/${stats.total}` : '—';
  text('gates-pass-count', stats.total ? `${score} ok` : '—');
  text('gates-pass-count-main', stats.total ? score : '—');

  const watchOnly = entry?.blockedByPosition === true || entry?.watchOnly === true;
  let verdict = '—';
  if (!stats.total) verdict = 'sem avaliação';
  else if (watchOnly && entry?.ok) verdict = 'gates OK · em posição (watch)';
  else if (watchOnly) verdict = 'em posição · gates em watch';
  else if (entry?.ok) verdict = 'ENTRADA LIBERADA';
  else verdict = `${stats.total - stats.pass} bloqueando`;

  text('gates-verdict', verdict);
  const badge = $('market-entry-badge');
  if (badge) {
    const allOk = entry?.ok === true && !watchOnly;
    badge.textContent = !stats.total
      ? 'SEM GATES'
      : allOk
        ? 'ENTRADA LIBERADA'
        : watchOnly
          ? 'WATCH (em posição)'
          : 'ENTRADA BLOQUEADA';
    badge.className = `badge ${allOk ? 'badge--accent' : 'badge--warn'}`;
  }
  text(
    'gates-board-hint',
    watchOnly
      ? 'Posição aberta: critérios de entrada em modo watch (não dispara ENTER). Os 9 gates MIDAS continuam sendo avaliados a cada tick.'
      : 'Os 9 gates de evaluateEntryGates — entrada só se todos estiverem OK e a conta estiver flat.',
  );
  return stats;
}

function renderOverviewGates(entry, emptyMessage = null) {
  const stats = renderGatesList($('overview-gates-list'), entry, { rich: false, emptyMessage });
  const total = stats.total;
  const pass = stats.pass;
  const pct = total ? Math.round((pass / total) * 100) : 0;
  const bar = $('overview-gates-bar');
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.classList.toggle('is-fail', total > 0 && pass < total);
  }
  text(
    'overview-gates-text',
    total
      ? entry?.ok
        ? `Todos os ${total} critérios satisfeitos — entrada liberada.`
        : `${pass} de ${total} critérios ok · ${total - pass} bloqueando a entrada.`
      : emptyMessage || 'Aguardando avaliação de gates neste tick…',
  );
  const badge = $('overview-entry-badge');
  if (badge) {
    badge.textContent = entry?.ok ? 'PASSAM' : total ? 'BLOQUEADOS' : '—';
    badge.className = `badge ${entry?.ok ? 'badge--accent' : 'badge--warn'}`;
  }
}

function renderMarketEmptyState(status, gateSource) {
  const alert = $('market-empty-alert');
  if (!alert) return;
  const strategyId = status.strategyId || '—';
  const source = status.market?.sourceKind || status.diagnostics?.sourceKind || '—';
  const isFixture = strategyId.includes('fixture') || source === 'fixture';
  const noGates = gateSource === 'none';

  text(
    'market-page-sub',
    `${strategyId} · source ${source} · ${status.mode || '—'}`,
  );

  if (isFixture || noGates) {
    alert.classList.remove('hidden');
    alert.dataset.kind = 'warning';
    alert.textContent = isFixture
      ? `Engine em ${strategyId} (fixture): não há gates MIDAS/BTC reais (tempo restante, ask, OBI…). Para o painel completo: npm run local com MIDAS + btc5m (default novo).`
      : 'Ainda sem gates neste tick — feed pode estar aquecendo (AWAITING_FEEDS / CLOB_NO_SAMPLE). Aguarde alguns segundos.';
  } else {
    alert.classList.add('hidden');
    alert.textContent = '';
  }
}

function renderHealthItems(listEl, health = {}, mode = 'shadow') {
  if (!listEl) return;
  listEl.replaceChildren();
  const isLive = String(mode).toLowerCase() === 'live';
  const items = [
    { label: 'Feeds (RTDS/CLOB)', ok: health.feedsOk === true },
    { label: 'Recovery / reconcile', ok: health.recoveryOk === true },
    { label: 'User channel WS', ok: health.userChannelOk === true },
    { label: 'Pronto (ready)', ok: health.ready === true },
    { label: 'Armada (engine)', ok: health.armed === true },
    {
      label: 'Dinheiro real (live)',
      ok: isLive ? health.live === true : null,
      note: isLive ? (health.live ? 'ATIVO' : 'FALHA') : 'desligado · shadow',
    },
    { label: 'Halted', ok: health.halted !== true, note: health.halted ? 'SIM' : 'não' },
  ];
  for (const item of items) {
    const li = document.createElement('li');
    const neutral = item.ok == null;
    const good = item.ok === true;
    li.className = neutral ? 'health--idle' : good ? 'health--ok' : 'health--bad';
    const dot = neutral ? 'dot--idle' : good ? 'dot--ok' : 'dot--err';
    const statusText = item.note ?? (good ? 'OK' : 'FALHA');
    li.innerHTML = `<span class="dot ${dot}"></span><strong>${item.label}</strong><em>${statusText}</em>`;
    listEl.append(li);
  }
}

function renderHealth(health = {}, slos = {}, mode = 'shadow') {
  renderHealthItems($('health-list'), health, mode);
  renderHealthItems($('overview-health-list'), health, mode);
  text('slo-badge', slos.ok ? 'SLO OK' : 'SLO atenção');
  if ($('slo-badge')) {
    $('slo-badge').className = `badge ${slos.ok ? 'badge--accent' : 'badge--warn'}`;
  }
  text('overview-slo-badge', slos.ok ? 'SLO OK' : 'SLO atenção');
  if ($('overview-slo-badge')) {
    $('overview-slo-badge').className = `badge ${slos.ok ? 'badge--accent' : 'badge--warn'}`;
  }
  text(
    'health-availability',
    health.availability == null ? '—' : `${(Number(health.availability) * 100).toFixed(1)}%`,
  );
  text('health-orphans', `${health.orphanOrders ?? 0} / ${health.openOrders ?? 0}`);
  text('health-userws', health.userChannelOk ? 'OK' : 'FALHA');
  text('health-recovery', health.recoveryOk ? 'OK' : 'FALHA');
}

function renderGuide(status, health) {
  const mode = String(status.mode || '').toLowerCase();
  const live = mode === 'live';
  const armed = status.operatorState === 'ARMED';
  const halted = status.state === 'HALTED' || health?.halted === true;
  const bal = status.preflight?.checks?.balance?.balanceUsd;
  const cta = $('guide-cta');
  const card = $('guide-card');

  let title;
  let body;
  let next;
  let showCta = false;
  let tone = 'ok';

  if (halted) {
    tone = 'err';
    const haltReason = String(status.haltReason || health?.haltReason || '');
    title = 'HALTED';
    if (haltReason.includes('market-rotated') || haltReason.includes('position')) {
      body = 'Mercado fechou com posição aberta — reinicie a Engine após settlement.';
      next = 'Restart Engine → Armar';
    } else {
      body = 'Parado por emergência. Reinício da Engine necessário.';
      next = 'Restart Engine → Armar';
    }
  } else if (!live) {
    tone = 'warn';
    title = 'Simulação (shadow)';
    body = 'Decisões reais, sem ordens na exchange.';
    next = 'Live na Engine + Armar para capital real';
  } else if (!armed) {
    tone = 'warn';
    title = 'Live · desarmado';
    body = `Canário pronto (cap ${
      status.canary?.hardCapUsd != null ? `$${Number(status.canary.hardCapUsd).toFixed(0)}` : '$3'
    }). Aguardando confirmação.`;
    next = 'Validar carteira e liberar entradas';
    showCta = true;
  } else {
    tone = 'ok';
    title = 'Live · operando';
    body = `Entradas liberadas · cap ${
      status.canary?.hardCapUsd != null ? `$${Number(status.canary.hardCapUsd).toFixed(0)}` : '$3'
    }/ordem`;
    next = 'Pausar para parar entradas';
  }

  card.dataset.tone = tone;
  text('guide-eyebrow', live ? 'Dinheiro real' : 'Sem dinheiro');
  text('guide-title', title);
  text('guide-body', body);
  text('guide-next', next);
  text(
    'wallet-balance-banner',
    live ? (Number.isFinite(Number(bal)) ? money(bal) : 'aguarde Armar') : 'n/a shadow',
  );
  if (cta) {
    cta.hidden = !showCta;
    cta.disabled = actionRunning || halted;
  }
}

function updateControls(status) {
  const operatorState = status.operatorState;
  for (const button of document.querySelectorAll(
    '#control-grid-primary button, #control-grid-advanced button',
  )) {
    const action = button.dataset.action;
    let disabled = actionRunning;
    if (action === 'arm') disabled ||= operatorState === 'ARMED' || status.state === 'HALTED';
    if (action === 'pause') disabled ||= operatorState !== 'ARMED' || status.state === 'HALTED';
    if (action === 'stop') disabled ||= operatorState === 'DISARMED' || status.state === 'HALTED';
    if (action === 'flatten') disabled ||= !(Number(status.position?.qty) > 0) || status.state === 'HALTED';
    if (action === 'rollback') disabled ||= operatorState !== 'DISARMED';
    if (action === 'kill') disabled ||= status.state === 'HALTED';
    button.disabled = disabled;
  }
  const cta = $('guide-cta');
  if (cta) {
    cta.disabled =
      actionRunning ||
      status.operatorState === 'ARMED' ||
      status.state === 'HALTED' ||
      String(status.mode).toLowerCase() !== 'live';
  }
}

function renderMode(status, health) {
  const mode = String(status.mode || 'shadow').toLowerCase();
  const copy = MODE_COPY[mode] ?? {
    title: `Modo ${mode}`,
    explain: 'Modo operacional da Engine.',
    badge: mode,
    tone: 'idle',
  };
  text('mode-title', 'Modo');
  text('mode-name', copy.title);
  text('mode-explain', copy.explain);
  text('topbar-mode', copy.badge);
  text('env-badge-label', copy.badge);
  const envDot = $('env-badge')?.querySelector('.dot');
  if (envDot) {
    envDot.className = `dot dot--${copy.tone === 'err' ? 'err' : copy.tone === 'warn' ? 'warn' : 'ok'}`;
  }
  text('operator-state', status.operatorState);
  text('engine-state', status.state);
  text('entry-enabled', status.entryEnabled ? 'LIBERADAS' : 'BLOQUEADAS');
  const entriesPill = $('topbar-entries');
  if (entriesPill) {
    entriesPill.textContent = status.entryEnabled ? 'Entradas ON' : 'Entradas OFF';
    entriesPill.classList.toggle('topbar-pill--live', Boolean(status.entryEnabled));
    entriesPill.classList.toggle('topbar-pill--blocked', !status.entryEnabled);
  }
}

function renderWallet(status) {
  const mode = String(status.mode || '').toLowerCase();
  const bal = status.preflight?.checks?.balance;
  const balanceUsd = bal?.balanceUsd;
  const allowanceUsd =
    bal?.allowanceUnlimited === true
      ? 'ilimitado'
      : bal?.allowanceUsd != null && Number(bal.allowanceUsd) > 1e9
        ? 'ilimitado'
        : bal?.allowanceUsd;
  const preflightLabel = status.preflight?.ok
    ? `OK · ${status.preflight.checkedAt ? new Date(status.preflight.checkedAt).toLocaleTimeString('pt-BR') : ''}`
    : status.preflight
      ? 'FALHA'
      : mode === 'shadow' || mode === 'dry-run'
        ? 'n/a shadow'
        : 'ainda não armou';

  text('overview-wallet-mode', mode === 'live' ? 'live' : mode || '—');
  text('overview-canary-cap', status.canary ? money(status.canary.hardCapUsd) : '—');
  text(
    'overview-canary-entries',
    status.canary?.maxEntriesPerControlWindow != null
      ? String(status.canary.maxEntriesPerControlWindow)
      : '—',
  );
  text('overview-live-reverse', status.canary ? (status.canary.liveReverse ? 'ativado' : 'bloqueado') : '—');

  if (mode === 'shadow' || mode === 'dry-run') {
    const hasBalance = Number.isFinite(Number(balanceUsd));
    if (hasBalance) {
      text('wallet-balance', money(balanceUsd));
      text('wallet-note', 'shadow · leitura CLOB');
      text('wallet-balance-detail', money(balanceUsd));
      text('wallet-balance-pos', money(balanceUsd));
      text(
        'wallet-allowance',
        allowanceUsd === 'ilimitado' ? 'ilimitado' : money(allowanceUsd),
      );
      text('wallet-preflight', preflightLabel);
      text('wallet-preflight-short', 'leitura CLOB');
      text('overview-wallet-balance', money(balanceUsd));
      text(
        'overview-wallet-allowance',
        allowanceUsd === 'ilimitado' ? 'ilimitado' : money(allowanceUsd),
      );
      text('overview-wallet-preflight', preflightLabel);
      text(
        'wallet-explain',
        'Shadow: saldo lido do CLOB só para exibição (não envia ordens). Atualiza ~1 min. Em live, o preflight completo roda ao Armar.',
      );
      text(
        'overview-wallet-explain',
        'Saldo real via CLOB (display-only em shadow). Cap canário limita risco quando for live.',
      );
      text(
        'wallet-balance-banner',
        money(balanceUsd),
      );
    } else {
      text('wallet-balance', 'n/a');
      text('wallet-note', 'shadow · sem snapshot');
      text('wallet-balance-detail', 'n/a');
      text('wallet-balance-pos', 'n/a');
      text('wallet-allowance', '—');
      text('wallet-preflight', status.preflight ? (status.preflight.ok ? 'OK' : 'FALHA') : 'sem leitura');
      text('wallet-preflight-short', 'sem snapshot');
      text('overview-wallet-balance', 'n/a');
      text('overview-wallet-allowance', '—');
      text('overview-wallet-preflight', preflightLabel);
      text(
        'wallet-explain',
        'Sem snapshot de carteira. Confira POLYMARKET_* no .env e reinicie com npm run local. Live usa preflight ao Armar.',
      );
      text(
        'overview-wallet-explain',
        'Carteira indisponível neste tick. Em shadow o saldo vem de leitura CLOB se as chaves estiverem no .env.',
      );
    }
    return;
  }
  text('wallet-balance', money(balanceUsd));
  text('wallet-note', bal?.ok === false ? 'preflight falhou' : 'via preflight');
  text('wallet-balance-detail', money(balanceUsd));
  text('wallet-balance-pos', money(balanceUsd));
  text(
    'wallet-allowance',
    allowanceUsd === 'ilimitado' ? 'ilimitado' : money(allowanceUsd),
  );
  text('wallet-preflight', preflightLabel);
  text(
    'wallet-preflight-short',
    status.preflight?.ok ? 'preflight OK' : status.preflight ? 'preflight falhou' : 'sem preflight',
  );
  text('overview-wallet-balance', money(balanceUsd));
  text(
    'overview-wallet-allowance',
    allowanceUsd === 'ilimitado' ? 'ilimitado' : money(allowanceUsd),
  );
  text('overview-wallet-preflight', preflightLabel);
  text(
    'wallet-explain',
    'Saldo/allowance vêm do preflight live. Ao armar, a Engine revalida. Não é mark-to-market contínuo da carteira.',
  );
  text(
    'overview-wallet-explain',
    'Saldo via preflight live (não tick-a-tick). Cap canário limita risco por ordem.',
  );
}

function renderDiagnosticsExtras(status) {
  const diag = status.diagnostics ?? {};
  const market = status.market ?? {};
  text('market-asset-detail', market.asset);
  text('market-interval-detail', market.window);
  text(
    'market-source-detail',
    `${market.sourceKind ?? '—'} · ${
      market.sourceOk === true ? 'OK' : market.sourceReason || '—'
    }`,
  );
  text('market-in-position', market.inPosition || diag.inPosition ? 'sim' : 'não');
  text('market-skip', diag.skip || '—');

  const danger = diag.danger;
  text(
    'diag-danger',
    danger?.active ? `ATIVO · ${danger.reason || 'danger'}` : danger ? 'inativo' : '—',
  );
  const late = diag.lateFlip;
  text(
    'diag-lateflip',
    late?.action && late.action !== 'HOLD' ? String(late.action) : late ? 'HOLD' : '—',
  );
  const liq = diag.liquidity;
  const liqLabel = liq
    ? `${liq.ok === false ? 'baixa' : 'ok'} · depth ${number(liq.liq, 2)} (min ${number(liq.minRatio, 2)}×qty)`
    : market.inPosition
      ? 'n/a em posição'
      : '—';
  text('diag-liquidity', liqLabel);
  text('post-liq', liqLabel);
  const tier = diag.tier;
  const tierLabel = tier
    ? `ask ${number(tier.ask, 3)} · budget ${money(tier.entryBudgetUsed)}${
        tier.tierApplied ? ' · TIER' : ''
      }`
    : '—';
  text('diag-tier', tierLabel);
  text('post-tier', tierLabel);
  text('post-skip', diag.skip || '—');
  text('diag-reversed', diag.reversed ? 'sim' : 'não');
  text('diag-closed', diag.closed ? 'sim' : 'não');
}

function render(status, health, instances) {
  lastStatus = status;
  const market = status.market ?? {};
  const pos = status.position ?? {};
  const openOrders = status.openOrders ?? [];
  const resolved = resolveGates(status);
  const entry = resolved.entry;

  renderMode(status, health);
  renderGuide(status, health);

  text('strategy-id', status.strategyId);
  text('strategy-preset', status.canary?.presetId || status.catalog?.presetId || '—');
  text('asset-label', market.asset || '—');
  text('market-window', market.window || '—');
  text('market-id', shortId(market.marketId || status.lastMarketId, 28));
  text(
    'secs-left',
    market.secsLeft != null ? `${number(market.secsLeft, 1)}s restantes` : '—',
  );
  text('approval', status.catalog?.approval);
  text('canary-cap', status.canary ? `cap ${money(status.canary.hardCapUsd)}` : 'cap —');
  text('pnl-realized', money(pos.realizedPnl));
  setPnlTone($('pnl-realized'), pos.realizedPnl);
  text(
    'exposure-notional',
    status.accountExposure?.openNotional != null
      ? `exposição ${money(status.accountExposure.openNotional)}`
      : 'exposição —',
  );

  const hasPos = Number(pos.qty) > 0;
  text('overview-position', hasPos ? `${pos.side || '—'} · ${number(pos.qty)}` : 'FLAT');
  text(
    'overview-position-meta',
    hasPos ? `avg ${number(pos.avgPrice)}` : 'sem posição aberta',
  );

  text('open-orders-count', openOrders.length);
  text('orders-stat-open', openOrders.length);
  text('orders-open-badge', `${openOrders.length} abertas`);
  text('overview-orders-badge', `${openOrders.length} abertas`);
  text('pending-intents', `${status.pendingIntentCount ?? 0} pending`);
  text('source-commit', status.deployment?.sourceCommit?.slice(0, 12));
  text('instance-short', shortId(status.strategyInstanceId, 28));
  text('instance-id', status.strategyInstanceId);
  text('instance-count', `${instances.length} ativa${instances.length === 1 ? '' : 's'}`);
  text('uptime', duration(status.uptimeMs));
  text('uptime-badge', `Uptime ${duration(status.uptimeMs)}`);
  text('last-update', `Atualizado em ${new Date().toLocaleTimeString('pt-BR')}`);

  text('market-asset', market.asset);
  text('market-interval', market.window);
  text('market-id-full', market.marketId || status.lastMarketId);
  text('market-secs', market.secsLeft != null ? `${number(market.secsLeft, 1)} s` : '—');
  text('market-fav', market.favoriteSide);
  text(
    'market-ask',
    market.ask != null
      ? `${number(market.ask, 3)}${market.bid != null ? ` / ${number(market.bid, 3)}` : ''}`
      : '—',
  );
  text('market-bid', number(market.bid, 3));
  text(
    'market-entry-ok',
    market.entryWatchOnly
      ? market.entryOk
        ? 'OK · watch'
        : 'BLOQ · watch'
      : market.entryOk
        ? 'PASSAM'
        : 'BLOQUEADOS',
  );
  text(
    'market-source',
    `${market.sourceKind ?? health?.snapshotSource?.kind ?? '—'} · ${
      market.sourceOk === true || health?.snapshotSource?.ok === true
        ? 'OK'
        : market.sourceReason || health?.snapshotSource?.reason || '—'
    }`,
  );
  const feedOk = health?.feedsOk === true && market.sourceOk !== false;
  text('feed-badge', feedOk ? 'feed OK' : 'feed atenção');
  if ($('feed-badge')) {
    $('feed-badge').className = `badge ${feedOk ? 'badge--accent' : 'badge--warn'}`;
  }

  const emptyGatesMsg =
    resolved.source === 'none'
      ? status.strategyId?.includes('fixture')
        ? 'Estratégia fixture não emite gates MIDAS. Suba com midas-carry-v1 + btc5m para ver critérios reais.'
        : 'Sem gates neste tick (feed ainda aquecendo ou fora da janela).'
      : null;
  const gateStats = renderGates(entry, emptyGatesMsg);
  renderOverviewGates(entry, emptyGatesMsg);
  renderMarketEmptyState(status, resolved.source);
  renderDiagnosticsExtras(status);

  pushSeries({
    ts: Date.now(),
    btc: Number.isFinite(Number(market.btc)) ? Number(market.btc) : null,
    ptb: Number.isFinite(Number(market.priceToBeat)) ? Number(market.priceToBeat) : null,
    signedDist: Number.isFinite(Number(market.signedDistance))
      ? Number(market.signedDistance)
      : null,
    ask: Number.isFinite(Number(market.ask)) ? Number(market.ask) : null,
    bid: Number.isFinite(Number(market.bid)) ? Number(market.bid) : null,
    pnl: Number.isFinite(Number(pos.realizedPnl)) ? Number(pos.realizedPnl) : null,
    fav: market.favoriteSide || null,
  });
  renderCharts();

  text('position-side', pos.side);
  text('position-qty', number(pos.qty));
  text('position-avg', number(pos.avgPrice));
  text('position-market', pos.marketId || '—');
  text('position-pnl', money(pos.realizedPnl));
  setPnlTone($('position-pnl'), pos.realizedPnl);
  text('position-exposure', money(status.accountExposure?.openNotional));
  text('position-open-qty', number(status.accountExposure?.openQty));
  text('position-instances', status.accountExposure?.instances ?? '—');
  text('position-badge', hasPos ? 'aberta' : 'flat');
  if ($('position-badge')) {
    $('position-badge').className = `badge ${hasPos ? 'badge--warn' : 'badge--accent'}`;
  }

  renderWallet(status);
  text('canary-cap-detail', status.canary ? money(status.canary.hardCapUsd) : '—');
  text(
    'canary-entries',
    status.canary?.maxEntriesPerControlWindow != null
      ? String(status.canary.maxEntriesPerControlWindow)
      : '—',
  );
  text('control-window', status.canary ? duration(status.canary.controlWindowMs) : '—');
  text('live-reverse', status.canary ? (status.canary.liveReverse ? 'ativado' : 'bloqueado') : '—');
  text('canary-preset', status.canary?.presetId || status.catalog?.presetId || '—');

  renderHealth(health, status.slos, status.mode);
  renderOpenOrders(openOrders, 'open-orders-body', 10);
  renderOpenOrders(openOrders, 'overview-open-orders-body', 6);
  renderOrders(status.orders ?? []);
  setConnectionState(health);
  $('diagnostics').textContent = JSON.stringify(
    {
      health,
      market: status.market,
      source: health?.snapshotSource,
      diagnostics: status.diagnostics,
      riskMetrics: status.riskMetrics,
      accountExposure: status.accountExposure,
      preflight: status.preflight,
      slos: status.slos,
      haltReason: status.haltReason,
      openOrders,
    },
    null,
    2,
  );
  updateControls(status);
}

/** ——— Strategy studio state ——— */
const stratStudio = {
  library: null,
  familyId: null,
  version: null,
  presetId: null,
  baseParams: {},
  dirty: false,
  loaded: false,
};

function currentFamily() {
  return stratStudio.library?.families?.find((f) => f.familyId === stratStudio.familyId) || null;
}

function currentVersion() {
  const family = currentFamily();
  return family?.versions?.find((v) => v.version === stratStudio.version) || family?.versions?.[0] || null;
}

function currentPreset() {
  const version = currentVersion();
  return version?.presets?.find((p) => p.presetId === stratStudio.presetId) || version?.presets?.[0] || null;
}

function collectEditedParams() {
  const out = { ...stratStudio.baseParams };
  for (const input of document.querySelectorAll('#strat-params [data-param]')) {
    const key = input.dataset.param;
    const raw = input.value;
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else if (raw !== '' && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

function renderStratParams(preset) {
  const box = $('strat-params');
  if (!box) return;
  box.replaceChildren();
  const params = preset?.params || {};
  // Prefer full param object; editableKeys defines order, then remaining keys
  const ordered = [
    ...(preset?.editableKeys || []),
    ...Object.keys(params).filter((k) => !(preset?.editableKeys || []).includes(k)),
  ];
  const runtimeKeys = new Set(preset?.runtimeKeys || ordered);
  const labOnlyKeys = new Set(preset?.labOnlyKeys || []);
  stratStudio.baseParams = { ...params };

  const runtimeKeysList = ordered.filter((k) => runtimeKeys.has(k) && k in params);
  const labKeysList = ordered.filter((k) => labOnlyKeys.has(k) && k in params);
  const otherKeys = ordered.filter(
    (k) => k in params && !runtimeKeys.has(k) && !labOnlyKeys.has(k),
  );

  function appendGroup(title, keys, { labOnly = false } = {}) {
    if (!keys.length) return;
    const section = document.createElement('div');
    section.className = 'strat-param-group';
    const h = document.createElement('h4');
    h.className = 'strat-param-group__title';
    h.textContent = `${title} · ${keys.length}`;
    section.append(h);
    const grid = document.createElement('div');
    grid.className = 'strat-params';
    for (const key of keys) {
      const value = params[key];
      const field = document.createElement('div');
      field.className = `strat-param${labOnly ? ' strat-param--lab' : ''}`;
      const label = document.createElement('label');
      label.setAttribute('for', `param-${key}`);
      label.innerHTML = labOnly
        ? `${key} <em title="Presente no lab; não lido pelo plugin robot">lab</em>`
        : key;
      const input = document.createElement('input');
      input.id = `param-${key}`;
      input.dataset.param = key;
      if (labOnly) {
        input.dataset.labOnly = '1';
        input.title = 'Parâmetro de lab — o runtime data-robot ainda não usa este campo';
      }
      if (typeof value === 'boolean') {
        input.type = 'text';
        input.value = String(value);
      } else if (typeof value === 'number') {
        input.type = 'number';
        input.step = 'any';
        input.value = String(value);
      } else {
        input.type = 'text';
        input.value = value == null ? '' : String(value);
      }
      input.addEventListener('input', () => {
        field.classList.add('is-dirty');
        stratStudio.dirty = true;
      });
      field.append(label, input);
      grid.append(field);
    }
    section.append(grid);
    box.append(section);
  }

  appendGroup('Runtime (ativo na engine)', runtimeKeysList);
  appendGroup('Lab only (não wired no robot)', labKeysList, { labOnly: true });
  appendGroup('Outros', otherKeys);

  if (!ordered.filter((k) => k in params).length) {
    box.innerHTML = '<p class="panel__hint">Este preset não expõe parâmetros editáveis.</p>';
  }

  text(
    'strat-params-hint',
    `Params: ${Object.keys(params).length} · runtime ${runtimeKeysList.length} · lab-only ${labKeysList.length}`,
  );
}

function renderStratSelects() {
  const family = currentFamily();
  const versionSel = $('strat-version');
  const presetSel = $('strat-preset');
  if (!family || !versionSel || !presetSel) return;

  versionSel.replaceChildren();
  for (const v of family.versions || []) {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = `${v.version}${v.label ? ` · ${v.label}` : ''}`;
    versionSel.append(opt);
  }
  if (!stratStudio.version || !family.versions.some((v) => v.version === stratStudio.version)) {
    stratStudio.version = family.versions[0]?.version || null;
  }
  versionSel.value = stratStudio.version || '';

  const version = currentVersion();
  presetSel.replaceChildren();
  for (const p of version?.presets || []) {
    const opt = document.createElement('option');
    opt.value = p.presetId;
    opt.textContent = `${p.name}${p.custom ? ' · custom' : ''}${p.role ? ` (${p.role})` : ''}`;
    presetSel.append(opt);
  }
  if (!stratStudio.presetId || !version?.presets?.some((p) => p.presetId === stratStudio.presetId)) {
    stratStudio.presetId = version?.presets?.[0]?.presetId || null;
  }
  presetSel.value = stratStudio.presetId || '';

  const preset = currentPreset();
  text('strat-family-title', family.label || family.familyId);
  text('strat-family-desc', family.description || '—');
  text(
    'strat-runnable-badge',
    family.runnable ? 'executável' : 'só biblioteca',
  );
  if ($('strat-runnable-badge')) {
    $('strat-runnable-badge').className = `badge ${family.runnable ? 'badge--accent' : 'badge--warn'}`;
  }
  text(
    'strat-preset-meta',
    preset
      ? `${preset.presetId} · ${preset.source || 'lab'}${preset.parentPresetId ? ` · base ${preset.parentPresetId}` : ''}`
      : '—',
  );
  renderStratParams(preset);
  stratStudio.dirty = false;
}

function renderStratFamilies() {
  const box = $('strat-families');
  if (!box || !stratStudio.library) return;
  box.replaceChildren();
  for (const family of stratStudio.library.families || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `strat-family-btn${family.familyId === stratStudio.familyId ? ' is-active' : ''}`;
    btn.innerHTML = `<strong>${family.label}</strong><span>${family.pluginId} · ${(family.versions || []).length} ver.</span>`;
    btn.addEventListener('click', () => {
      stratStudio.familyId = family.familyId;
      stratStudio.version = family.versions?.[0]?.version || null;
      stratStudio.presetId = family.versions?.[0]?.presets?.[0]?.presetId || null;
      renderStratFamilies();
      renderStratSelects();
    });
    box.append(btn);
  }
}

function renderStrategyStudio(library) {
  if (!library?.families?.length) return;
  stratStudio.library = library;
  if (!stratStudio.familyId) {
    const runningPlugin = library.running?.strategyId;
    const match = library.families.find((f) => f.pluginId === runningPlugin);
    stratStudio.familyId = match?.familyId || library.families[0].familyId;
    if (library.running?.version) stratStudio.version = library.running.version;
    if (library.running?.presetId) stratStudio.presetId = library.running.presetId;
  }
  const active = library.active;
  text(
    'strategy-running-badge',
    library.running
      ? `rodando ${library.running.strategyId} · ${library.running.presetId || '—'}`
      : 'rodando —',
  );
  text(
    'strategy-active-badge',
    active
      ? `próxima ${active.pluginId} · ${active.presetId}`
      : 'próxima = env/default',
  );
  if (!stratStudio.dirty || !stratStudio.loaded) {
    renderStratFamilies();
    renderStratSelects();
    stratStudio.loaded = true;
  } else {
    renderStratFamilies();
  }
}

async function loadStrategyStudio() {
  try {
    const library = await api('/api/engine/strategy-library');
    renderStrategyStudio(library);
  } catch (error) {
    text('strat-action-msg', `Biblioteca indisponível: ${error.message}`);
  }
}

async function saveStrategyVersion() {
  const family = currentFamily();
  const version = currentVersion();
  const preset = currentPreset();
  if (!family || !preset) return;
  const name = $('strat-save-name')?.value?.trim() || `${preset.name} custom`;
  try {
    const res = await api('/api/engine/strategy-library/presets', {
      method: 'POST',
      body: JSON.stringify({
        familyId: family.familyId,
        pluginId: family.pluginId,
        baseVersion: version?.version,
        parentPresetId: preset.presetId,
        name,
        params: collectEditedParams(),
        version: `${version?.version || '1.0.0'}-custom`,
      }),
    });
    const msg = `Salvo: ${res.result?.presetId || name}`;
    text('strat-action-msg', msg);
    showToast(msg, 'ok');
    stratStudio.dirty = false;
    stratStudio.loaded = false;
    await loadStrategyStudio();
    if (res.result?.presetId) {
      stratStudio.familyId = family.familyId;
      stratStudio.version = res.result.version;
      stratStudio.presetId = res.result.presetId;
      renderStratFamilies();
      renderStratSelects();
    }
  } catch (error) {
    text('strat-action-msg', `Falha ao salvar: ${error.message}`);
    showToast(`Falha ao salvar: ${error.message}`, 'error');
  }
}

async function activateStrategy() {
  const family = currentFamily();
  const version = currentVersion();
  const preset = currentPreset();
  if (!family || !preset) return;
  if (!family.runnable) {
    text(
      'strat-action-msg',
      'APEX ainda não é executável na engine. Salve o preset para uso futuro.',
    );
    return;
  }
  const ok = await appConfirm({
    kind: 'warning',
    kicker: 'Ativar estratégia',
    title: `${family.label} · ${preset.name}`,
    body: 'A Engine precisa ser reiniciada para aplicar (npm run local ou restart no Coolify). Continuar?',
    confirmLabel: 'Ativar',
  });
  if (!ok) return;
  try {
    const res = await api('/api/engine/strategy-library/activate', {
      method: 'POST',
      body: JSON.stringify({
        familyId: family.familyId,
        pluginId: family.pluginId,
        version: version?.version,
        presetId: preset.presetId,
        params: collectEditedParams(),
      }),
    });
    const msg =
      res.result?.message ||
      'Ativado. Reinicie com npm run local (ou restart no Coolify) para aplicar.';
    text('strat-action-msg', msg);
    showToast(msg, 'ok');
    stratStudio.dirty = false;
    stratStudio.loaded = false;
    await loadStrategyStudio();
  } catch (error) {
    text('strat-action-msg', `Falha ao ativar: ${error.message}`);
    showToast(`Falha ao ativar: ${error.message}`, 'error');
  }
}

function wireStrategyStudio() {
  $('strat-version')?.addEventListener('change', (e) => {
    stratStudio.version = e.target.value;
    stratStudio.presetId = null;
    stratStudio.dirty = false;
    renderStratSelects();
  });
  $('strat-preset')?.addEventListener('change', (e) => {
    stratStudio.presetId = e.target.value;
    stratStudio.dirty = false;
    renderStratSelects();
  });
  $('strat-reset')?.addEventListener('click', () => {
    stratStudio.dirty = false;
    renderStratSelects();
    text('strat-action-msg', 'Preset restaurado.');
  });
  $('strat-save')?.addEventListener('click', () => saveStrategyVersion());
  $('strat-activate')?.addEventListener('click', () => activateStrategy());
}

async function refresh() {
  try {
    const [status, health, instances, catalog, audit] = await Promise.all([
      api('/api/engine/status'),
      api('/api/engine/health', { acceptError: true }),
      api('/api/engine/instances'),
      api('/api/engine/catalog'),
      api('/api/engine/audit?limit=100'),
    ]);
    clearAlert();
    const healthView = status.health ?? health;
    render(status, healthView, instances);
    renderCatalog(catalog, status.strategyId, status.canary?.presetId || status.catalog?.presetId);
    renderAudit(audit);
    if (currentView === 'strategies') await loadStrategyStudio();
  } catch (error) {
    if (error.status === 401) return showLogin();
    showAlert(`Engine indisponível: ${error.message}`);
  }
}

function showView(viewId, { pushHash = true } = {}) {
  const id = SECTION_TITLES[viewId] ? viewId : 'overview';
  currentView = id;

  for (const view of document.querySelectorAll('.view')) {
    const active = view.dataset.view === id;
    view.classList.toggle('is-active', active);
    if (active) view.removeAttribute('hidden');
    else view.setAttribute('hidden', '');
  }

  text('topbar-section', SECTION_TITLES[id] || 'Visão geral');

  for (const link of document.querySelectorAll('.navlink')) {
    const linkView = link.dataset.view || link.getAttribute('href')?.replace('#', '');
    link.classList.toggle('is-active', linkView === id);
  }

  if (pushHash) {
    const next = `#${id}`;
    if (location.hash !== next) {
      history.replaceState(null, '', next);
    }
  }

  const content = document.querySelector('.content');
  if (content) content.scrollTop = 0;
  closeMobileNav();
  // reflow canvas after view becomes visible
  requestAnimationFrame(() => renderCharts());
  if (id === 'strategies') loadStrategyStudio();
}

window.addEventListener('resize', () => {
  if (document.body.classList.contains('dashboard-active')) renderCharts();
});

function showDashboard() {
  (loginView.closest('.login-wrapper') ?? loginView).classList.add('hidden');
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  document.body.classList.add('dashboard-active');
  document.title = 'Data Robot · Operações';
  const hashView = (location.hash || '#overview').replace('#', '');
  showView(hashView, { pushHash: false });
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

function showLogin() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearSeries();
  closeMobileNav();
  dashboardView.classList.add('hidden');
  document.body.classList.remove('dashboard-active');
  loginView.classList.remove('hidden');
  (loginView.closest('.login-wrapper') ?? loginView).classList.remove('hidden');
  document.title = 'Login · Data Robot';
}

async function runControl(button) {
  const action = button.dataset.action;
  const confirmation = button.dataset.confirm;
  const label = button.querySelector('strong')?.textContent?.trim() || button.textContent.trim();
  const isTyped = button.dataset.typed === 'true';
  const isDanger = button.classList.contains('btn--danger') || button.classList.contains('btn--critical');

  if (isTyped) {
    const typed = await appPromptToken({
      kind: 'danger',
      kicker: 'Ação sensível',
      title: label,
      body: `Esta ação é irreversível no fluxo atual. Digite ${confirmation} para confirmar.`,
      token: confirmation,
      confirmLabel: 'Executar',
    });
    if (typed !== confirmation) {
      if (typed != null) showToast('Confirmação cancelada ou inválida', 'warning');
      return;
    }
  } else {
    const ok = await appConfirm({
      kind: isDanger ? 'danger' : 'warning',
      kicker: 'Controle operacional',
      title: label,
      body: `Confirmar execução de “${label}”?`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
  }

  actionRunning = true;
  updateControls({ operatorState: null, state: null, position: {} });
  try {
    await api(`/api/engine/control/${action}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: confirmation }),
    });
    showToast(`Ação ${label} concluída.`, 'ok');
    showAlert(`Ação ${label} concluída.`, 'warning');
  } catch (error) {
    showToast(`Falha em ${label}: ${error.message}`, 'error');
    showAlert(`Falha em ${label}: ${error.message}`);
  } finally {
    actionRunning = false;
    await refresh();
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  showLoginMessage('');
  submitButton.disabled = true;
  submitButton.textContent = 'Entrando…';
  try {
    await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    $('password').value = '';
    showLoginMessage('');
    showDashboard();
  } catch (error) {
    showLoginMessage(
      error.message === 'DASHBOARD_CREDENTIALS_NOT_CONFIGURED'
        ? 'Configure DASHBOARD_USER e DASHBOARD_PASSWORD no servidor.'
        : 'Credenciais inválidas.',
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Entrar';
  }
});

$('refresh-button').addEventListener('click', refresh);
for (const button of document.querySelectorAll('.logout-button')) {
  button.addEventListener('click', async () => {
    await api('/api/session', { method: 'DELETE' }).catch(() => {});
    showLogin();
  });
}
for (const button of document.querySelectorAll(
  '#control-grid-primary button, #control-grid-advanced button',
)) {
  button.addEventListener('click', () => runControl(button));
}
$('guide-cta')?.addEventListener('click', () => {
  const arm = document.querySelector('#control-grid-primary button[data-action="arm"]');
  if (arm && !arm.disabled) runControl(arm);
});

function openMobileNav() {
  menuButton.classList.add('is-open');
  menuButton.setAttribute('aria-expanded', 'true');
  mobileNav.classList.add('is-open');
  mobileNav.setAttribute('aria-hidden', 'false');
  document.body.classList.add('nav-open');
}

function closeMobileNav() {
  menuButton.classList.remove('is-open');
  menuButton.setAttribute('aria-expanded', 'false');
  mobileNav.classList.remove('is-open');
  mobileNav.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('nav-open');
}

menuButton.addEventListener('click', () => {
  if (mobileNav.classList.contains('is-open')) closeMobileNav();
  else openMobileNav();
});
mobileNav.querySelector('.mobile-nav__backdrop').addEventListener('click', closeMobileNav);
mobileNav.querySelector('.mobile-nav__close').addEventListener('click', closeMobileNav);

for (const link of document.querySelectorAll('.navlink')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const id = link.dataset.view || link.getAttribute('href')?.replace('#', '') || 'overview';
    showView(id);
  });
}

for (const btn of document.querySelectorAll('[data-goto]')) {
  btn.addEventListener('click', () => showView(btn.dataset.goto));
}

window.addEventListener('hashchange', () => {
  if (!document.body.classList.contains('dashboard-active')) return;
  const id = (location.hash || '#overview').replace('#', '');
  if (id !== currentView) showView(id, { pushHash: false });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileNav();
});

wireStrategyStudio();

api('/api/session')
  .then((session) => (session.authenticated ? showDashboard() : showLogin()))
  .catch(showLogin);
