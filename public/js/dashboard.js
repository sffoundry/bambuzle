import { confirmDialog } from './confirm-dialog.js';

export function renderPrinterCards(printers, config, dashFilters) {
  const container = document.getElementById('printer-cards');
  latestPrinters = printers;
  wireControls(container, (id) => latestPrinters[id]);
  container.innerHTML = '';

  const total = Object.keys(printers).length;

  if (total === 0) {
    container.innerHTML = `
      <div class="printer-card" style="text-align: center; color: var(--text-dim); cursor: default;">
        <p>No printers found. Check your BambuLab credentials in .env</p>
      </div>
    `;
    return;
  }

  // No printer selected (initial state) — show prompt
  const filterVal = dashFilters?.printer;
  if (!filterVal) {
    container.innerHTML = `
      <div class="printer-card" style="text-align: center; color: var(--text-dim); cursor: default;">
        <p>Select a printer from the dropdown above</p>
      </div>
    `;
    return;
  }

  const showAll = filterVal === '__all__';

  let visibleCount = 0;
  for (const [deviceId, printer] of Object.entries(printers)) {
    const configVisible = config ? config.printers[deviceId] !== false : true;
    const filterVisible = showAll || filterVal === deviceId;
    const visible = configVisible && filterVisible;
    if (visible) visibleCount++;
    const card = createCard(deviceId, printer);
    if (!visible) card.classList.add('cfg-hidden');
    container.appendChild(card);
  }

  if (visibleCount === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'printer-card config-placeholder';
    placeholder.style.cssText = 'text-align: center; color: var(--text-dim); cursor: default;';
    placeholder.innerHTML = '<p>All printers hidden — open Configuration to show them</p>';
    container.appendChild(placeholder);
  }
}

let latestPrinters = {};

export function updatePrinterCard(deviceId, printer, config, dashFilters) {
  latestPrinters[deviceId] = printer;
  wireControls(document.getElementById('printer-cards'), (id) => latestPrinters[id]);
  let card = document.getElementById(`card-${deviceId}`);
  if (!card) {
    const container = document.getElementById('printer-cards');
    // Remove placeholders if present
    const placeholder = container.querySelector('.printer-card[style]');
    if (placeholder) placeholder.remove();
    const cfgPlaceholder = container.querySelector('.config-placeholder');
    if (cfgPlaceholder) cfgPlaceholder.remove();

    card = createCard(deviceId, printer);
    container.appendChild(card);
  } else {
    updateCardContent(card, deviceId, printer);
  }

  // Apply visibility from config and dashboard filters
  const configHidden = config ? config.printers[deviceId] === false : false;
  const fp = dashFilters?.printer;
  const filterHidden = !fp || (fp !== '__all__' && fp !== deviceId);
  card.classList.toggle('cfg-hidden', configHidden || filterHidden);
}

function createCard(deviceId, printer) {
  const card = document.createElement('div');
  card.className = 'printer-card';
  card.id = `card-${deviceId}`;
  updateCardContent(card, deviceId, printer);
  return card;
}

function renderSemiGauge(value, max, label, sublabel, color) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const radius = 40;
  const circumference = Math.PI * radius; // semicircle
  const offset = circumference * (1 - pct);

  return `
    <div class="semi-gauge">
      <svg viewBox="0 0 100 60" class="semi-gauge-svg">
        <path d="M 10 55 A 40 40 0 0 1 90 55"
              fill="none" stroke="var(--border)" stroke-width="6"
              stroke-linecap="round"/>
        <path d="M 10 55 A 40 40 0 0 1 90 55"
              fill="none" stroke="${color}" stroke-width="6"
              stroke-linecap="round"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}"
              class="semi-gauge-fill"/>
      </svg>
      <div class="semi-gauge-value">${label}</div>
      <div class="semi-gauge-label">${sublabel}</div>
    </div>
  `;
}

