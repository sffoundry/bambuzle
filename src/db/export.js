'use strict';

// Job data export (BAM-46). One row per print job with a stable, versioned column set.
// Column meanings: docs/export-data-dictionary.md. Bump EXPORT_SCHEMA_VERSION on any
// rename, removal or meaning change; appending a column is also a version bump.

const { getDb } = require('./database');
const { JOB_DURATION_SQL } = require('./queries');

const EXPORT_SCHEMA_VERSION = 1;
const EXPORT_MAX_ROWS = 50000;

/** Ordered column set. `type` is the JSON/CSV value type: string | integer | number. */
const EXPORT_COLUMNS = [
  { name: 'job_id', type: 'integer' },
  { name: 'device_id', type: 'string' },
  { name: 'printer_name', type: 'string' },
  { name: 'printer_model', type: 'string' },
  { name: 'task_id', type: 'string' },
  { name: 'subtask_name', type: 'string' },
  { name: 'gcode_file', type: 'string' },
  { name: 'started_at', type: 'string', unit: 'ISO 8601 UTC' },
  { name: 'ended_at', type: 'string', unit: 'ISO 8601 UTC' },
  { name: 'end_state', type: 'string' },
  { name: 'outcome', type: 'string' },
  { name: 'duration_sec', type: 'integer', unit: 's' },
  { name: 'progress_pct', type: 'number', unit: '%' },
  { name: 'material', type: 'string' },
  { name: 'material_color', type: 'string', unit: 'RRGGBBAA hex' },
  { name: 'pause_count', type: 'integer' },
  { name: 'pause_total_sec', type: 'number', unit: 's' },
  { name: 'temp_anomaly_count', type: 'integer' },
  { name: 'total_layers', type: 'integer' },
  { name: 'layer_count', type: 'integer' },
  { name: 'hms_error_count', type: 'integer' },
  { name: 'hms_codes', type: 'string' },
  { name: 'print_error_count', type: 'integer' },
  { name: 'sample_count', type: 'integer' },
  { name: 'nozzle_temp_avg', type: 'number', unit: '°C' },
  { name: 'nozzle_temp_max', type: 'number', unit: '°C' },
  { name: 'bed_temp_avg', type: 'number', unit: '°C' },
  { name: 'bed_temp_max', type: 'number', unit: '°C' },
];

const ISO_UTC = (col) => `CASE WHEN ${col} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ', ${col}) END`;

/**
 * Select export rows. Set-based: the job page is a CTE and every per-job aggregate is a
 * GROUP BY over rows whose job_id is in that page (samples / layer_transitions use their
 * job_id indexes; events has no job_id index, so it is one filtered pass over events).
 *
 * When more than `maxRows` jobs match, the NEWEST `maxRows` are kept. Output is ordered
 * oldest → newest (started_at, then id).
 *
 * @param {{ deviceId?: string, from?: string, to?: string, maxRows?: number }} opts
 *   from/to are SQLite datetimes ('YYYY-MM-DD HH:MM:SS', UTC); either may be omitted.
 * @returns {{ rows: object[], truncated: boolean }}
 */
