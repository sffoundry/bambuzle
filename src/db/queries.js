'use strict';

const { getDb } = require('./database');

// ─── Printers ───

function upsertPrinter({ deviceId, name, model, nozzleDiameter }) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO printers (device_id, name, model, nozzle_diameter, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET
      name = excluded.name,
      model = excluded.model,
      nozzle_diameter = COALESCE(excluded.nozzle_diameter, printers.nozzle_diameter),
      updated_at = datetime('now')
  `).run(deviceId, name, model, nozzleDiameter);
}

function getAllPrinters() {
  return getDb().prepare('SELECT * FROM printers ORDER BY name').all();
}

function getPrinter(deviceId) {
  return getDb().prepare('SELECT * FROM printers WHERE device_id = ?').get(deviceId);
}

// ─── Print Jobs ───

function startJob({ deviceId, taskId, subtaskName, gcodeFile }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO print_jobs (device_id, task_id, subtask_name, gcode_file, started_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(deviceId, taskId, subtaskName, gcodeFile);
  return result.lastInsertRowid;
}

function endJob(jobId, endState, progressPct) {
  getDb().prepare(`
    UPDATE print_jobs SET ended_at = datetime('now'), end_state = ?, progress_pct = ?
    WHERE id = ?
  `).run(endState, progressPct, jobId);
}

function getActiveJob(deviceId) {
  return getDb().prepare(`
    SELECT * FROM print_jobs
    WHERE device_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(deviceId);
}

function getJobs(deviceId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM print_jobs
    WHERE device_id = ?
    ORDER BY started_at DESC LIMIT ?
  `).all(deviceId, limit);
}

// ─── Samples ───

function insertSample(s) {
  return getDb().prepare(`
    INSERT INTO samples (
      device_id, job_id, ts, bed_temp, bed_target, nozzle_temp, nozzle_target,
      nozzle2_temp, nozzle2_target,
      chamber_temp, part_fan_speed, aux_fan_speed, chamber_fan_speed,
      progress, layer_num, total_layers, remaining_min, gcode_state,
      speed_level, wifi_signal
    ) VALUES (
      ?, ?, datetime('now'), ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    s.deviceId, s.jobId || null, s.bedTemp, s.bedTarget, s.nozzleTemp, s.nozzleTarget,
    s.nozzle2Temp ?? null, s.nozzle2Target ?? null,
    s.chamberTemp, s.partFanSpeed, s.auxFanSpeed, s.chamberFanSpeed,
    s.progress, s.layerNum, s.totalLayers, s.remainingMin, s.gcodeState,
    s.speedLevel, s.wifiSignal
  );
}

function getSamples(deviceId, { from, to, limit } = {}) {
  let sql = 'SELECT * FROM samples WHERE device_id = ?';
  const params = [deviceId];

  if (from) {
    sql += ' AND ts >= datetime(?)';
    params.push(from);
  }
  if (to) {
    sql += ' AND ts <= datetime(?)';
    params.push(to);
  }

  sql += ' ORDER BY ts ASC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return getDb().prepare(sql).all(...params);
}

// ─── Events ───

function insertEvent({ deviceId, jobId, eventType, severity, code, message }) {
  return getDb().prepare(`
    INSERT INTO events (device_id, job_id, ts, event_type, severity, code, message)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
  `).run(deviceId, jobId || null, eventType, severity || 'info', code || null, message || '');
}

function getEvents(deviceId, { limit, from, to } = {}) {
  let sql = 'SELECT * FROM events WHERE device_id = ?';
  const params = [deviceId];

  if (from) {
    sql += ' AND ts >= datetime(?)';
    params.push(from);
  }
  if (to) {
    sql += ' AND ts <= datetime(?)';
    params.push(to);
  }

  sql += ' ORDER BY ts DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return getDb().prepare(sql).all(...params);
}

function getRecentEvents(limit = 100) {
  return getDb().prepare(`
    SELECT e.*, p.name as printer_name FROM events e
    LEFT JOIN printers p ON e.device_id = p.device_id
    ORDER BY e.ts DESC LIMIT ?
  `).all(limit);
}

// ─── Alert Rules ───

function getAllAlertRules() {
  return getDb().prepare('SELECT * FROM alert_rules ORDER BY name').all();
}

function getAlertRule(id) {
  return getDb().prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
}

function createAlertRule({ name, deviceId, conditionType, conditionConfig, notifyVia, notifyConfig, cooldownSec }) {
  const result = getDb().prepare(`
    INSERT INTO alert_rules (name, device_id, condition_type, condition_config, notify_via, notify_config, cooldown_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, deviceId || null, conditionType, JSON.stringify(conditionConfig || {}), notifyVia || 'console', JSON.stringify(notifyConfig || {}), cooldownSec || 300);
  return result.lastInsertRowid;
}

function updateAlertRule(id, fields) {
  const sets = [];
  const params = [];

  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (col === 'condition_config' || col === 'notify_config') {
      sets.push(`${col} = ?`);
      params.push(JSON.stringify(val));
    } else {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  }

  if (sets.length === 0) return;

  params.push(id);
  getDb().prepare(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function deleteAlertRule(id) {
  getDb().prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
}

function updateAlertRuleFired(id) {
  getDb().prepare(`UPDATE alert_rules SET last_fired_at = datetime('now') WHERE id = ?`).run(id);
}

// ─── Cleanup ───

function deleteOldSamples(days) {
  return getDb().prepare(`
    DELETE FROM samples WHERE ts < datetime('now', '-' || ? || ' days')
  `).run(days);
}

function deleteOldEvents(days) {
  return getDb().prepare(`
    DELETE FROM events WHERE ts < datetime('now', '-' || ? || ' days')
  `).run(days);
}

module.exports = {
  upsertPrinter,
  getAllPrinters,
  getPrinter,
  startJob,
  endJob,
  getActiveJob,
  getJobs,
  insertSample,
  getSamples,
  insertEvent,
  getEvents,
  getRecentEvents,
  getAllAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  updateAlertRuleFired,
  deleteOldSamples,
  deleteOldEvents,
};