function updateCardContent(card, deviceId, printer) {
  const live = printer.live || {};
  if (printer.capabilities) printerCaps[deviceId] = printer.capabilities;
  const db = printer.db || {};
  const connected = printer.connected;
  const gcodeState = connected ? (live.gcodeState || 'UNKNOWN') : 'OFFLINE';
  const stateClass = gcodeState.toLowerCase();

  const progress = live.progress ?? null;
  const isDual = live.nozzle2Temp != null || live.extruderCount === 2;
  const nozzle = live.nozzleTemp != null ? `${Math.round(live.nozzleTemp)}°C` : '--';
  const nozzleTarget = live.nozzleTarget != null && live.nozzleTarget > 0 ? ` / ${Math.round(live.nozzleTarget)}°C` : '';
  const nozzle2 = live.nozzle2Temp != null ? `${Math.round(live.nozzle2Temp)}°C` : '--';
  const nozzle2Target = live.nozzle2Target != null && live.nozzle2Target > 0 ? ` / ${Math.round(live.nozzle2Target)}°C` : '';
  const bed = live.bedTemp != null ? `${Math.round(live.bedTemp)}°C` : '--';
  const bedTarget = live.bedTarget != null && live.bedTarget > 0 ? ` / ${Math.round(live.bedTarget)}°C` : '';
  const chamber = live.chamberTemp != null ? `${Math.round(live.chamberTemp)}°C` : '--';
  const layer = live.layerNum != null ? `${live.layerNum}` : '--';
  const totalLayers = live.totalLayers != null ? ` / ${live.totalLayers}` : '';
  const eta = live.remainingMin != null ? formatDuration(live.remainingMin) : '--';
  const wifi = live.wifiSignal != null ? `${live.wifiSignal} dBm` : '--';

  // Speed level
  const SPEED_NAMES = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };
  const speed = live.speedLevel != null ? (SPEED_NAMES[live.speedLevel] || `Lvl ${live.speedLevel}`) : '--';
  const partFan = live.partFanSpeed != null ? `${live.partFanSpeed}%` : '--';
  const auxFan = live.auxFanSpeed != null ? `${live.auxFanSpeed}%` : '--';
  const chamberFan = live.chamberFanSpeed != null ? `${live.chamberFanSpeed}%` : '--';

  const file = live.subtaskName || live.gcodeFile || '';

  const nozzleRows = isDual
    ? `<div class="stat"><span class="stat-label">Nozzle L</span><span class="stat-value">${nozzle}${nozzleTarget}</span></div>
      <div class="stat"><span class="stat-label">Nozzle R</span><span class="stat-value">${nozzle2}${nozzle2Target}</span></div>`
    : `<div class="stat"><span class="stat-label">Nozzle</span><span class="stat-value">${nozzle}${nozzleTarget}</span></div>`;

  const isRunning = gcodeState === 'RUNNING' || gcodeState === 'PREPARE' || gcodeState === 'PAUSE';
  const gaugeHtml = isRunning ? `
    <div class="gauge-section">
      <div class="gauge-row">
        ${renderSemiGauge(progress || 0, 100, `${progress || 0}%`, 'PROGRESS', 'var(--accent)')}
        ${renderSemiGauge(live.layerNum || 0, live.totalLayers || 1,
          `${layer}${totalLayers}`, 'LAYER', 'var(--green)')}
      </div>
      <div class="gauge-eta">
        <span class="gauge-eta-icon">&#9202;</span>
        <span class="gauge-eta-value">${eta}</span> remaining
        ${file ? `<div class="gauge-file">${escapeHtml(file)}</div>` : ''}
      </div>
    </div>
  ` : (file ? `<div class="card-file">${escapeHtml(file)}</div>` : '');

  // Two persistent children: the body is rewritten on every update; the controls container is only
  // touched when its markup changes, so an open speed dropdown or focused button survives (review 2, #6).
  let body = card.querySelector(':scope > .card-body');
  let wrap = card.querySelector(':scope > .card-controls-wrap');
  if (!body || !wrap) {
    card.replaceChildren();
    body = document.createElement('div');
    body.className = 'card-body';
    wrap = document.createElement('div');
    wrap.className = 'card-controls-wrap';
    card.append(body, wrap);
  }
  body.innerHTML = `
    <div class="card-header">
      <span class="printer-name">${escapeHtml(db.name || deviceId)}</span>
      <span class="printer-model">${escapeHtml(db.model || '')}</span>
      <span class="state-badge ${stateClass}">${gcodeState}</span>
    </div>
    <div class="card-stats">
      ${nozzleRows}
      <div class="stat"><span class="stat-label">Bed</span><span class="stat-value">${bed}${bedTarget}</span></div>
      <div class="stat"><span class="stat-label">Chamber</span><span class="stat-value">${chamber}</span></div>
      <div class="stat"><span class="stat-label">WiFi</span><span class="stat-value">${wifi}</span></div>
      <div class="stat"><span class="stat-label">Speed</span><span class="stat-value">${speed}</span></div>
      <div class="stat"><span class="stat-label">Part Fan</span><span class="stat-value">${partFan}</span></div>
      <div class="stat"><span class="stat-label">Aux Fan</span><span class="stat-value">${auxFan}</span></div>
      <div class="stat"><span class="stat-label">Cham Fan</span><span class="stat-value">${chamberFan}</span></div>
    </div>
    ${renderDiagnostics(live.diagnostics, printer.capabilities || printerCaps[deviceId])}
    ${gaugeHtml}
  `;
  const html = renderControls(deviceId, live, connected, gcodeState);
  if (wrap.dataset.html !== html) {
    wrap.innerHTML = html;
    wrap.dataset.html = html;
  }
}



