import { renderPrinterCards, updatePrinterCard } from './dashboard.js';
import { initCharts, loadChartData, destroyCharts, pushLivePoint } from './charts.js';
import { initAlertsUI } from './alerts-ui.js';

const state = {
  printers: {},       // deviceId -> { db, live, connected }
  selectedPrinter: null,
  ws: null,
  reconnectTimer: null,
};

// ─── Auth ───

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const { status } = await res.json();

    const overlay = document.getElementById('login-overlay');
    const loginForm = document.getElementById('login-form');
    const verifyForm = document.getElementById('verify-form');

    if (status === 'authenticated') {
      overlay.classList.add('hidden');
      loadPrinters();
      return;
    }

    overlay.classList.remove('hidden');

    if (status === 'needs_verification') {
      loginForm.classList.add('hidden');
      verifyForm.classList.remove('hidden');
      document.getElementById('login-subtitle').textContent = 'Enter the verification code sent to your email';
    } else {
      loginForm.classList.remove('hidden');
      verifyForm.classList.add('hidden');
      document.getElementById('login-subtitle').textContent = 'Sign in with your BambuLab account';
    }
  } catch {
    // Server unreachable — will retry on WS reconnect
  }
}

function setupAuthForms() {
  const loginForm = document.getElementById('login-form');
  const verifyForm = document.getElementById('verify-form');
  const errorEl = document.getElementById('login-error');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
  function clearError() {
    errorEl.classList.add('hidden');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = loginForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginForm.email.value,
          password: loginForm.password.value,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Login failed');
        return;
      }

      if (data.status === 'needs_verification') {
        loginForm.classList.add('hidden');
        verifyForm.classList.remove('hidden');
        document.getElementById('login-subtitle').textContent = 'Enter the verification code sent to your email';
        return;
      }

      // Authenticated
      document.getElementById('login-overlay').classList.add('hidden');
      loadPrinters();
    } catch (err) {
      showError('Network error — is the server running?');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  verifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = verifyForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyForm.code.value }),
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Verification failed');
        return;
      }

      document.getElementById('login-overlay').classList.add('hidden');
      loadPrinters();
    } catch (err) {
      showError('Network error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  });

  document.getElementById('verify-back').addEventListener('click', () => {
    verifyForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    document.getElementById('login-subtitle').textContent = 'Sign in with your BambuLab account';
    clearError();
  });
}

// ─── WebSocket ───

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);

  state.ws.onopen = () => {
    document.getElementById('connection-status').className = 'status-dot connected';
    document.getElementById('connection-status').title = 'WebSocket connected';
    clearTimeout(state.reconnectTimer);
  };

  state.ws.onclose = () => {
    document.getElementById('connection-status').className = 'status-dot disconnected';
    document.getElementById('connection-status').title = 'WebSocket disconnected';
    state.reconnectTimer = setTimeout(connectWs, 3000);
  };

  state.ws.onerror = () => {};

  state.ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch { /* ignore bad messages */ }
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'state': {
      const { deviceId, state: printerState, connected } = msg.data;
      if (state.printers[deviceId]) {
        state.printers[deviceId].live = printerState;
        state.printers[deviceId].connected = connected;
      } else {
        state.printers[deviceId] = { db: null, live: printerState, connected };
      }
      updatePrinterCard(deviceId, state.printers[deviceId]);
      // Push live data into charts if they're open for this printer
      pushLivePoint(deviceId, printerState);
      break;
    }
    case 'event': {
      addEventRow(msg.data);
      break;
    }
    case 'auth': {
      // Server completed auth (possibly from another browser tab) — refresh
      if (msg.data.status === 'authenticated') {
        document.getElementById('login-overlay').classList.add('hidden');
        loadPrinters();
      }
      break;
    }
  }
}

// ─── Views ───

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');

    if (btn.dataset.view === 'events') loadEvents();
    if (btn.dataset.view === 'alerts') initAlertsUI(state);
  });
});

// ─── Chart Panel ───

document.getElementById('chart-close').addEventListener('click', () => {
  document.getElementById('chart-panel').classList.add('hidden');
  state.selectedPrinter = null;
  destroyCharts();
});

document.getElementById('chart-range').addEventListener('change', () => {
  if (state.selectedPrinter) {
    loadChartData(state.selectedPrinter, document.getElementById('chart-range').value);
  }
});

export function selectPrinter(deviceId) {
  state.selectedPrinter = deviceId;
  const printer = state.printers[deviceId];
  const name = printer?.db?.name || printer?.live?.subtaskName || deviceId;

  document.getElementById('chart-printer-name').textContent = name;
  document.getElementById('chart-panel').classList.remove('hidden');

  initCharts();
  loadChartData(deviceId, document.getElementById('chart-range').value);
}

// ─── Events Table ───

async function loadEvents() {
  try {
    const res = await fetch('/api/events?limit=200');
    const events = await res.json();
    const tbody = document.getElementById('events-body');
    tbody.innerHTML = '';
    for (const evt of events) {
      addEventRow(evt);
    }
  } catch { /* ignore */ }
}

function addEventRow(evt) {
  const tbody = document.getElementById('events-body');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${formatTime(evt.ts)}</td>
    <td>${evt.printer_name || evt.device_id || ''}</td>
    <td>${evt.event_type}</td>
    <td><span class="severity-${evt.severity}">${evt.severity}</span></td>
    <td>${escapeHtml(evt.message || '')}</td>
  `;
  if (tbody.firstChild) {
    tbody.insertBefore(tr, tbody.firstChild);
  } else {
    tbody.appendChild(tr);
  }
  while (tbody.children.length > 200) {
    tbody.removeChild(tbody.lastChild);
  }
}

// ─── Initial Load ───

async function loadPrinters() {
  try {
    const res = await fetch('/api/printers');
    const printers = await res.json();
    for (const p of printers) {
      state.printers[p.device_id] = {
        db: p,
        live: p.live,
        connected: p.connected,
      };
    }
    renderPrinterCards(state.printers, selectPrinter);
  } catch { /* ignore */ }
}

// ─── Helpers ───

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export { state, formatTime, escapeHtml };

// ─── Boot ───

setupAuthForms();
checkAuth();
connectWs();
