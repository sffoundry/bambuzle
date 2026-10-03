'use strict';

// BAM-18: smart-plug config, per-minute power samples, settings (price, circuits), job energy.
// The plug secret (HA token / bearer) and any user:pass in the URL are write-only: API views carry
// hasSecret and a credential-free URL only.
// Self-creating tables (same pattern as audit / ams-humidity).

const { getDb } = require('./database');

let ensured = false;
function db() {
  const d = getDb();
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS power_plugs (
        device_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        entity TEXT,
        json_path TEXT,
        secret TEXT,
        circuit TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS power_samples (
        device_id TEXT NOT NULL,
        minute TEXT NOT NULL,          -- 'YYYY-MM-DD HH:MM:00' UTC
        avg_w REAL NOT NULL,
        max_w REAL NOT NULL,
        wh REAL NOT NULL,              -- energy measured within this minute
        PRIMARY KEY (device_id, minute)
      );
      CREATE TABLE IF NOT EXISTS power_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        price_per_kwh REAL,
        currency TEXT,
        circuits TEXT NOT NULL DEFAULT '[]'
      );
    `);
    ensured = true;
  }
  return d;
}

const rowToPlug = (r) => r && ({
  deviceId: r.device_id, kind: r.kind, url: r.url, channel: r.channel, entity: r.entity, jsonPath: r.json_path,
  secret: r.secret, circuit: r.circuit || '', enabled: Boolean(r.enabled), updatedAt: r.updated_at,
});

/** Public view: no secret, and the URL without any user:password part. */
function publicPlug(p) {
  if (!p) return null;
  let url = p.url;
  try { const u = new URL(p.url); if (u.username || u.password) { u.username = ''; u.password = ''; url = `${u.href} (credentials hidden)`; } } catch { /* keep */ }
  const { secret, ...rest } = p;
  return { ...rest, url, hasSecret: Boolean(secret) };
}

function getPlug(deviceId) { return rowToPlug(db().prepare('SELECT * FROM power_plugs WHERE device_id = ?').get(deviceId)); }
function listPlugs() { return db().prepare('SELECT * FROM power_plugs ORDER BY device_id').all().map(rowToPlug); }

/** Upsert. `secret`: undefined = keep, '' / null = clear. */
function setPlug(deviceId, { kind, url, channel = 0, entity = null, jsonPath = null, secret, circuit = '', enabled = true }) {
  const prev = getPlug(deviceId);
  const nextSecret = secret === undefined ? (prev?.secret ?? null) : (secret || null);
  db().prepare(`
    INSERT INTO power_plugs (device_id, kind, url, channel, entity, json_path, secret, circuit, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET kind = excluded.kind, url = excluded.url, channel = excluded.channel,
      entity = excluded.entity, json_path = excluded.json_path, secret = excluded.secret, circuit = excluded.circuit,
      enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(deviceId, kind, url, channel, entity, jsonPath, nextSecret, circuit || null, enabled ? 1 : 0);
  return getPlug(deviceId);
}

function deletePlug(deviceId) { return db().prepare('DELETE FROM power_plugs WHERE device_id = ?').run(deviceId).changes > 0; }

function getSettings() {
  const r = db().prepare('SELECT * FROM power_settings WHERE id = 1').get();
  let circuits = [];
  try { circuits = JSON.parse(r?.circuits || '[]'); } catch { circuits = []; }
  return { pricePerKwh: r?.price_per_kwh ?? null, currency: r?.currency || '', circuits };
}

function setSettings({ pricePerKwh, currency, circuits }) {
  const cur = getSettings();
  const next = {
    pricePerKwh: pricePerKwh === undefined ? cur.pricePerKwh : pricePerKwh,
    currency: currency === undefined ? cur.currency : currency,
    circuits: circuits === undefined ? cur.circuits : circuits,
  };
  db().prepare(`INSERT INTO power_settings (id, price_per_kwh, currency, circuits) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET price_per_kwh = excluded.price_per_kwh, currency = excluded.currency, circuits = excluded.circuits`)
    .run(next.pricePerKwh, next.currency || null, JSON.stringify(next.circuits));
  return getSettings();
}

/** One stored minute bucket (to resume it after a restart instead of overwriting it). */
function getMinute(deviceId, minute) {
  return db().prepare('SELECT avg_w, max_w, wh FROM power_samples WHERE device_id = ? AND minute = ?').get(deviceId, minute) || null;
}

/** Write (or overwrite) one minute bucket. */
function upsertMinute(deviceId, minute, { avgW, maxW, wh }) {
  db().prepare(`INSERT INTO power_samples (device_id, minute, avg_w, max_w, wh) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, minute) DO UPDATE SET avg_w = excluded.avg_w, max_w = excluded.max_w, wh = excluded.wh`)
    .run(deviceId, minute, avgW, maxW, wh);
}

function getHistory(deviceId, hours = 24) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 31);
  return db().prepare(`SELECT minute, avg_w AS avgW, max_w AS maxW, wh FROM power_samples
    WHERE device_id = ? AND minute >= datetime('now', ?) ORDER BY minute`).all(deviceId, `-${h} hours`);
}

