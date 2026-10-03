import { initTheme } from './themes.js';
import { renderPrinterCards, updatePrinterCard } from './dashboard.js';
import { initCharts, loadChartData, destroyCharts, pushLivePoint, setZoomCallback, highlightEvent } from './charts.js';
import { initAlertsUI } from './alerts-ui.js';
import { initStatsUI } from './stats.js';
import { initMaintenanceUI } from './maintenance.js';
import { initAuditUI } from './audit.js';
import { renderAmsWidget, updateAmsWidget } from './ams-widget.js';
import { loadConfig, saveConfig, openConfigModal, applyVisibility } from './config-ui.js';

const state = {
  printers: {},       // deviceId -> { db, live, connected }
  selectedPrinter: null,
  ws: null,
  reconnectTimer: null,
};

// ─── Config State ───

let uiConfig = loadConfig();

// ─── Dashboard Filters ───

const dashFilters = { printer: '', type: '', severity: '', range: '24h', from: '', to: '' };

// ─── Dashboard Events State ───

let dashEvents = [];
let dashEventSortCol = 'ts';
let dashEventSortDir = 'desc';
let selectedEventTs = null;

// ─── Events View State ───

let allEvents = [];
let eventSortCol = 'ts';
let eventSortDir = 'desc';

// ─── Dashboard session (BAM-30 admin token) ───

/** Resolves true when this browser may use the API; otherwise shows the token form. */
async function ensureDashboardSession() {
  try {
    const res = await fetch('/api/session');
    const { required, authenticated } = await res.json();
    if (!required || authenticated) return true;
  } catch {
    return false;
  }
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('admin-form').classList.remove('hidden');
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('verify-form').classList.add('hidden');
  document.getElementById('login-subtitle').textContent = 'Enter the dashboard admin token';
  return false;
}

async function startDashboard() {
  if (!(await ensureDashboardSession())) return;
  checkAuth();
  if (!state.ws) connectWs();
}

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
  const adminForm = document.getElementById('admin-form');
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

  adminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const btn = adminForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: adminForm.token.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Invalid admin token');
        return;
      }
      adminForm.reset();
      adminForm.classList.add('hidden');
      startDashboard();
    } catch {
      showError('Network error — is the server running?');
    } finally {
      btn.disabled = false;
    }
  });

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
    state.reconnectTimer = setTimeout(async () => {
      // A rejected upgrade looks like a plain close — re-check the dashboard session first
      if (await ensureDashboardSession()) connectWs();
      else state.ws = null;
    }, 3000);
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
      const { deviceId, state: printerState, connected, capabilities } = msg.data;
      if (state.printers[deviceId]) {
        state.printers[deviceId].live = printerState;
        state.printers[deviceId].connected = connected;
        if (capabilities) state.printers[deviceId].capabilities = capabilities;
      } else {
        state.printers[deviceId] = { db: null, live: printerState, connected, capabilities: capabilities || null };
      }
      updatePrinterCard(deviceId, state.printers[deviceId], uiConfig, dashFilters);
      updateAmsWidget(deviceId, state.printers, dashFilters);
      // Push live data into charts if they're open for this printer
      pushLivePoint(deviceId, printerState);
      break;
    }
    case 'event': {
      addEventRow(msg.data);
      addDashEvent(msg.data);
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
    if (btn.dataset.view === 'stats') initStatsUI(state);
    if (btn.dataset.view === 'maintenance') initMaintenanceUI();
    if (btn.dataset.view === 'audit') initAuditUI();
  });
});

// ─── Chart Panel ───

let chartRefreshInterval = null;
const CHART_REFRESH_MS = 60_000;

/**
 * Auto-select which printer to chart based on the dashboard printer filter.
 * Falls back to the first available printer when filter is "All Printers".
 */