// ─── BAM-28: printer controls ───
// Cards are re-rendered on every MQTT update, so clicks are handled by one delegated listener and the
// last command result is kept per printer (shown for CMD_STATUS_MS) instead of living in the DOM.

const CMD_STATUS_MS = 20000;
const signatureRejected = {}; // deviceId -> true once the printer rejected a command as unsigned
const printerCaps = {}; // deviceId -> capabilities (kept from the printer object on each render)
const cmdStatus = {}; // deviceId -> { text, tone, at, busy }
let controlsWired = false;

function renderControls(deviceId, live, connected, gcodeState) {
  const active = ['RUNNING', 'PREPARE', 'PAUSE'].includes(gcodeState);
  const st = cmdStatus[deviceId];
  // Stay locked after a send until the printer reports a different state (or 10 s pass) — review 2, #7
  if (st?.awaitingState && (gcodeState !== st.awaitingState || Date.now() - st.at > 10000)) st.awaitingState = null;
  const locked = st?.busy || Boolean(st?.awaitingState);
  const showStatus = st && (locked || Date.now() - st.at < CMD_STATUS_MS);
  if (!connected || (!active && !showStatus)) return '';

  // Only offer buttons that can work (server-computed capabilities, docs/architecture-transports.md):
  // 'available' (LAN + Developer Mode) or 'unknown' (old firmware: try). Otherwise explain why not.
  const caps = printerCaps[deviceId];
  if (caps?.control === 'signature_required' || signatureRejected[deviceId]) {
    const hint = caps?.controlHint || 'This printer only accepts commands signed by Bambu\'s apps.';
    return `<div class="ctl-unavailable" title="${escapeHtml(hint)}">Controls unavailable — ${escapeHtml(hint)}</div>`;
  }
  if (caps && !['available', 'unknown'].includes(caps.control)) return '';

  const id = escapeHtml(deviceId);
  const dis = locked ? ' disabled' : '';
  const btn = (action, label, cls = 'btn-secondary') =>
    `<button type="button" class="${cls} ctl-btn" data-ctl="${action}" data-device="${id}"${dis}>${label}</button>`;

  let buttons = '';
  if (active) {
    if (gcodeState === 'PAUSE') buttons += btn('resume', 'Resume');
    else buttons += btn('pause', 'Pause');
    buttons += btn('stop', 'Stop', 'btn-danger');
    const levels = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };
    const opts = Object.entries(levels)
      .map(([v, n]) => `<option value="${v}"${Number(v) === live.speedLevel ? ' selected' : ''}>${n}</option>`).join('');
    buttons += `<select class="ctl-speed" data-device="${id}" title="Print speed"${dis}>${opts}</select>`;
  }
  const status = showStatus
    ? `<div class="ctl-status ${st.tone ? `ctl-${st.tone}` : ''}">${escapeHtml(st.text)}</div>`
    : '';
  return `<div class="card-controls">${buttons}</div>${status}`;
}

