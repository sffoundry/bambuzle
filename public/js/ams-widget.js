// ─── AMS Widget — Displays AMS tray data for the active printer ───

/**
 * Render AMS widget for the currently filtered printer.
 * @param {Object} printers - deviceId -> { db, live, connected }
 * @param {{ printer: string }} dashFilters
 */
export function renderAmsWidget(printers, dashFilters) {
  const container = document.getElementById('ams-content');
  if (!container) return;

  const deviceId = getTargetPrinter(printers, dashFilters);
  if (!deviceId) {
    container.innerHTML = '<div class="ams-empty-msg">No printer selected</div>';
    return;
  }

  renderAmsForPrinter(container, printers[deviceId]);
}

/**
 * Update AMS widget when a specific printer's state changes.
 * Only re-renders if the updated printer is the one currently displayed.
 * @param {string} deviceId
 * @param {Object} printers
 * @param {{ printer: string }} dashFilters
 */
export function updateAmsWidget(deviceId, printers, dashFilters) {
  const target = getTargetPrinter(printers, dashFilters);
  if (target !== deviceId) return;

  const container = document.getElementById('ams-content');
  if (!container) return;

  renderAmsForPrinter(container, printers[deviceId]);
}

function getTargetPrinter(printers, dashFilters) {
  if (dashFilters && dashFilters.printer) return dashFilters.printer;
  const ids = Object.keys(printers);
  return ids[0] || null;
}

function renderAmsForPrinter(container, printer) {
  lastRender = { container, printer };
  const live = printer?.live;
  const amsData = live?.ams;

  if (!amsData || !amsData.ams || amsData.ams.length === 0) {
    container.innerHTML = '<div class="ams-empty-msg">No AMS data</div>';
    return;
  }

  const trayNow = amsData.tray_now != null ? String(amsData.tray_now) : null;
  let html = '';

  for (const unit of amsData.ams) {
    const unitId = unit.id != null ? unit.id : '?';
    const humidity = formatAmsHumidity(unit);

    html += `<div class="ams-unit">`;
    html += `<div class="ams-unit-header">AMS ${unitId} &mdash; Humidity: ${escapeHtml(humidity)}${renderHumidityTrend(printer, unit.id)}</div>`;
    html += `<div class="ams-trays">`;

    if (unit.tray && unit.tray.length > 0) {
      for (const tray of unit.tray) {
        const trayId = tray.id != null ? String(tray.id) : '';
        // Compute global tray index for active comparison (unit_id * 4 + tray_id)
        const globalIdx = String(Number(unitId) * 4 + Number(trayId));
        const isActive = trayNow != null && trayNow === globalIdx;
        const hasFilament = tray.tray_type && tray.tray_type !== '';
        const activeClass = isActive ? ' active' : '';
        const emptyClass = hasFilament ? '' : ' empty';

        if (hasFilament) {
          const color = tray.tray_color ? '#' + tray.tray_color.substring(0, 6) : 'var(--text-dim)';
          html += `<div class="ams-tray${activeClass}">`;
          html += `<div class="ams-color-swatch" style="background: ${escapeHtml(color)};"></div>`;
          html += `<div class="ams-tray-type">${escapeHtml(tray.tray_type)}</div>`;
          html += `</div>`;
        } else {
          html += `<div class="ams-tray${emptyClass}">`;
          html += `<div class="ams-color-swatch" style="background: var(--border);"></div>`;
          html += `<div class="ams-tray-type">--</div>`;
          html += `</div>`;
        }
      }
    } else {
      // 4 empty tray slots
      for (let i = 0; i < 4; i++) {
        html += `<div class="ams-tray empty">`;
        html += `<div class="ams-color-swatch" style="background: var(--border);"></div>`;
        html += `<div class="ams-tray-type">--</div>`;
        html += `</div>`;
      }
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * `humidity_raw` is real % RH (AMS 2 Pro / HT and newer firmware); `humidity` is only a 1–5 level
 * (5 = driest), so never print the level with a % sign.
 */
function formatAmsHumidity(unit) {
  const raw = parseInt(unit.humidity_raw, 10);
  if (raw >= 1 && raw <= 100) return `${raw}%`;
  const level = parseInt(unit.humidity, 10);
  if (level >= 1 && level <= 5) return `level ${level}/5`;
  return '--';
}

// ─── BAM-43: humidity history (sparkline + 24h trend) ───
// History comes from /api/printers/:id/ams-humidity; cached per printer and refreshed every 5 min.
// The widget re-renders on every MQTT update, so fetching is fire-and-forget with a re-render on arrival.

const HISTORY_TTL_MS = 5 * 60 * 1000;
const historyCache = {}; // deviceId -> { at, units, loading }
let lastRender = null;

function getHistory(deviceId) {
  const entry = historyCache[deviceId];
  if (entry && (entry.loading || Date.now() - entry.at < HISTORY_TTL_MS)) return entry.units || null;
  historyCache[deviceId] = { at: Date.now(), units: entry?.units || null, loading: true };
  fetch(`/api/printers/${encodeURIComponent(deviceId)}/ams-humidity`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      historyCache[deviceId] = { at: Date.now(), units: data?.units || {}, loading: false };
      if (lastRender && lastRender.printer?.db?.device_id === deviceId) {
        renderAmsForPrinter(lastRender.container, lastRender.printer);
      }
    })
    .catch(() => { historyCache[deviceId] = { at: Date.now(), units: entry?.units || null, loading: false }; });
  return entry?.units || null;
}

function seriesValue(p) {
  return p.pct != null ? p.pct : null;
}

function renderHumidityTrend(printer, amsId) {
  const deviceId = printer?.db?.device_id;
  if (!deviceId || amsId == null) return '';
  const points = (getHistory(deviceId) || {})[String(amsId)] || [];
  const values = points.map(seriesValue).filter((v) => v != null);
  if (values.length < 2) return '';

  // 24h delta: latest vs the newest point at least 24h old (or the oldest available)
  const latest = points[points.length - 1];
  const cutoff = Date.now() - 86400e3;
  const ref = [...points].reverse().find((p) => Date.parse(p.ts.replace(' ', 'T') + 'Z') <= cutoff) || points[0];
  const delta = seriesValue(latest) != null && seriesValue(ref) != null ? seriesValue(latest) - seriesValue(ref) : null;
  const arrow = delta == null || delta === 0 ? '' : delta > 0 ? `<span class="ams-trend-up" title="vs 24h ago">&#9650;${delta}</span>`
    : `<span class="ams-trend-down" title="vs 24h ago">&#9660;${-delta}</span>`;

  const w = 80;
  const h = 16;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return ` ${arrow}<svg class="ams-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="7-day humidity ${min}–${max}%"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