function updateChartPrinter() {
  clearInterval(chartRefreshInterval);
  chartRefreshInterval = null;

  const filterVal = document.getElementById('dash-filter-printer').value;

  // No printer selected — clear charts
  if (!filterVal) {
    state.selectedPrinter = null;
    destroyCharts();
    document.getElementById('chart-printer-name').textContent = '';
    return;
  }

  // "All Printers" — chart first available printer
  const deviceId = filterVal === '__all__' ? Object.keys(state.printers)[0] : filterVal;

  if (!deviceId) {
    state.selectedPrinter = null;
    destroyCharts();
    return;
  }

  state.selectedPrinter = deviceId;
  const printer = state.printers[deviceId];
  const name = printer?.db?.name || printer?.live?.subtaskName || deviceId;
  document.getElementById('chart-printer-name').textContent = name;

  initCharts();
  loadChartData(deviceId, dashFilters.range, dashFilters);

  // Auto-refresh chart data every 60s for clean time-series updates
  chartRefreshInterval = setInterval(() => {
    if (state.selectedPrinter) {
      loadChartData(state.selectedPrinter, dashFilters.range, dashFilters);
    }
  }, CHART_REFRESH_MS);
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
    appendHmsWikiLink(tr.lastElementChild, evt);
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
        capabilities: p.capabilities || null,
      };
    }
    populateDashPrinterFilter();
    renderPrinterCards(state.printers, uiConfig, dashFilters);
    renderAmsWidget(state.printers, dashFilters);
    loadDashEvents();
    // Don't auto-select a printer — wait for user to choose from dropdown
    const sel = document.getElementById('dash-filter-printer');
    if (sel.value && sel.value !== '') updateChartPrinter();
  } catch { /* ignore */ }
}

// ─── Helpers ───

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString();
}

