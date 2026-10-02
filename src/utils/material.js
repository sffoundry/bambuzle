'use strict';

// tray_now sentinels in the MQTT `print.ams` object.
const TRAY_NONE = 255;      // no filament loaded / unknown
const TRAY_EXTERNAL = 254;  // external spool — its data lives in print.vt_tray, not print.ams

/**
 * Resolve the active filament from the raw MQTT AMS object (`state.ams`).
 * The global tray index in `tray_now` is ams_id * 4 + tray_id.
 * @param {object|null} ams — raw `print.ams`: { ams: [{ id, tray: [{ id, tray_type, tray_color }] }], tray_now }
 * @returns {{ material: string|null, color: string|null }} nulls when unknown or the external spool
 */
function getActiveTrayMaterial(ams) {
  const none = { material: null, color: null };
  if (!ams || typeof ams !== 'object' || !Array.isArray(ams.ams)) return none;

  const trayNow = parseInt(ams.tray_now, 10);
  if (!Number.isInteger(trayNow) || trayNow < 0 || trayNow === TRAY_NONE || trayNow === TRAY_EXTERNAL) {
    return none;
  }

  const amsId = Math.floor(trayNow / 4);
  const trayId = trayNow % 4;
  const unit = ams.ams.find((u) => parseInt(u?.id, 10) === amsId);
  const tray = Array.isArray(unit?.tray) ? unit.tray.find((t) => parseInt(t?.id, 10) === trayId) : null;
  if (!tray) return none;

  const material = typeof tray.tray_type === 'string' && tray.tray_type.trim() ? tray.tray_type.trim() : null;
  const color = typeof tray.tray_color === 'string' && tray.tray_color.trim() ? tray.tray_color.trim() : null;
  return { material, color };
}

module.exports = { getActiveTrayMaterial, TRAY_NONE, TRAY_EXTERNAL };
