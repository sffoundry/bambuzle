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
    const humidity = unit.humidity != null ? `${unit.humidity}%` : '--';

    html += `<div class="ams-unit">`;
    html += `<div class="ams-unit-header">AMS ${unitId} &mdash; Humidity: ${escapeHtml(humidity)}</div>`;
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
