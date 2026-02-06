import { renderPrinterCards, updatePrinterCard } from './dashboard.js';
import { initCharts, loadChartData, destroyCharts, pushLivePoint } from './charts.js';
import { initAlertsUI } from './alerts-ui.js';

const state = {
  printers: {},       // deviceId -> { db, live, connected }
  selectedPrinter: null,
  ws: null,
  reconnectTimer: null,
};

// ─── Events State ───

let allEvents = [];
let eventSortCol = 'ts';
let eventSortDir = 'desc';

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

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const EVENT_COLUMNS = ['ts', 'printer', 'event_type', 'severity', 'message'];

function initEventSorting() {
  const headers = document.querySelectorAll('#events-table thead th');
  headers.forEach((th, i) => {
    const col = EVENT_COLUMNS[i];
    th.addEventListener('click', () => {
      if (eventSortCol === col) {
        eventSortDir = eventSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        eventSortCol = col;
        eventSortDir = col === 'ts' ? 'desc' : 'asc';
      }
      updateSortIndicators();
      renderEvents();
    });
  });
  updateSortIndicators();
}

function updateSortIndicators() {
  const headers = document.querySelectorAll('#events-table thead th');
  headers.forEach((th, i) => {
    const col = EVENT_COLUMNS[i];
    const base = th.textContent.replace(/[\u25B2\u25BC]\s*/g, '').trim();
    if (col === eventSortCol) {
      const arrow = eventSortDir === 'asc' ? '\u25B2' : '\u25BC';
      th.textContent = `${arrow} ${base}`;
    } else {
      th.textContent = base;
    }
  });
}

function initEventFilters() {
  const printerFilter = document.getElementById('filter-printer');
  const typeFilter = document.getElementById('filter-type');
  const severityFilter = document.getElementById('filter-severity');

  // Populate printer options from known printers
  populatePrinterFilter();

  printerFilter.addEventListener('change', renderEvents);
  typeFilter.addEventListener('change', renderEvents);
  severityFilter.addEventListener('change', renderEvents);
}

function populatePrinterFilter() {
  const printerFilter = document.getElementById('filter-printer');
  const current = printerFilter.value;
  const opts = ['<option value="">All Printers</option>'];
  for (const [deviceId, printer] of Object.entries(state.printers)) {
    const name = printer.db?.name || deviceId;
    opts.push(`<option value="${escapeHtml(deviceId)}">${escapeHtml(name)}</option>`);
  }
  printerFilter.innerHTML = opts.join('');
  printerFilter.value = current;
}

function getFilteredSortedEvents() {
  const printerVal = document.getElementById('filter-printer').value;
  const typeVal = document.getElementById('filter-type').value;
  const severityVal = document.getElementById('filter-severity').value;

  let filtered = allEvents;

  if (printerVal) {
    filtered = filtered.filter((e) => e.device_id === printerVal);
  }
  if (typeVal) {
    filtered = filtered.filter((e) => e.event_type === typeVal);
  }
  if (severityVal) {
    filtered = filtered.filter((e) => e.severity === severityVal);
  }

  filtered.sort((a, b) => {
    let cmp = 0;
    switch (eventSortCol) {
      case 'ts':
        cmp = (a.ts || '').localeCompare(b.ts || '');
        break;
      case 'printer':
        cmp = (a.printer_name || a.device_id || '').localeCompare(b.printer_name || b.device_id || '');
        break;
      case 'event_type':
        cmp = (a.event_type || '').localeCompare(b.event_type || '');
        break;
      case 'severity':
        cmp = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
        break;
      case 'message':
        cmp = (a.message || '').localeCompare(b.message || '');
        break;
    }
    return eventSortDir === 'asc' ? cmp : -cmp;
  });

  return filtered;
}

function renderEvents() {
  const tbody = document.getElementById('events-body');
  tbody.innerHTML = '';
  const events = getFilteredSortedEvents();
  for (const evt of events) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatTime(evt.ts)}</td>
      <td>${escapeHtml(evt.printer_name || evt.device_id || '')}</td>
      <td>${escapeHtml(evt.event_type || '')}</td>
      <td><span class="severity-${evt.severity}">${evt.severity}</span></td>
      <td>${escapeHtml(evt.message || '')}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadEvents() {
  try {
    const res = await fetch('/api/events?limit=200');
    allEvents = await res.json();
    populatePrinterFilter();
    renderEvents();
  } catch { /* ignore */ }
}

function addEventRow(evt) {
  allEvents.unshift(evt);
  if (allEvents.length > 200) allEvents.length = 200;
  renderEvents();
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
initEventSorting();
initEventFilters();
