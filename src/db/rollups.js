'use strict';

// BAM-36: telemetry rollups and tiered retention.
//   raw samples     — every 5 s (active) / 30 s (idle), kept `retention.rawDays` (default 14)
//   hourly rollups  — averages per printer per hour, kept `retention.rollupDays` (default 365)
// Compaction rolls raw rows into hourly buckets and deletes them in ONE transaction, only if the rolled
// count matches the deleted count — history is never dropped without its summary.
//
// History reads (getHistory) also fix a long-standing bug: getSamples applied LIMIT oldest-first, so a
// 24 h chart at 5 s sampling (~17k rows > the chart's 10k limit) silently lost the most recent hours.
// Windows larger than the limit are now averaged into time buckets across the whole range.

const { getDb } = require('./database');

// Numeric sample columns that are averaged (charts read ts + these)
const NUMERIC = [
  'bed_temp', 'bed_target', 'nozzle_temp', 'nozzle_target', 'nozzle2_temp', 'nozzle2_target', 'chamber_temp',
  'part_fan_speed', 'aux_fan_speed', 'chamber_fan_speed', 'progress', 'layer_num', 'total_layers',
  'remaining_min', 'speed_level', 'wifi_signal',
];

let ensured = false;
function db() {
  const d = getDb();
  if (!ensured) {
    d.exec(`CREATE TABLE IF NOT EXISTS samples_hourly (
      device_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      n INTEGER NOT NULL,
      ${NUMERIC.map((c) => `${c} REAL`).join(',\n      ')},
      PRIMARY KEY (device_id, hour)
    )`);
    ensured = true;
  }
  return d;
}

/** 'YYYY-MM-DD HH:00:00' at the start of the hour `days` ago (aligned so no hour is split). */
function hourCutoff(days, now = Date.now()) {
  const d = new Date(now - days * 86400e3);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Roll raw samples older than `rawDays` into hourly averages, then delete them (same transaction).
 * @returns {{ rolledHours: number, deletedRaw: number }}
 */
function compactSamples(rawDays, now = Date.now()) {
  const d = db();
  const cutoff = hourCutoff(rawDays, now);
  const avgCols = NUMERIC.map((c) => `AVG(${c})`).join(', ');
  return d.transaction(() => {
    const pending = d.prepare('SELECT COUNT(*) AS n FROM samples WHERE ts < ?').get(cutoff).n;
    if (!pending) return { rolledHours: 0, deletedRaw: 0 };
    // Merge with any existing bucket for the same hour (weighted by n) so re-runs never double count
    const rows = d.prepare(`
      SELECT device_id, strftime('%Y-%m-%d %H:00:00', ts) AS hour, COUNT(*) AS n, ${avgCols}
      FROM samples WHERE ts < ? GROUP BY device_id, hour
    `).raw().all(cutoff);
    const get = d.prepare('SELECT * FROM samples_hourly WHERE device_id = ? AND hour = ?');
    const put = d.prepare(`INSERT OR REPLACE INTO samples_hourly (device_id, hour, n, ${NUMERIC.join(', ')})
      VALUES (?, ?, ?, ${NUMERIC.map(() => '?').join(', ')})`);
    let rolled = 0;
    for (const [deviceId, hour, n, ...avgs] of rows) {
      const prev = get.get(deviceId, hour);
      const total = n + (prev?.n || 0);
      const merged = NUMERIC.map((c, i) => {
        const a = avgs[i];
        const b = prev?.[c];
        if (a == null) return b ?? null;
        if (b == null || !prev) return a;
        return (a * n + b * prev.n) / total;
      });
      put.run(deviceId, hour, total, ...merged);
      rolled += n;
    }
    const deleted = d.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff).changes;
    if (deleted !== rolled || rolled !== pending) {
      throw new Error(`rollup mismatch: pending=${pending} rolled=${rolled} deleted=${deleted}`); // rolls back
    }
    return { rolledHours: rows.length, deletedRaw: deleted };
  })();
}

function deleteOldRollups(rollupDays, now = Date.now()) {
  return db().prepare('DELETE FROM samples_hourly WHERE hour < ?').run(hourCutoff(rollupDays, now)).changes;
}

/** Raw samples in [from, to], averaged into ≤ limit time buckets when there are more. */
function rawSeries(deviceId, from, to, limit) {
  const d = db();
  const where = ['device_id = ?'];
  const params = [deviceId];
  if (from) { where.push('ts >= datetime(?)'); params.push(from); }
  if (to) { where.push('ts <= datetime(?)'); params.push(to); }
  const w = where.join(' AND ');
  const { n, t0, t1 } = d.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS t0, MAX(ts) AS t1 FROM samples WHERE ${w}`).get(...params);
  if (!n) return [];
  if (n <= limit) return d.prepare(`SELECT * FROM samples WHERE ${w} ORDER BY ts ASC`).all(...params);
  const spanSec = Math.max(1, (Date.parse(t1.replace(' ', 'T') + 'Z') - Date.parse(t0.replace(' ', 'T') + 'Z')) / 1000);
  const bucket = Math.max(1, Math.ceil(spanSec / limit));
  return d.prepare(`
    SELECT datetime(MIN(ts)) AS ts, ${NUMERIC.map((c) => `AVG(${c}) AS ${c}`).join(', ')}
    FROM samples WHERE ${w}
    GROUP BY CAST((julianday(ts) - julianday(?)) * 86400 / ? AS INTEGER)
    ORDER BY ts ASC
  `).all(...params, t0, bucket);
}

/**
 * Chart history: hourly rollups for the part of the window older than the raw cutoff, raw (bucketed if
 * needed) for the rest. Same row shape as samples (ts + numeric columns); rollup rows have `rollup: 1`.
 */
function getHistory(deviceId, { from, to, limit = 5000 } = {}, { rawDays = 14, now = Date.now() } = {}) {
  const d = db();
  const rawCutoff = hourCutoff(rawDays, now);
  let sql = `SELECT hour AS ts, ${NUMERIC.join(', ')}, 1 AS rollup FROM samples_hourly WHERE device_id = ? AND hour < ?`;
  const params = [deviceId, rawCutoff];
  if (from) { sql += " AND datetime(hour, '+1 hour') > datetime(?)"; params.push(from); } // hour overlaps window
  if (to) { sql += ' AND hour <= datetime(?)'; params.push(to); }
  const older = d.prepare(`${sql} ORDER BY hour ASC`).all(...params);
  const recent = rawSeries(deviceId, from, to, Math.max(1, limit - older.length));
  return older.concat(recent);
}

module.exports = { compactSamples, deleteOldRollups, getHistory, rawSeries, hourCutoff, NUMERIC };