// Safe in text AND attribute context (textContent→innerHTML alone leaves quotes unescaped)
function escapeHtml(str) {
  if (str == null || str === '') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HMS_WIKI_INDEX = 'https://wiki.bambulab.com/en/hms/home';
const HMS_KEY_RE = /^[0-9A-F]{4}(_[0-9A-F]{4}){3}$/;

/** Append a DOM-built HMS wiki link to an hms_error message cell (no innerHTML). */
function appendHmsWikiLink(td, evt) {
  if (!td || evt.event_type !== 'hms_error' || !HMS_KEY_RE.test(evt.code || '')) return;
  const href = typeof evt.wiki_url === 'string' && evt.wiki_url.startsWith('https://wiki.bambulab.com/')
    ? evt.wiki_url
    : HMS_WIKI_INDEX;
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = `HMS ${evt.code}`;
  a.textContent = `[${evt.code}]`;
  a.addEventListener('click', (e) => e.stopPropagation());
  td.append(' ', a);
}

export { state, formatTime, escapeHtml };

// ─── Time Range Helpers ───

const TIME_RANGE_SECS = {
  '5m': 300, '10m': 600, '15m': 900, '30m': 1800,
  '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800,
};

function getEffectiveTimeRange() {
  if (dashFilters.range === 'custom') {
    return { from: dashFilters.from, to: dashFilters.to };
  }
  const sec = TIME_RANGE_SECS[dashFilters.range] || 86400;
  return { from: new Date(Date.now() - sec * 1000).toISOString(), to: '' };
}

function toLocalDatetimeString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function onChartZoom(minSec, maxSec) {
  const fromDate = new Date(minSec * 1000);
  const toDate = new Date(maxSec * 1000);
  dashFilters.range = 'custom';
  dashFilters.from = fromDate.toISOString();
  dashFilters.to = toDate.toISOString();
  // Update UI
  document.getElementById('dash-filter-range').value = 'custom';
  const fromInput = document.getElementById('dash-filter-from');
  const toInput = document.getElementById('dash-filter-to');
  fromInput.classList.remove('hidden');
  toInput.classList.remove('hidden');
  fromInput.value = toLocalDatetimeString(fromDate);
  toInput.value = toLocalDatetimeString(toDate);
  // Re-render events client-side (zoomed range is subset of loaded data)
  renderDashEvents();
}

// ─── Dashboard Filter Bar ───

function initDashFilters() {
  const printerSel = document.getElementById('dash-filter-printer');
  const typeSel = document.getElementById('dash-filter-type');
  const severitySel = document.getElementById('dash-filter-severity');
  const rangeSel = document.getElementById('dash-filter-range');
  const fromInput = document.getElementById('dash-filter-from');
  const toInput = document.getElementById('dash-filter-to');

  function onFilterChange() {
    dashFilters.printer = printerSel.value;
    dashFilters.type = typeSel.value;
    dashFilters.severity = severitySel.value;

    renderPrinterCards(state.printers, uiConfig, dashFilters);
    renderAmsWidget(state.printers, dashFilters);
    renderDashEvents();
    updateChartPrinter();
  }

  function onTimeRangeChange() {
    loadDashEvents();
    updateChartPrinter();
  }

  function showCustomPickers(show) {
    fromInput.classList.toggle('hidden', !show);
    toInput.classList.toggle('hidden', !show);
  }

  rangeSel.addEventListener('change', () => {
    dashFilters.range = rangeSel.value;
    if (dashFilters.range === 'custom') {
      showCustomPickers(true);
      // Don't reload yet — wait for user to set dates
    } else {
      showCustomPickers(false);
      dashFilters.from = '';
      dashFilters.to = '';
      onTimeRangeChange();
    }
  });

  fromInput.addEventListener('change', () => {
    dashFilters.from = fromInput.value ? new Date(fromInput.value).toISOString() : '';
    onTimeRangeChange();
  });

  toInput.addEventListener('change', () => {
    dashFilters.to = toInput.value ? new Date(toInput.value).toISOString() : '';
    onTimeRangeChange();
  });

  printerSel.addEventListener('change', onFilterChange);
  typeSel.addEventListener('change', onFilterChange);
  severitySel.addEventListener('change', onFilterChange);
}

function populateDashPrinterFilter() {
  const sel = document.getElementById('dash-filter-printer');
  const current = sel.value;
  const opts = [
    '<option value="" disabled>Select a printer...</option>',
    '<option value="__all__">All Printers</option>',
  ];
  for (const [deviceId, printer] of Object.entries(state.printers)) {
    const name = printer.db?.name || deviceId;
    opts.push(`<option value="${escapeHtml(deviceId)}">${escapeHtml(name)}</option>`);
  }
  sel.innerHTML = opts.join('');
  // Restore previous selection, or keep unselected
  if (current && current !== '') sel.value = current;
}

// ─── Dashboard Events Widget ───

const DASH_EVENT_COLUMNS = ['ts', 'printer', 'event_type', 'severity', 'message'];

async function loadDashEvents() {
  try {
    const { from, to } = getEffectiveTimeRange();
    let url = '/api/events?limit=200';
    if (from) url += `&from=${encodeURIComponent(from)}`;
    if (to) url += `&to=${encodeURIComponent(to)}`;
    const res = await fetch(url);
    dashEvents = await res.json();
    renderDashEvents();
  } catch { /* ignore */ }
}

function addDashEvent(evt) {
  dashEvents.unshift(evt);
  if (dashEvents.length > 200) dashEvents.length = 200;
  renderDashEvents();
}

function renderDashEvents() {
  const tbody = document.getElementById('dash-events-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  selectedEventTs = null;
  highlightEvent(null);

  let filtered = dashEvents;
  if (dashFilters.printer && dashFilters.printer !== '__all__') filtered = filtered.filter((e) => e.device_id === dashFilters.printer);
  if (dashFilters.type) filtered = filtered.filter((e) => e.event_type === dashFilters.type);
  if (dashFilters.severity) filtered = filtered.filter((e) => e.severity === dashFilters.severity);
  if (dashFilters.from) {
    const fromTs = new Date(dashFilters.from).getTime();
    filtered = filtered.filter((e) => {
      const t = new Date(e.ts.endsWith('Z') ? e.ts : e.ts + 'Z').getTime();
      return t >= fromTs;
    });
  }
  if (dashFilters.to) {
    const toTs = new Date(dashFilters.to).getTime();
    filtered = filtered.filter((e) => {
      const t = new Date(e.ts.endsWith('Z') ? e.ts : e.ts + 'Z').getTime();
      return t <= toTs;
    });
  }

  filtered.sort((a, b) => {
    let cmp = 0;
    switch (dashEventSortCol) {
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
    return dashEventSortDir === 'asc' ? cmp : -cmp;
  });

  for (const evt of filtered) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatTime(evt.ts)}</td>
      <td>${escapeHtml(evt.printer_name || evt.device_id || '')}</td>
      <td>${escapeHtml(evt.event_type || '')}</td>
      <td><span class="severity-${evt.severity}">${evt.severity}</span></td>
      <td>${escapeHtml(evt.message || '')}</td>
    `;
    appendHmsWikiLink(tr.lastElementChild, evt);
    tr.addEventListener('click', () => {
      const tsSec = new Date(evt.ts.endsWith('Z') ? evt.ts : evt.ts + 'Z').getTime() / 1000;
      if (selectedEventTs === tsSec) {
        selectedEventTs = null;
        highlightEvent(null);
      } else {
        selectedEventTs = tsSec;
        highlightEvent(tsSec);
      }
      tbody.querySelectorAll('tr.dash-event-selected').forEach(r => r.classList.remove('dash-event-selected'));
      if (selectedEventTs === tsSec) tr.classList.add('dash-event-selected');
    });
    tbody.appendChild(tr);
  }
}

function initDashEventSorting() {
  const table = document.getElementById('dash-events-table');
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  headers.forEach((th, i) => {
    const col = DASH_EVENT_COLUMNS[i];
    th.addEventListener('click', () => {
      if (dashEventSortCol === col) {
        dashEventSortDir = dashEventSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        dashEventSortCol = col;
        dashEventSortDir = col === 'ts' ? 'desc' : 'asc';
      }
      updateDashSortIndicators();
      renderDashEvents();
    });
  });
  updateDashSortIndicators();
}

function updateDashSortIndicators() {
  const table = document.getElementById('dash-events-table');
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  headers.forEach((th, i) => {
    const col = DASH_EVENT_COLUMNS[i];
    const base = th.textContent.replace(/[\u25B2\u25BC]\s*/g, '').trim();
    if (col === dashEventSortCol) {
      const arrow = dashEventSortDir === 'asc' ? '\u25B2' : '\u25BC';
      th.textContent = `${arrow} ${base}`;
    } else {
      th.textContent = base;
    }
  });
}

// ─── Resize Handle ───

function initResizeHandle() {
  const handle = document.getElementById('dash-resize');
  const rightPane = document.getElementById('dash-right');
  if (!handle || !rightPane) return;

  // Restore saved width
  const saved = localStorage.getItem('bambuzle_events_width');
  if (saved) rightPane.style.width = saved + 'px';

  let dragging = false;

  function onStart(e) {
    dragging = true;
    handle.classList.add('dragging');
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const container = handle.parentElement;
    const containerRect = container.getBoundingClientRect();
    const newWidth = containerRect.right - clientX;
    const clamped = Math.max(200, Math.min(newWidth, containerRect.width * 0.6));
    rightPane.style.width = clamped + 'px';
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    localStorage.setItem('bambuzle_events_width', parseInt(rightPane.style.width));
  }

  handle.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);

  handle.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd);
}

// ─── Boot ───

initTheme();
setupAuthForms();
startDashboard();

// Printer added/removed/reconnected (BAM-35 connection settings): reload the list, refresh the open config modal
window.addEventListener('bambuzle:printers-changed', async () => {
  for (const id of Object.keys(state.printers)) delete state.printers[id];
  await loadPrinters();
  if (!document.getElementById('config-modal').classList.contains('hidden')) document.getElementById('config-btn').click();
});

// Theme switch: cards/AMS re-render from CSS vars; uPlot bakes colours in, so rebuild the charts
window.addEventListener('bambuzle:themechange', () => {
  renderPrinterCards(state.printers, uiConfig, dashFilters);
  renderAmsWidget(state.printers, dashFilters);
  if (state.selectedPrinter) updateChartPrinter();
});
initEventSorting();
initEventFilters();
initDashFilters();
initDashEventSorting();
initResizeHandle();
applyVisibility(uiConfig);
setZoomCallback(onChartZoom);

document.getElementById('config-btn').addEventListener('click', () => {
  openConfigModal(uiConfig, state.printers, (updatedCfg) => {
    uiConfig = updatedCfg;
    saveConfig(uiConfig);
    applyVisibility(uiConfig);
    renderPrinterCards(state.printers, uiConfig, dashFilters);
  });
});
