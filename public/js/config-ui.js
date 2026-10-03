import { getThemeList, getCurrentThemeId, getThemeSwatchColors, applyTheme } from './themes.js';
import { openConnectionDialog, openAddLanPrinterDialog } from './connection-ui.js';
import { openFilesDialog } from './files-ui.js';
import { openUsersDialog } from './users-ui.js';
import { openPlugDialog, openPowerSettings } from './power-ui.js';
// ─── Config UI — Widget Visibility Toggles ───
// Persists per-printer and chart visibility to localStorage.

const STORAGE_KEY = 'bambuzle_widget_config';

const DEFAULTS = { printers: {}, tempChart: true, eventsWidget: true, amsWidget: true };

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...DEFAULTS, ...saved, printers: { ...saved.printers } };
    }
  } catch { /* corrupt data — reset */ }
  return { ...DEFAULTS, printers: {} };
}

export function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function isWidgetVisible(cfg, key) {
  return cfg[key] !== false;
}

export function isPrinterVisible(cfg, deviceId) {
  return cfg.printers[deviceId] !== false;
}

export function applyVisibility(cfg) {
  const chartPanel = document.getElementById('chart-panel');
  const dashRight = document.getElementById('dash-right');
  const dashResize = document.getElementById('dash-resize');
  const amsWidget = document.getElementById('ams-widget');
  if (chartPanel) chartPanel.classList.toggle('cfg-hidden', !cfg.tempChart);
  // Hide right pane only if both events and AMS are hidden
  const rightPaneHidden = !cfg.eventsWidget && !cfg.amsWidget;
  if (dashRight) dashRight.classList.toggle('cfg-hidden', rightPaneHidden);
  if (dashResize) dashResize.classList.toggle('cfg-hidden', rightPaneHidden);
  if (amsWidget) amsWidget.classList.toggle('cfg-hidden', cfg.amsWidget === false);
}

