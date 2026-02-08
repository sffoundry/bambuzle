// ─── Config UI — Widget Visibility Toggles ───
// Persists per-printer and chart visibility to localStorage.

const STORAGE_KEY = 'bambuzle_widget_config';

const DEFAULTS = { printers: {}, tempChart: true, progressChart: true, eventsWidget: true };

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
  const tempChart = document.getElementById('temp-chart');
  const progressChart = document.getElementById('progress-chart');
  const dashRight = document.getElementById('dash-right');
  const dashResize = document.getElementById('dash-resize');
  if (chartPanel) chartPanel.classList.toggle('cfg-hidden', !cfg.tempChart && !cfg.progressChart);
  if (tempChart) tempChart.classList.toggle('cfg-hidden', !cfg.tempChart);
  if (progressChart) progressChart.classList.toggle('cfg-hidden', !cfg.progressChart);
  if (dashRight) dashRight.classList.toggle('cfg-hidden', !cfg.eventsWidget);
  if (dashResize) dashResize.classList.toggle('cfg-hidden', !cfg.eventsWidget);
}

export function openConfigModal(cfg, printers, onChanged) {
  const modal = document.getElementById('config-modal');
  const printersList = document.getElementById('config-printers-list');
  const chartsList = document.getElementById('config-charts-list');

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
    printersList.appendChild(label);
  }

  if (Object.keys(printers).length === 0) {
    printersList.innerHTML = '<span class="config-empty">No printers available</span>';
  }

  // ── Chart toggles ──
  chartsList.innerHTML = '';
  for (const [key, label] of [['tempChart', 'Temperature Chart'], ['progressChart', 'Progress Chart'], ['eventsWidget', 'Events Widget']]) {
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
