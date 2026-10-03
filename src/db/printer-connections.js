'use strict';

// Printer connection settings (BAM-35). The ONLY module that reads printers.lan_access_code.

const { getDb } = require('./database');

const MODES = ['auto', 'cloud', 'lan'];

/** Internal: full connection settings including the secret. Never send the result to a client. */
function getConnection(deviceId) {
  const row = getDb().prepare(`
    SELECT device_id, connection_mode, lan_host, lan_access_code, source FROM printers WHERE device_id = ?
  `).get(deviceId);
  if (!row) return null;
  return {
    deviceId: row.device_id,
    mode: MODES.includes(row.connection_mode) ? row.connection_mode : 'auto',
    lanHost: row.lan_host || null,
    accessCode: row.lan_access_code || null,
    source: row.source || 'cloud',
  };
}

function getAllConnections() {
  return getDb().prepare('SELECT device_id FROM printers').all().map((r) => getConnection(r.device_id));
}

/**
 * Update connection settings. `accessCode`: undefined = keep, null/'' = clear.
 * @returns {boolean} whether the printer exists
 */
function setConnection(deviceId, { mode, lanHost, accessCode }) {
  const current = getConnection(deviceId);
  if (!current) return false;
  getDb().prepare(`
    UPDATE printers SET connection_mode = ?, lan_host = ?, lan_access_code = ?, updated_at = datetime('now')
    WHERE device_id = ?
  `).run(
    mode ?? current.mode,
    lanHost === undefined ? current.lanHost : (lanHost || null),
    accessCode === undefined ? current.accessCode : (accessCode || null),
    deviceId,
  );
  return true;
}

/** Add a printer by hand (LAN / Developer Mode setups with no Bambu Cloud account). */
function addManualPrinter({ serial, name, model, lanHost, accessCode }) {
  getDb().prepare(`
    INSERT INTO printers (device_id, name, model, connection_mode, lan_host, lan_access_code, source, updated_at)
    VALUES (?, ?, ?, 'lan', ?, ?, 'manual', datetime('now'))
  `).run(serial, name, model || 'Unknown', lanHost, accessCode);
}

/** Only hand-added printers can be deleted (cloud ones come back on the next device sync). */
function deleteManualPrinter(serial) {
  return getDb().prepare("DELETE FROM printers WHERE device_id = ? AND source = 'manual'").run(serial).changes > 0;
}

module.exports = { MODES, getConnection, getAllConnections, setConnection, addManualPrinter, deleteManualPrinter };
