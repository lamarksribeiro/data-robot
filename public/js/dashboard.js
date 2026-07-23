const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashboardView = $('dashboard-view');
const alertBox = $('dashboard-alert');
let pollTimer = null;

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
    throw error;
  }
  return body;
}

function renderOrders(orders = []) {
  const body = $('orders-body');
  body.replaceChildren();
  text('orders-count', orders.length);
  if (!orders.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty';
    cell.textContent = 'Nenhuma ordem';
    row.append(cell);
    body.append(row);
    return;
  }
  for (const order of [...orders].reverse()) {
    const row = document.createElement('tr');
    const values = [
      order.intentId,
      order.kind,
      order.tokenSide,
      order.state,
      `${number(order.qtyFilled)} / ${number(order.qty)}`,
      order.marketId,
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value || '—';
      cell.title = value || '';
      row.append(cell);
    }
    body.append(row);
  }
}

function render(status, health) {
  text('engine-state', status.state);
  text('engine-health', health.ready ? 'READY' : health.ok ? 'HEALTHY' : 'DEGRADED');
  text('engine-mode', status.mode);
  text('strategy-id', status.strategyId);
  text('market-id', status.lastMarketId);
  text('approval', status.catalog?.approval);
  text('position-side', status.position?.side);
  text('position-qty', number(status.position?.qty));
  text('position-avg', number(status.position?.avgPrice));
  text('position-pnl', number(status.position?.realizedPnl));
  text('position-badge', Number(status.position?.qty) > 0 ? 'aberta' : 'flat');
  text('canary-cap', status.canary ? `$${number(status.canary.hardCapUsd, 2)}` : '—');
  text(
    'control-window',
    status.canary ? duration(status.canary.controlWindowMs) : '—',
  );
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
      haltReason: status.haltReason,
    },
    null,
    2,
  );
  renderOrders(status.orders);
}

async function refresh() {
  try {
    const [status, health] = await Promise.all([
      api('/api/engine/status'),
      api('/api/engine/health', { acceptError: true }),
    ]);
    clearAlert();
    render(status, health);
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
$('kill-button').addEventListener('click', async () => {
  if (!window.confirm('Confirmar HALT imediato e cancelamento protetivo das ordens abertas?')) return;
  try {
    await api('/api/engine/control/kill', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'HALT' }),
    });
    showAlert('Kill switch acionado. Engine em HALTED.', 'warning');
    await refresh();
  } catch (error) {
    showAlert(`Falha ao acionar kill switch: ${error.message}`);
  }
});

api('/api/session')
  .then((session) => (session.authenticated ? showDashboard() : showLogin()))
  .catch(showLogin);
