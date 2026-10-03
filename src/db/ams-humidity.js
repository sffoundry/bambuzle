'use strict';

// BAM-43: AMS humidity history. Self-contained table (created on first use) so it stays out of the
// main migration list. One row per AMS unit at most every RECORD_INTERVAL_MS, or sooner on a change.

const { getDb } = require('./database');

const RECORD_INTERVAL_MS = 15 * 60 * 1000;
let ensured = false;

function db() {
  const d = getDb();
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS ams_humidity_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        ams_id TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        humidity_pct INTEGER,
        humidity_level INTEGER,
        temp REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ams_humidity_device_ts ON ams_humidity_samples(device_id, ts);
    `);
    ensured = true;
  }
  return d;
}

const last = {}; // `${deviceId}/${amsId}` -> { at, pct, level }

/**
 * Record humidity for each AMS unit if the interval elapsed or the value changed.
 * @param {string} deviceId
 * @param {Array<{id, percent, index, temp}>} units — state.diagnostics.amsHumidity
 * @returns {number} rows written
 */
function recordAmsHumidity(deviceId, units, now = Date.now()) {
  if (!Array.isArray(units) || units.length === 0) return 0;
  let written = 0;
  const insert = db().prepare(`
    INSERT INTO ams_humidity_samples (device_id, ams_id, ts, humidity_pct, humidity_level, temp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const u of units) {
    if (u.id == null || (u.percent == null && u.index == null)) continue;
    const key = `${deviceId}/${u.id}`;
    const prev = last[key];
    const changed = !prev || prev.pct !== u.percent || prev.level !== u.index;
    if (prev && !changed && now - prev.at < RECORD_INTERVAL_MS) continue;
    if (prev && changed && now - prev.at < 60 * 1000) continue; // ignore sub-minute jitter
    const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    insert.run(deviceId, String(u.id), ts, u.percent ?? null, u.index ?? null, u.temp ?? null);
    last[key] = { at: now, pct: u.percent, level: u.index };
    written++;
  }
  return written;
}

/** Series per AMS unit for a printer, oldest first. */
function getAmsHumidityHistory(deviceId, { from, to } = {}) {
  let sql = 'SELECT ams_id, ts, humidity_pct, humidity_level, temp FROM ams_humidity_samples WHERE device_id = ?';
  const params = [deviceId];
  if (from) { sql += ' AND ts >= datetime(?)'; params.push(from); }
  if (to) { sql += ' AND ts <= datetime(?)'; params.push(to); }
  // Newest rows win the cap (review 2, #3), then oldest-first for charting
  sql += ' ORDER BY ts DESC LIMIT 20000';
  const units = {};
  for (const r of db().prepare(sql).all(...params).reverse()) {
    (units[r.ams_id] ||= []).push({ ts: r.ts, pct: r.humidity_pct, level: r.humidity_level, temp: r.temp });
  }
  return units;
}

function deleteOldAmsHumidity(days) {
  return db().prepare("DELETE FROM ams_humidity_samples WHERE ts < datetime('now', '-' || ? || ' days')").run(days);
}

/** Test hook: forget throttle state. */
function _resetThrottle() {
  for (const k of Object.keys(last)) delete last[k];
}

module.exports = { recordAmsHumidity, getAmsHumidityHistory, deleteOldAmsHumidity, RECORD_INTERVAL_MS, _resetThrottle };
