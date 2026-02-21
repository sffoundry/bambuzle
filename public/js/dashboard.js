export function renderPrinterCards(printers, config, dashFilters) {
  const container = document.getElementById('printer-cards');
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

export function updatePrinterCard(deviceId, printer, config, dashFilters) {
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
        ${renderSemiGauge(progress || 0, 100, `${progress || 0}%`, 'PROGRESS', '#00cc66')}
        ${renderSemiGauge(live.layerNum || 0, live.totalLayers || 1,
          `${layer}${totalLayers}`, 'LAYER', '#00ff44')}
      </div>
      <div class="gauge-eta">
        <span class="gauge-eta-icon">&#9202;</span>
        <span class="gauge-eta-value">${eta}</span> remaining
        ${file ? `<div class="gauge-file">${escapeHtml(file)}</div>` : ''}
      </div>
    </div>
  ` : (file ? `<div class="card-file">${escapeHtml(file)}</div>` : '');

  card.innerHTML = `
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
    ${gaugeHtml}
  `;
}

function formatDuration(minutes) {
  if (minutes == null || minutes < 0) return '--';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
