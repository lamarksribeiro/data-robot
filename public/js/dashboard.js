const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashboardView = $('dashboard-view');
const alertBox = $('dashboard-alert');
const menuButton = $('menu-button');
const mobileNav = $('mobile-nav');
let pollTimer = null;
let actionRunning = false;
let lastStatus = null;

const MODE_COPY = {
  shadow: {
    title: 'SHADOW — simulação ao vivo',
    explain:
      'A estratégia recebe o mercado real e gera decisões, mas nenhuma ordem vai para a Polymarket. Serve para validar gates, timing e estabilidade sem risco de capital.',
    badge: 'Shadow · sem dinheiro real',
    tone: 'warn',
  },
  live: {
    title: 'LIVE — dinheiro real',
    explain:
      'Ordens são enviadas ao CLOB. Só opere armado após shadow estável, com canário e preflight OK. Reverse ainda bloqueado neste deployment.',
    badge: 'Live · capital em risco',
    tone: 'err',
  },
  'dry-run': {
    title: 'DRY-RUN — teste local',
    explain: 'Modo de desenvolvimento: intents sem exchange.',
    badge: 'Dry-run',
    tone: 'idle',
  },
};

const SECTION_TITLES = {
  overview: 'Visão geral',
  market: 'Mercado',
  'position-pnl': 'Posição & PnL',
  orders: 'Ordens',
  operations: 'Controles',
  strategies: 'Estratégias',
  audit: 'Auditoria',
  'diagnostics-panel': 'Diagnóstico',
  'health-panel': 'Saúde',
  'wallet-canary': 'Carteira',
};

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

function showAlert(message, kind = 'error') {
  alertBox.textContent = message;
  alertBox.dataset.kind = kind;
  alertBox.classList.remove('hidden');
}

function clearAlert() {
  alertBox.classList.add('hidden');
  alertBox.textContent = '';
}

function showLoginMessage(message = '') {
  const messageBox = $('login-message');
  messageBox.textContent = message;
  messageBox.classList.toggle('hidden', !message);
}