function getJobExportRows({ deviceId, from, to, maxRows = EXPORT_MAX_ROWS } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (deviceId) { where += ' AND j.device_id = ?'; params.push(deviceId); }
  if (from) { where += ' AND j.started_at >= datetime(?)'; params.push(from); }
  if (to) { where += ' AND j.started_at <= datetime(?)'; params.push(to); }

  const sql = `
    WITH sel AS (
      SELECT j.* FROM print_jobs j ${where}
      ORDER BY j.started_at DESC, j.id DESC
      LIMIT ?
    ),
    s AS (
      SELECT job_id,
        COUNT(*) AS sample_count,
        AVG(nozzle_temp) AS nozzle_avg, MAX(nozzle_temp) AS nozzle_max,
        AVG(bed_temp) AS bed_avg, MAX(bed_temp) AS bed_max,
        MAX(layer_num) AS max_layer
      FROM samples WHERE job_id IN (SELECT id FROM sel)
      GROUP BY job_id
    ),
    lt AS (
      SELECT job_id, MAX(layer_num) AS max_layer
      FROM layer_transitions WHERE job_id IN (SELECT id FROM sel)
      GROUP BY job_id
    ),
    ev AS (
      SELECT job_id,
        SUM(CASE WHEN event_type = 'hms_error' THEN 1 ELSE 0 END) AS hms_errors,
        SUM(CASE WHEN event_type = 'print_error' THEN 1 ELSE 0 END) AS print_errors
      FROM events
      WHERE event_type IN ('hms_error', 'print_error') AND job_id IN (SELECT id FROM sel)
      GROUP BY job_id
    )
    SELECT
      j.id AS job_id,
      j.device_id,
      p.name AS printer_name,
      p.model AS printer_model,
      j.task_id,
      j.subtask_name,
      j.gcode_file,
      ${ISO_UTC('j.started_at')} AS started_at,
      ${ISO_UTC('j.ended_at')} AS ended_at,
      j.end_state,
      CASE
        WHEN j.ended_at IS NULL THEN 'running'
        WHEN j.end_state = 'FINISH' THEN 'finished'
        WHEN j.end_state = 'FAILED' THEN 'failed'
        WHEN j.end_state IN ('IDLE', 'CANCELLED') THEN 'cancelled'
        ELSE 'unknown'
      END AS outcome,
      CAST(ROUND(${JOB_DURATION_SQL}) AS INTEGER) AS duration_sec,
      j.progress_pct,
      j.material,
      j.material_color,
      j.pause_count,
      ROUND(j.total_pause_sec, 1) AS pause_total_sec,
      j.anomaly_count AS temp_anomaly_count,
      j.total_layers,
      COALESCE(lt.max_layer, s.max_layer) AS layer_count,
      COALESCE(ev.hms_errors, 0) AS hms_error_count,
      j.hms_codes AS hms_codes_json,
      COALESCE(ev.print_errors, 0) AS print_error_count,
      COALESCE(s.sample_count, 0) AS sample_count,
      ROUND(s.nozzle_avg, 1) AS nozzle_temp_avg,
      s.nozzle_max AS nozzle_temp_max,
      ROUND(s.bed_avg, 1) AS bed_temp_avg,
      s.bed_max AS bed_temp_max
    FROM sel j
    LEFT JOIN printers p ON p.device_id = j.device_id
    LEFT JOIN s ON s.job_id = j.id
    LEFT JOIN lt ON lt.job_id = j.id
    LEFT JOIN ev ON ev.job_id = j.id
    ORDER BY j.started_at ASC, j.id ASC
  `;

  // Fetch one extra row to detect truncation, then drop the oldest one.
  const raw = getDb().prepare(sql).all(...params, maxRows + 1);
  const truncated = raw.length > maxRows;
  const rows = (truncated ? raw.slice(raw.length - maxRows) : raw).map(shapeRow);
  return { rows, truncated };
}

/** hms_codes is stored as a JSON array; export it as a space-separated string. */
function shapeRow(r) {
  let hmsCodes = null;
  if (r.hms_codes_json) {
    try {
      const arr = JSON.parse(r.hms_codes_json);
      hmsCodes = Array.isArray(arr) && arr.length ? arr.map(String).join(' ') : null;
    } catch { hmsCodes = null; }
  }
  const out = {};
  for (const col of EXPORT_COLUMNS) {
    const v = col.name === 'hms_codes' ? hmsCodes : r[col.name];
    out[col.name] = v === undefined ? null : v;
  }
  return out;
}

module.exports = { getJobExportRows, EXPORT_COLUMNS, EXPORT_SCHEMA_VERSION, EXPORT_MAX_ROWS };