export function openConfigModal(cfg, printers, onChanged) {
  const modal = document.getElementById('config-modal');
  const printersList = document.getElementById('config-printers-list');
  const chartsList = document.getElementById('config-charts-list');

  renderThemePicker();

  // ── Printer toggles ──
  printersList.innerHTML = '';
  for (const [deviceId, printer] of Object.entries(printers)) {
    const name = printer.db?.name || deviceId;
    const checked = isPrinterVisible(cfg, deviceId);
    const label = document.createElement('label');
    label.innerHTML = `
      <span class="toggle">
        <input type="checkbox" data-printer-id="${escapeAttr(deviceId)}" ${checked ? 'checked' : ''}>
        <span class="slider"></span>
      </span>
      <span>${escapeHtml(name)}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      cfg.printers[deviceId] = e.target.checked;
      onChanged(cfg);
    });
    // BAM-35: per-printer connection settings
    const row = document.createElement('div');
    row.className = 'config-printer-row';
    const via = document.createElement('span');
    via.className = 'config-printer-via';
    const t = printer.capabilities?.transport;
    via.textContent = t === 'lan' ? 'LAN' : t === 'cloud' ? 'Cloud' : 'not connected';
    const connBtn = document.createElement('button');
    connBtn.type = 'button';
    connBtn.className = 'btn-secondary config-conn-btn requires-admin';
    connBtn.textContent = 'Connection…';
    connBtn.addEventListener('click', () => openConnectionDialog(deviceId, name));
    const plugBtn = document.createElement('button');
    plugBtn.type = 'button';
    plugBtn.className = 'btn-secondary config-conn-btn requires-admin';
    plugBtn.textContent = 'Power plug…';
    plugBtn.addEventListener('click', () => openPlugDialog(deviceId, name));
    row.append(label, via, connBtn, plugBtn);
    if (printer.capabilities?.files && printer.capabilities.files !== 'needs_lan') {
      const filesBtn = document.createElement('button');
      filesBtn.type = 'button';
      filesBtn.className = 'btn-secondary config-conn-btn requires-operator';
      filesBtn.textContent = 'SD files…';
      filesBtn.addEventListener('click', () => openFilesDialog(deviceId, name));
      row.append(filesBtn);
    }
    printersList.appendChild(row);
  }
  const addLan = document.createElement('button');
  addLan.type = 'button';
  addLan.className = 'btn-secondary config-add-lan requires-admin';
  addLan.textContent = '+ Add LAN printer';
  addLan.addEventListener('click', () => openAddLanPrinterDialog());
  printersList.appendChild(addLan);
  // BAM-16: user management (admins only — hidden for other roles, enforced server-side)
  if (!document.getElementById('config-users-btn')) {
    const usersBtn = document.createElement('button');
    usersBtn.type = 'button';
    usersBtn.id = 'config-users-btn';
    usersBtn.className = 'btn-secondary config-add-lan requires-admin';
    usersBtn.textContent = 'Users…';
    usersBtn.addEventListener('click', () => openUsersDialog());
    printersList.parentElement.appendChild(usersBtn);
  }
  // BAM-18: electricity price + circuit limits (admins)
  if (!document.getElementById('config-power-btn')) {
    const powerBtn = document.createElement('button');
    powerBtn.type = 'button';
    powerBtn.id = 'config-power-btn';
    powerBtn.className = 'btn-secondary config-add-lan requires-admin';
    powerBtn.textContent = 'Power settings…';
    powerBtn.addEventListener('click', () => openPowerSettings());
    printersList.parentElement.appendChild(powerBtn);
  }

  if (Object.keys(printers).length === 0) {
    // Insert (don't replace the list) so "+ Add LAN printer" stays reachable on a fresh install (review BAM-35 #2)
    const empty = document.createElement('span');
    empty.className = 'config-empty';
    empty.textContent = 'No printers yet';
    printersList.prepend(empty);
  }

  // ── Chart toggles ──
  chartsList.innerHTML = '';
  for (const [key, label] of [['tempChart', 'Charts Panel'], ['eventsWidget', 'Events Widget'], ['amsWidget', 'AMS Widget']]) {
    const el = document.createElement('label');
    el.innerHTML = `
      <span class="toggle">
        <input type="checkbox" data-chart-key="${key}" ${cfg[key] ? 'checked' : ''}>
        <span class="slider"></span>
      </span>
      <span>${label}</span>
    `;
    el.querySelector('input').addEventListener('change', (e) => {
      cfg[key] = e.target.checked;
      onChanged(cfg);
    });
    chartsList.appendChild(el);
  }

  // ── Show modal ──
  modal.classList.remove('hidden');

  // Close button
  const closeBtn = document.getElementById('config-close');
  const closeHandler = () => {
    modal.classList.add('hidden');
    closeBtn.removeEventListener('click', closeHandler);
  };
  closeBtn.addEventListener('click', closeHandler);

  // Click backdrop to close
  const backdropHandler = (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      modal.removeEventListener('click', backdropHandler);
    }
  };
  modal.addEventListener('click', backdropHandler);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Theme picker (themes ported from HamTab) ──
function renderThemePicker() {
  const list = document.getElementById('config-theme-list');
  if (!list) return;
  list.replaceChildren();
  const current = getCurrentThemeId();
  for (const t of getThemeList()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch' + (t.id === current ? ' active' : '');
    btn.setAttribute('aria-pressed', String(t.id === current));
    const colors = document.createElement('span');
    colors.className = 'theme-swatch-colors';
    for (const c of getThemeSwatchColors(t.id)) {
      const dot = document.createElement('span');
      dot.style.background = c;
      colors.appendChild(dot);
    }
    const name = document.createElement('span');
    name.className = 'theme-swatch-name';
    name.textContent = t.name;
    const desc = document.createElement('span');
    desc.className = 'theme-swatch-desc';
    desc.textContent = t.description;
    btn.append(colors, name, desc);
    btn.addEventListener('click', () => {
      applyTheme(t.id);
      renderThemePicker();
    });
    list.appendChild(btn);
  }
}

