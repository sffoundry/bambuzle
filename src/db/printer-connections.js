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
  return getDb().prepare("SELECT device_id FROM printers WHERE source != 'removed'").all().map((r) => getConnection(r.device_id));
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

/**
 * BAM-9: take a printer's LAN access code from the BambuLab account device list. Only for cloud-sourced
 * printers (never hand-added or removed ones); only the code, never the address; and never fills a code
 * that was cleared on a printer that has a saved LAN address — that would switch it to LAN.
 * @returns {{ changed: boolean, reconnect: boolean }}
 */
function importCloudAccessCode(deviceId, code) {
  const conn = getConnection(deviceId);
  if (!conn || !code || conn.source !== 'cloud' || conn.accessCode === code) return { changed: false, reconnect: false };
  if (conn.lanHost && !conn.accessCode) return { changed: false, reconnect: false };
  setConnection(deviceId, { accessCode: code });
  return { changed: true, reconnect: Boolean(conn.lanHost) }; // a LAN printer with a stale code reconnects
}

/** Bambu serials are uppercase; the printer only publishes on device/<SERIAL>/report. */
function normalizeSerial(serial) {
  return String(serial).trim().toUpperCase();
}

/** Existing printer (any source, incl. removed) whose serial matches case-insensitively. */
function findBySerial(serial) {
  return getDb().prepare('SELECT device_id, source FROM printers WHERE UPPER(device_id) = ?').get(normalizeSerial(serial)) || null;
}

/** Add a printer by hand (LAN / Developer Mode setups with no Bambu Cloud account). Revives a removed one. */
function addManualPrinter({ serial, name, model, lanHost, accessCode }) {
  const id = normalizeSerial(serial);
  const existing = findBySerial(id);
  if (existing?.source === 'removed') {
    getDb().prepare(`
      UPDATE printers SET name = ?, model = ?, connection_mode = 'lan', lan_host = ?, lan_access_code = ?,
        source = 'manual', updated_at = datetime('now') WHERE device_id = ?
    `).run(name, model || 'Unknown', lanHost, accessCode, existing.device_id);
    return existing.device_id;
  }
  getDb().prepare(`
    INSERT INTO printers (device_id, name, model, connection_mode, lan_host, lan_access_code, source, updated_at)
    VALUES (?, ?, ?, 'lan', ?, ?, 'manual', datetime('now'))
  `).run(id, name, model || 'Unknown', lanHost, accessCode);
  return id;
}

/**
 * Remove a hand-added printer. Cloud ones come back on the next device sync, so they can't be removed.
 * Printers with history (jobs/samples/events reference them) are soft-removed — hidden, disconnected, and
 * their secret cleared — so the history stays queryable and the FK holds (review BAM-35 #4).
 */
function deleteManualPrinter(serial) {
  const db = getDb();
  const row = db.prepare("SELECT device_id FROM printers WHERE device_id = ? AND source = 'manual'").get(serial);
  if (!row) return false;
  const referenced = ['print_jobs', 'samples', 'events'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE device_id = ? LIMIT 1`).get(serial));
  if (referenced) {
    db.prepare(`UPDATE printers SET source = 'removed', connection_mode = 'lan', lan_host = NULL, lan_access_code = NULL,
      updated_at = datetime('now') WHERE device_id = ?`).run(serial);
  } else {
    db.prepare('DELETE FROM printers WHERE device_id = ?').run(serial);
  }
  return true;
}

module.exports = {
  importCloudAccessCode, MODES, getConnection, getAllConnections, setConnection, addManualPrinter, deleteManualPrinter, findBySerial, normalizeSerial };