/**
 * Energy between two UTC 'YYYY-MM-DD HH:MM:SS' times. The partly covered first and last minutes count
 * in proportion to how much of them the window covers, so back-to-back jobs don't both get the shared
 * minute, and idle draw before the start isn't billed to the job (review, batch 4 #3).
 */
function energyBetween(deviceId, startedAt, endedAt) {
  const toMs = (t) => Date.parse(`${String(t).replace(' ', 'T')}Z`);
  const start = toMs(startedAt);
  const end = toMs(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const rows = db().prepare(`SELECT minute, wh FROM power_samples
    WHERE device_id = ? AND minute >= strftime('%Y-%m-%d %H:%M:00', ?) AND minute <= ?`).all(deviceId, startedAt, endedAt);
  if (!rows.length) return null;
  let wh = 0;
  for (const r of rows) {
    const m0 = toMs(r.minute);
    const covered = Math.max(0, Math.min(end, m0 + 60000) - Math.max(start, m0));
    wh += r.wh * (covered / 60000);
  }
  return wh;
}

/** Store energy + cost on a finished job. Returns { energyWh, energyCost } or null without data. */
function recordJobEnergy(jobId) {
  const job = db().prepare('SELECT id, device_id, started_at, ended_at FROM print_jobs WHERE id = ?').get(jobId);
  if (!job?.ended_at || !getPlug(job.device_id)) return null;
  const wh = energyBetween(job.device_id, job.started_at, job.ended_at);
  if (wh == null) return null;
  const { pricePerKwh } = getSettings();
  const cost = pricePerKwh != null ? Math.round((wh / 1000) * pricePerKwh * 10000) / 10000 : null;
  db().prepare('UPDATE print_jobs SET energy_wh = ?, energy_cost = ? WHERE id = ?').run(Math.round(wh * 10) / 10, cost, jobId);
  return { energyWh: wh, energyCost: cost };
}

/** Totals over finished jobs since `sinceSql` (an SQLite datetime modifier like '-30 days'), or all time. */
function energyTotals(sinceDays = null) {
  const where = sinceDays ? "WHERE energy_wh IS NOT NULL AND started_at >= datetime('now', ?)" : 'WHERE energy_wh IS NOT NULL';
  const args = sinceDays ? [`-${Number(sinceDays)} days`] : [];
  const r = db().prepare(`SELECT COUNT(*) AS jobs, SUM(energy_wh) AS wh, SUM(energy_cost) AS cost FROM print_jobs ${where}`).get(...args);
  return { jobs: r.jobs, energyWh: r.wh ?? 0, energyCost: r.cost };
}

function deleteOldSamples(days) {
  return db().prepare("DELETE FROM power_samples WHERE minute < datetime('now', ?)").run(`-${Math.max(1, Number(days) || 1)} days`).changes;
}

module.exports = {
  getPlug, listPlugs, setPlug, deletePlug, publicPlug, getSettings, setSettings,
  upsertMinute, getMinute, getHistory, energyBetween, recordJobEnergy, energyTotals, deleteOldSamples,
};
