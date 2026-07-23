const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashboardView = $('dashboard-view');
const alertBox = $('dashboard-alert');
let pollTimer = null;
let actionRunning = false;

function text(id, value) {
  $(id).textContent = value == null || value === '' ? '—' : String(value);
}

function number(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, '') : '—';
}

function duration(ms) {
  const total = Math.floor(Number(ms || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return `${hours}h ${mins}m`;
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

function appendCells(row, values) {
  for (const raw of values) {
    const value = raw == null || raw === '' ? '—' : String(raw);
    const cell = document.createElement('td');
    cell.textContent = value;
    cell.title = value;
    row.append(cell);
  }
}

function renderOrders(orders = []) {
  const body = $('orders-body');
  body.replaceChildren();
  text('orders-count', orders.length);
  if (!orders.length) return emptyRow(body, 6, 'Nenhuma ordem');
  for (const order of [...orders].reverse()) {
    const row = document.createElement('tr');
    appendCells(row, [
      order.intentId,
      order.kind,
      order.tokenSide,
      order.state,
      `${number(order.qtyFilled)} / ${number(order.qty)}`,
      order.marketId,
    ]);
    body.append(row);
  }
}

function renderCatalog(catalog = {}) {
  const body = $('catalog-body');
  body.replaceChildren();
  const entries = catalog.strategies ?? [];
  if (!entries.length) return emptyRow(body, 5, 'Catálogo indisponível');
  for (const entry of entries) {
    const row = document.createElement('tr');
    appendCells(row, [
      entry.strategyId,
      entry.version,
      entry.presetId,
      (entry.marketScope ?? []).join(', '),
      entry.approval,
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

function updateControls(status) {
  const operatorState = status.operatorState;
  for (const button of document.querySelectorAll('#control-grid button')) {
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
}

function render(status, health, instances) {
  text('operator-state', status.operatorState);
  text('engine-state', status.state);
  text('engine-health', health.ready ? 'READY' : health.ok ? 'HEALTHY' : 'DEGRADED');
  text('engine-mode', status.mode);
  text('strategy-id', status.strategyId);
  text('market-id', status.lastMarketId);
  text('approval', status.catalog?.approval);
  text('entry-enabled', status.entryEnabled ? 'LIBERADAS' : 'BLOQUEADAS');
  text('instance-id', status.strategyInstanceId);
  text('instance-count', `${instances.length} ativa${instances.length === 1 ? '' : 's'}`);
  text('position-side', status.position?.side);
  text('position-qty', number(status.position?.qty));
  text('position-avg', number(status.position?.avgPrice));
  text('position-pnl', number(status.position?.realizedPnl));
  text('position-badge', Number(status.position?.qty) > 0 ? 'aberta' : 'flat');
  text('canary-cap', status.canary ? `$${number(status.canary.hardCapUsd, 2)}` : '—');
  text('control-window', status.canary ? duration(status.canary.controlWindowMs) : '—');
  text('live-reverse', status.canary ? (status.canary.liveReverse ? 'ativado' : 'bloqueado') : '—');
  text('source-commit', status.deployment?.sourceCommit?.slice(0, 12));
  text('uptime', duration(status.uptimeMs));
  text('last-update', `Atualizado em ${new Date().toLocaleTimeString('pt-BR')}`);
  $('diagnostics').textContent = JSON.stringify(
    {
      health,
      source: health.snapshotSource,
      diagnostics: status.diagnostics,
      riskMetrics: status.riskMetrics,
      accountExposure: status.accountExposure,
      preflight: status.preflight,
      haltReason: status.haltReason,
    },
    null,
    2,
  );
  renderOrders(status.orders);
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
    render(status, health, instances);
    renderCatalog(catalog);
    renderAudit(audit);
  } catch (error) {
    if (error.status === 401) return showLogin();
    showAlert(`Engine indisponível: ${error.message}`);
  }
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

function showLogin() {
  clearInterval(pollTimer);
  dashboardView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

async function runControl(button) {
  const action = button.dataset.action;
  const confirmation = button.dataset.confirm;
  if (button.dataset.typed === 'true') {
    const typed = window.prompt(`Ação sensível. Digite ${confirmation} para confirmar.`);
    if (typed !== confirmation) return;
  } else if (!window.confirm(`Confirmar ação ${button.textContent.trim()}?`)) {
    return;
  }
  actionRunning = true;
  updateControls({ operatorState: null, state: null, position: {} });
  try {
    await api(`/api/engine/control/${action}`, {
      method: 'POST',
      body: JSON.stringify({ confirm: confirmation }),
    });
    showAlert(`Ação ${button.textContent.trim()} concluída.`, 'warning');
  } catch (error) {
    showAlert(`Falha em ${button.textContent.trim()}: ${error.message}`);
  } finally {
    actionRunning = false;
    await refresh();
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  text('login-message', 'Autenticando…');
  try {
    await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    $('password').value = '';
    text('login-message', '');
    showDashboard();
  } catch (error) {
    text(
      'login-message',
      error.message === 'DASHBOARD_CREDENTIALS_NOT_CONFIGURED'
        ? 'Configure DASHBOARD_USER e DASHBOARD_PASSWORD no servidor.'
        : 'Credenciais inválidas.',
    );
  }
});

$('refresh-button').addEventListener('click', refresh);
$('logout-button').addEventListener('click', async () => {
  await api('/api/session', { method: 'DELETE' }).catch(() => {});
  showLogin();
});
for (const button of document.querySelectorAll('#control-grid button')) {
  button.addEventListener('click', () => runControl(button));
}

api('/api/session')
  .then((session) => (session.authenticated ? showDashboard() : showLogin()))
  .catch(showLogin);
