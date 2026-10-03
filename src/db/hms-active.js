'use strict';

// Currently-active HMS codes per printer, persisted so a server restart doesn't re-record errors that
// were already active (each restart used to add a duplicate hms_error event, inflating repeat-error
// counts), and so a code that clears and later recurs is recorded again. Self-creating table.

const { getDb } = require('./database');

let ensured = false;
function db() {
  const d = getDb();
  if (!ensured) {
    d.exec(`CREATE TABLE IF NOT EXISTS hms_active (
      device_id TEXT NOT NULL,
      code TEXT NOT NULL,
      since TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device_id, code)
    )`);
    ensured = true;
  }
  return d;
}

/**
 * Reconcile the printer's current HMS list with the stored active set.
 * @param {string} deviceId
 * @param {string[]} currentCodes — keys present in this report (may be empty: all cleared)
 * @returns {{ added: string[], cleared: string[] }}
 */
function reconcileHms(deviceId, currentCodes) {
  const d = db();
  const current = new Set(currentCodes);
  const stored = new Set(d.prepare('SELECT code FROM hms_active WHERE device_id = ?').all(deviceId).map((r) => r.code));
  const added = [...current].filter((c) => !stored.has(c));
  const cleared = [...stored].filter((c) => !current.has(c));
  const ins = d.prepare('INSERT OR IGNORE INTO hms_active (device_id, code) VALUES (?, ?)');
  const del = d.prepare('DELETE FROM hms_active WHERE device_id = ? AND code = ?');
  d.transaction(() => {
    for (const c of added) ins.run(deviceId, c);
    for (const c of cleared) del.run(deviceId, c);
  })();
  return { added, cleared };
}

module.exports = { reconcileHms };