async function sendPrinterCommand(deviceId, command, param, rerender, live) {
  cmdStatus[deviceId] = { text: `Sending ${command.replace('_', ' ')}…`, tone: '', at: Date.now(), busy: true };
  rerender();
  // Tell the server what this card showed, so a stale click is refused (review 2, #2)
  const body = { command, expectState: live?.gcodeState ?? null, expectTaskId: live?.taskId ?? null };
  if (param != null) body.param = param;
  try {
    const res = await fetch(`/api/printers/${encodeURIComponent(deviceId)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const text = res.ok ? `${command.replace('_', ' ')}: ${data.outcome || 'sent'}` : (data.error || `Failed (${res.status})`);
    const tone = !res.ok || data.ok === false ? 'error' : data.acknowledged ? 'ok' : 'warn';
    const awaitingState = res.ok && data.ok !== false && command !== 'set_speed' ? live?.gcodeState : null;
    if (data.signatureRequired) signatureRejected[deviceId] = true;
    cmdStatus[deviceId] = { text, tone, at: Date.now(), busy: false, awaitingState };
  } catch {
    cmdStatus[deviceId] = { text: 'Network error — command may not have been sent', tone: 'error', at: Date.now(), busy: false };
  }
  rerender();
}

function wireControls(container, getPrinter) {
  if (controlsWired) return;
  controlsWired = true;
  const rerenderFor = (deviceId) => () => {
    const card = document.getElementById(`card-${deviceId}`);
    const printer = getPrinter(deviceId);
    if (card && printer) updateCardContent(card, deviceId, printer);
  };
  container.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ctl]');
    if (!b || b.disabled) return;
    e.stopPropagation();
    const deviceId = b.dataset.device;
    const printer = getPrinter(deviceId);
    const name = printer?.db?.name || deviceId;
    const live = printer?.live; // snapshot what the user saw when they clicked
    if (b.dataset.ctl === 'stop') {
      const file = live?.subtaskName || live?.gcodeFile || 'the current print';
      const yes = await confirmDialog({
        title: `Stop print on ${name}?`,
        message: `"${file}" will be cancelled. This cannot be undone.`,
        confirmLabel: 'Stop print',
        cancelLabel: 'Keep printing',
        danger: true,
      });
      if (!yes) return;
    }
    sendPrinterCommand(deviceId, b.dataset.ctl, null, rerenderFor(deviceId), live);
  });
  container.addEventListener('change', async (e) => {
    const sel = e.target.closest('.ctl-speed');
    if (!sel) return;
    const deviceId = sel.dataset.device;
    const printer = getPrinter(deviceId);
    const live = printer?.live;
    const label = sel.options[sel.selectedIndex]?.text || sel.value;
    // Explicit confirm: some browsers fire change on a single arrow key (review 2, #6)
    const yes = await confirmDialog({
      title: 'Change print speed?',
      message: `Set ${printer?.db?.name || deviceId} to ${label}.`,
      confirmLabel: `Set ${label}`,
    });
    if (!yes) {
      sel.value = String(live?.speedLevel ?? sel.value);
      return;
    }
    sendPrinterCommand(deviceId, 'set_speed', Number(sel.value), rerenderFor(deviceId), live);
  });
}

// BAM-32: compact chips for printer diagnostics (see src/bambu/diagnostics.js). Absent data → no chip.
function chip(label, value, { tone = '', title = '' } = {}) {
  const cls = tone ? `diag-chip ${tone}` : 'diag-chip';
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="${cls}"${t}><span class="diag-label">${escapeHtml(label)}</span> ${escapeHtml(String(value))}</span>`;
}

function renderDiagnostics(d, caps) {
  if (!d && !caps) return '';
  d = d || {};
  const chips = [];
  if (caps?.transport) {
    chips.push(chip('Via', caps.transport === 'lan' ? 'LAN' : 'Cloud', { title: caps.transport === 'lan' ? 'Connected directly to the printer on the local network' : 'Connected through BambuLab Cloud' }));
  }

  if (d.printError?.active) {
    chips.push(chip('ERR', d.printError.hex, { tone: 'diag-error', title: 'Printer reported print_error — see the printer screen or Bambu wiki' }));
  }

  if (d.nozzles?.length) {
    const fmt = (n) => [n.diameter != null ? `${n.diameter}mm` : null, n.type].filter(Boolean).join(' ');
    const text = d.nozzles.length > 1
      ? d.nozzles.map((n) => `${n.id === 0 ? 'L' : 'R'} ${fmt(n)}`).join(' · ')
      : fmt(d.nozzles[0]);
    if (text) chips.push(chip('Nozzle', text));
  }

  if (d.firmware?.updateAvailable) {
    chips.push(chip('FW', `update ${d.firmware.newVersion || 'available'}`, { tone: 'diag-accent' }));
  } else if (d.firmware?.upgradeStatus && !['IDLE', 'UPGRADE_SUCCESS'].includes(d.firmware.upgradeStatus)) {
    const pct = d.firmware.upgradeProgress != null ? ` ${d.firmware.upgradeProgress}%` : '';
    chips.push(chip('FW', `${d.firmware.upgradeStatus.toLowerCase()}${pct}`, { tone: 'diag-warn' }));
  }

  if (d.aiMonitoring) {
    const a = d.aiMonitoring;
    const on = [
      a.spaghettiDetector && 'spaghetti',
      a.firstLayerInspector && 'first layer',
      a.buildplateMarkerDetector && 'plate marker',
    ].filter(Boolean);
    const halt = a.pauseOnDetection ? ` (pause${a.haltSensitivity ? `, ${a.haltSensitivity}` : ''})` : '';
    chips.push(chip('AI', on.length ? on.join(', ') + halt : 'off', { title: 'Printer-side AI monitoring settings (xcam)' }));
  }

  if (d.sdCard) {
    chips.push(chip('SD', d.sdCard, { tone: d.sdCard === 'abnormal' ? 'diag-error' : d.sdCard === 'missing' ? 'diag-warn' : '' }));
  }

  for (const [i, u] of (d.amsHumidity || []).entries()) {
    const value = u.percent != null ? `${u.percent}% RH` : u.index != null ? `level ${u.index}/5` : null;
    if (value) chips.push(chip(`AMS${(parseInt(u.id, 10) || i) + 1}`, value, { title: 'AMS humidity (level 5 = driest)' }));
  }

  if (d.heatbreakFanSpeed != null) chips.push(chip('Heatbreak', `${d.heatbreakFanSpeed}%`));
  if (d.camera?.timelapse) chips.push(chip('Timelapse', 'on'));
  if (d.developerMode != null) chips.push(chip('Dev mode', d.developerMode ? 'on' : 'off', { title: 'LAN Developer Mode (unsigned MQTT)' }));
  if (d.network?.ip) chips.push(chip('IP', d.network.ip));

  return chips.length ? `<div class="card-diagnostics">${chips.join('')}</div>` : '';
}

function formatDuration(minutes) {
  if (minutes == null || minutes < 0) return '--';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
