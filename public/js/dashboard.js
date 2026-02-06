let onSelectPrinter = null;

export function renderPrinterCards(printers, selectCallback) {
  onSelectPrinter = selectCallback;
  const container = document.getElementById('printer-cards');
  container.innerHTML = '';

  for (const [deviceId, printer] of Object.entries(printers)) {
    container.appendChild(createCard(deviceId, printer));
  }

  if (Object.keys(printers).length === 0) {
    container.innerHTML = `
      <div class="printer-card" style="text-align: center; color: var(--text-dim); cursor: default;">
        <p>No printers found. Check your BambuLab credentials in .env</p>
      </div>
    `;
  }
}

export function updatePrinterCard(deviceId, printer) {
  let card = document.getElementById(`card-${deviceId}`);
  if (!card) {
    const container = document.getElementById('printer-cards');
    // Remove "no printers" placeholder if present
    const placeholder = container.querySelector('.printer-card[style]');
    if (placeholder) placeholder.remove();

    card = createCard(deviceId, printer);
    container.appendChild(card);
  } else {
    updateCardContent(card, deviceId, printer);
  }
}

function createCard(deviceId, printer) {
  const card = document.createElement('div');
  card.className = 'printer-card';
  card.id = `card-${deviceId}`;
  card.addEventListener('click', () => onSelectPrinter?.(deviceId));
  updateCardContent(card, deviceId, printer);
  return card;
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
  const file = live.subtaskName || live.gcodeFile || '';

  const nozzleRows = isDual
    ? `<div class="stat"><span class="stat-label">Nozzle L</span><span class="stat-value">${nozzle}${nozzleTarget}</span></div>
      <div class="stat"><span class="stat-label">Nozzle R</span><span class="stat-value">${nozzle2}${nozzle2Target}</span></div>`
    : `<div class="stat"><span class="stat-label">Nozzle</span><span class="stat-value">${nozzle}${nozzleTarget}</span></div>`;

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
      <div class="stat"><span class="stat-label">Layer</span><span class="stat-value">${layer}${totalLayers}</span></div>
      <div class="stat"><span class="stat-label">ETA</span><span class="stat-value">${eta}</span></div>
      <div class="stat"><span class="stat-label">WiFi</span><span class="stat-value">${wifi}</span></div>
    </div>
    ${progress != null ? `
    <div class="progress-bar-container">
      <div class="progress-bar" style="width: ${progress}%"></div>
    </div>
    <div class="card-file">${progress}% — ${escapeHtml(file)}</div>
    ` : file ? `<div class="card-file">${escapeHtml(file)}</div>` : ''}
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