function setConnectionState(health) {
  const dot = $('connection-dot');
  const label = $('connection-label');
  const ready = Boolean(health?.ready);
  const healthy = ready || Boolean(health?.ok);
  dot.className = `dot ${ready ? 'dot--ok' : healthy ? 'dot--warn' : 'dot--err'}`;
  label.textContent = ready ? 'Engine pronta' : healthy ? 'Engine degradada' : 'Engine indisponível';
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

function renderOpenOrders(orders = []) {
  const body = $('open-orders-body');
  body.replaceChildren();
  text('open-orders-count', orders.length);
  text('orders-open-badge', `${orders.length} abertas`);
  if (!orders.length) return emptyRow(body, 10, 'Nenhuma ordem aberta');
  for (const order of orders) {
    const row = document.createElement('tr');
    row.className = 'row--open';
    appendCells(row, [
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
    ]);
    body.append(row);
  }
}

function renderOrders(orders = []) {
  const body = $('orders-body');
  body.replaceChildren();
  text('orders-count', `${orders.length} total`);
  if (!orders.length) return emptyRow(body, 10, 'Nenhuma ordem');
  for (const order of [...orders].reverse()) {
    const row = document.createElement('tr');
    if (!['MATCHED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(order.state)) {
      row.className = 'row--open';
    }
    appendCells(row, orderRow(order));
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

function renderGates(entry) {
  const list = $('gates-list');
  list.replaceChildren();
  const gates = entry?.gates ?? {};
  const keys = Object.keys(gates);
  if (!keys.length) {
    const li = document.createElement('li');
    li.className = 'gates-list__empty';
    li.textContent = 'Sem avaliação de gates neste tick (fora da janela ou sem snapshot elegível).';
    list.append(li);
    return;
  }
  for (const key of keys) {
    const g = gates[key] ?? {};
    const li = document.createElement('li');
    li.className = g.pass ? 'gate--ok' : 'gate--fail';
    li.innerHTML = `<strong>${key}</strong><span>${g.detail ?? (g.pass ? 'ok' : 'falhou')}</span>`;
    list.append(li);
  }
}

function renderHealth(health = {}, slos = {}, mode = 'shadow') {
  const list = $('health-list');
  list.replaceChildren();
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
    list.append(li);
  }
  text('slo-badge', slos.ok ? 'SLO OK' : 'SLO atenção');
  $('slo-badge').className = `badge ${slos.ok ? 'badge--accent' : 'badge--warn'}`;
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
    title = 'Parado por emergência (HALTED)';
    body = 'O robô não opera até a Engine ser reiniciada no Coolify.';
    next = 'Peça reinício da Engine e depois Arme de novo.';
  } else if (!live) {
    tone = 'warn';
    title = 'Simulação (shadow)';
    body = 'Mercado real, decisões reais, mas nenhuma ordem vai para a Polymarket. Carteira não aparece aqui.';
    next = 'Para usar dinheiro: ligar live na Engine (já feito pelo time) e então Armar.';
  } else if (!armed) {
    tone = 'warn';
    title = 'Live pronto · ainda desarmado';
    body = 'A Engine pode enviar ordens reais (canário até $3), mas está esperando você confirmar.';
    next = 'Clique em Armar. Isso valida carteira/CLOB e libera entradas.';
    showCta = true;
  } else {
    tone = 'ok';
    title = 'Operando com dinheiro real';
    body = `Entradas liberadas no canário MIDAS. Cap por ordem: ${status.canary?.hardCapUsd != null ? `$${Number(status.canary.hardCapUsd).toFixed(0)}` : '$3'}.`;
    next = 'Para parar entradas sem derrubar o processo: Pausar.';
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
  for (const button of document.querySelectorAll('#control-grid-primary button, #control-grid-advanced button')) {
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
  text('mode-title', 'Como o robô está rodando');
  text('mode-name', copy.title);
  text('mode-explain', copy.explain);
  text('topbar-mode', copy.badge);
  text('env-badge-label', copy.badge);
  const banner = $('mode-banner');
  banner.dataset.tone = copy.tone;
  const envDot = $('env-badge')?.querySelector('.dot');
  if (envDot) {
    envDot.className = `dot dot--${copy.tone === 'err' ? 'err' : copy.tone === 'warn' ? 'warn' : 'ok'}`;
  }
  text('operator-state', status.operatorState);
  text('engine-state', status.state);
  text('entry-enabled', status.entryEnabled ? 'LIBERADAS' : 'BLOQUEADAS');
  text('engine-health', health?.ready ? 'READY' : health?.ok ? 'HEALTHY' : 'DEGRADED');
}

function renderWallet(status) {
  const mode = String(status.mode || '').toLowerCase();
  const bal = status.preflight?.checks?.balance;
  const balanceUsd = bal?.balanceUsd;
  const allowanceUsd = bal?.allowanceUsd;
  if (mode === 'shadow' || mode === 'dry-run') {
    text('wallet-balance', 'n/a');
    text('wallet-note', 'shadow · sem CLOB');
    text('wallet-balance-detail', 'não aplicável em shadow');
    text('wallet-allowance', '—');
    text('wallet-preflight', status.preflight ? (status.preflight.ok ? 'OK (stale)' : 'FALHA') : 'sem preflight');
    text(
      'wallet-explain',
      'Shadow não consulta saldo na Polymarket. O saldo real aparece em live após preflight (arm/start).',
    );
    return;
  }
  text('wallet-balance', money(balanceUsd));
  text('wallet-note', bal?.ok === false ? 'preflight falhou' : 'via preflight');
  text('wallet-balance-detail', money(balanceUsd));
  text('wallet-allowance', money(allowanceUsd));
  text(
    'wallet-preflight',
    status.preflight?.ok
      ? `OK · ${status.preflight.checkedAt ? new Date(status.preflight.checkedAt).toLocaleTimeString('pt-BR') : ''}`
      : status.preflight
        ? 'FALHA'
        : 'ainda não armou',
  );
  text(
    'wallet-explain',
    'Saldo/allowance vêm do preflight live. Ao armar, a Engine revalida. Não é mark-to-market contínuo da carteira.',
  );
}

function render(status, health, instances) {
  lastStatus = status;
  const market = status.market ?? {};
  const pos = status.position ?? {};
  const openOrders = status.openOrders ?? [];

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
  const pnlEl = $('pnl-realized');
  if (pnlEl) {
    const pnl = Number(pos.realizedPnl);
    pnlEl.classList.toggle('is-pos', Number.isFinite(pnl) && pnl > 0);
    pnlEl.classList.toggle('is-neg', Number.isFinite(pnl) && pnl < 0);
  }
  text(
    'exposure-notional',
    status.accountExposure?.openNotional != null
      ? `exposição ${money(status.accountExposure.openNotional)}`
      : 'exposição —',
  );
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
  text('market-ask', number(market.ask));
  text('market-entry-ok', market.entryOk ? 'PASSAM' : 'BLOQUEADOS');
  text(
    'market-source',
    `${market.sourceKind ?? health?.snapshotSource?.kind ?? '—'} · ${
      market.sourceOk === true || health?.snapshotSource?.ok === true ? 'OK' : market.sourceReason || health?.snapshotSource?.reason || '—'
    }`,
  );
  const feedOk = health?.feedsOk === true && (market.sourceOk !== false);
  text('feed-badge', feedOk ? 'feed OK' : 'feed atenção');
  $('feed-badge').className = `badge ${feedOk ? 'badge--accent' : 'badge--warn'}`;
  renderGates(status.diagnostics?.entry);

  text('position-side', pos.side);
  text('position-qty', number(pos.qty));
  text('position-avg', number(pos.avgPrice));
  text('position-market', pos.marketId || '—');
  text('position-pnl', money(pos.realizedPnl));
  text('position-exposure', money(status.accountExposure?.openNotional));
  text('position-open-qty', number(status.accountExposure?.openQty));
  text('position-instances', status.accountExposure?.instances ?? '—');
  text('position-badge', Number(pos.qty) > 0 ? 'aberta' : 'flat');

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
  renderOpenOrders(openOrders);
  renderOrders(status.orders);
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
  } catch (error) {
    if (error.status === 401) return showLogin();
    showAlert(`Engine indisponível: ${error.message}`);
  }
}

function showDashboard() {
  (loginView.closest('.login-wrapper') ?? loginView).classList.add('hidden');
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  document.body.classList.add('dashboard-active');
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

function showLogin() {
  clearInterval(pollTimer);
  closeMobileNav();
  dashboardView.classList.add('hidden');
  document.body.classList.remove('dashboard-active');
  loginView.classList.remove('hidden');
  (loginView.closest('.login-wrapper') ?? loginView).classList.remove('hidden');
}

async function runControl(button) {
  const action = button.dataset.action;
  const confirmation = button.dataset.confirm;
  const label = button.querySelector('strong')?.textContent?.trim() || button.textContent.trim();
  if (button.dataset.typed === 'true') {
    const typed = window.prompt(`Ação sensível. Digite ${confirmation} para confirmar.`);
    if (typed !== confirmation) return;
  } else if (!window.confirm(`Confirmar: ${label}?`)) {
    return;
  }
  actionRunning = true;
  updateControls({ operatorState: null, state: null, position: {} });
  try {
    await api(`/api/engine/control/${action}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: confirmation }),
    });
    showAlert(`Ação ${label} concluída.`, 'warning');
  } catch (error) {
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
for (const button of document.querySelectorAll('#control-grid-primary button, #control-grid-advanced button')) {
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
  link.addEventListener('click', () => {
    const href = link.getAttribute('href');
    const id = href?.replace('#', '') ?? 'overview';
    text('topbar-section', SECTION_TITLES[id] || 'Visão geral');
    for (const peer of document.querySelectorAll(`.navlink[href="${href}"]`)) {
      peer.classList.add('is-active');
    }
    for (const peer of document.querySelectorAll(`.navlink:not([href="${href}"])`)) {
      peer.classList.remove('is-active');
    }
    closeMobileNav();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileNav();
});

api('/api/session')
  .then((session) => (session.authenticated ? showDashboard() : showLogin()))
  .catch(showLogin);
