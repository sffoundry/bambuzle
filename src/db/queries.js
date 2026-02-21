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

function getRecentEvents({ limit = 100, from, to } = {}) {
  let sql = `SELECT e.*, p.name as printer_name FROM events e
    LEFT JOIN printers p ON e.device_id = p.device_id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND e.ts >= datetime(?)'; params.push(from); }
  if (to) { sql += ' AND e.ts <= datetime(?)'; params.push(to); }
  sql += ' ORDER BY e.ts DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return getDb().prepare(sql).all(...params);
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

// ─── Auth Tokens ───

function saveAuthToken({ token, refreshToken, userId, expiresAt, region }) {
  return getDb().prepare(`
    INSERT INTO auth_tokens (id, token, refresh_token, user_id, expires_at, region, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      token = excluded.token,
      refresh_token = excluded.refresh_token,
      user_id = excluded.user_id,
      expires_at = excluded.expires_at,
      region = excluded.region,
      updated_at = datetime('now')
  `).run(token, refreshToken || null, userId, expiresAt, region || 'global');
}

function getAuthToken() {
  return getDb().prepare('SELECT * FROM auth_tokens WHERE id = 1').get();
}

function deleteAuthToken() {
  return getDb().prepare('DELETE FROM auth_tokens WHERE id = 1').run();
}

// ─── Layer Transitions ───

function insertLayerTransition({ deviceId, jobId, layerNum, durationSec, nozzleTemp, nozzleTarget, bedTemp, bedTarget, chamberTemp, speedLevel, progress }) {
  return getDb().prepare(`
    INSERT INTO layer_transitions (device_id, job_id, layer_num, ts, duration_sec, nozzle_temp, nozzle_target, bed_temp, bed_target, chamber_temp, speed_level, progress)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(deviceId, jobId || null, layerNum, durationSec ?? null, nozzleTemp ?? null, nozzleTarget ?? null, bedTemp ?? null, bedTarget ?? null, chamberTemp ?? null, speedLevel ?? null, progress ?? null);
}

function getLayerTransitions(jobId) {
  return getDb().prepare('SELECT * FROM layer_transitions WHERE job_id = ? ORDER BY layer_num ASC').all(jobId);
}

function getLayerTransitionsInWindow(deviceId, from, to) {
  return getDb().prepare(`
    SELECT * FROM layer_transitions WHERE device_id = ? AND ts >= datetime(?) AND ts <= datetime(?) ORDER BY ts ASC
  `).all(deviceId, from, to);
}

// ─── Temp Anomalies ───

function insertTempAnomaly({ deviceId, jobId, sensor, actualTemp, targetTemp, deviation, rateOfChange, layerNum, anomalyType }) {
  return getDb().prepare(`
    INSERT INTO temp_anomalies (device_id, job_id, ts, sensor, actual_temp, target_temp, deviation, rate_of_change, layer_num, anomaly_type)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
  `).run(deviceId, jobId || null, sensor, actualTemp, targetTemp ?? null, deviation ?? null, rateOfChange ?? null, layerNum ?? null, anomalyType);
}

function getTempAnomalies(jobId) {
  return getDb().prepare('SELECT * FROM temp_anomalies WHERE job_id = ? ORDER BY ts ASC').all(jobId);
}

function getTempAnomaliesInWindow(deviceId, from, to) {
  return getDb().prepare(`
    SELECT * FROM temp_anomalies WHERE device_id = ? AND ts >= datetime(?) AND ts <= datetime(?) ORDER BY ts ASC
  `).all(deviceId, from, to);
}

// ─── Job Pauses ───

function insertJobPause({ deviceId, jobId, pauseSource, layerNum, progress, hmsCodes }) {
  return getDb().prepare(`
    INSERT INTO job_pauses (device_id, job_id, paused_at, pause_source, layer_num, progress, hms_codes)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
  `).run(deviceId, jobId, pauseSource || 'unknown', layerNum ?? null, progress ?? null, hmsCodes ? JSON.stringify(hmsCodes) : null);
}

function resumeJobPause(jobId) {
  const pause = getDb().prepare(`
    SELECT * FROM job_pauses WHERE job_id = ? AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1
  `).get(jobId);
  if (!pause) return null;

  getDb().prepare(`
    UPDATE job_pauses SET resumed_at = datetime('now') WHERE id = ?
  `).run(pause.id);

  // Calculate duration in seconds
  const updated = getDb().prepare('SELECT * FROM job_pauses WHERE id = ?').get(pause.id);
  const pausedAt = new Date(updated.paused_at + 'Z');
  const resumedAt = new Date(updated.resumed_at + 'Z');
  const durationSec = (resumedAt - pausedAt) / 1000;
  return durationSec;
}

function getOpenPause(jobId) {
  return getDb().prepare(`
    SELECT * FROM job_pauses WHERE job_id = ? AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1
  `).get(jobId);
}

function getJobPauses(jobId) {
  return getDb().prepare('SELECT * FROM job_pauses WHERE job_id = ? ORDER BY paused_at ASC').all(jobId);
}

function getJobPausesInWindow(deviceId, from, to) {
  return getDb().prepare(`
    SELECT * FROM job_pauses WHERE device_id = ?
      AND paused_at >= datetime(?) AND paused_at <= datetime(?)
    ORDER BY paused_at ASC
  `).all(deviceId, from, to);
}

// ─── Job Updates (anomaly counters) ───

function incrementJobAnomalyCount(jobId) {
  getDb().prepare('UPDATE print_jobs SET anomaly_count = anomaly_count + 1 WHERE id = ?').run(jobId);
}

function incrementJobPauseCount(jobId) {
  getDb().prepare('UPDATE print_jobs SET pause_count = pause_count + 1 WHERE id = ?').run(jobId);
}

function addJobPauseDuration(jobId, seconds) {
  getDb().prepare('UPDATE print_jobs SET total_pause_sec = total_pause_sec + ? WHERE id = ?').run(seconds, jobId);
}

function addJobHmsCode(jobId, code) {
  const job = getDb().prepare('SELECT hms_codes FROM print_jobs WHERE id = ?').get(jobId);
  if (!job) return;
  const codes = job.hms_codes ? JSON.parse(job.hms_codes) : [];
  if (!codes.includes(code)) {
    codes.push(code);
    getDb().prepare('UPDATE print_jobs SET hms_codes = ? WHERE id = ?').run(JSON.stringify(codes), jobId);
  }
}

function updateJobTotalLayers(jobId, totalLayers) {
  getDb().prepare('UPDATE print_jobs SET total_layers = ? WHERE id = ?').run(totalLayers, jobId);
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

function deleteOldLayerTransitions(days) {
  return getDb().prepare(`
    DELETE FROM layer_transitions WHERE ts < datetime('now', '-' || ? || ' days')
  `).run(days);
}

function deleteOldTempAnomalies(days) {
  return getDb().prepare(`
    DELETE FROM temp_anomalies WHERE ts < datetime('now', '-' || ? || ' days')
  `).run(days);
}

function deleteOldJobPauses(days) {
  return getDb().prepare(`
    DELETE FROM job_pauses WHERE paused_at < datetime('now', '-' || ? || ' days')
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
  saveAuthToken,
  getAuthToken,
  deleteAuthToken,
  // Anomaly data collection
  insertLayerTransition,
  getLayerTransitions,
  getLayerTransitionsInWindow,
  insertTempAnomaly,
  getTempAnomalies,
  getTempAnomaliesInWindow,
  insertJobPause,
  resumeJobPause,
  getOpenPause,
  getJobPauses,
  getJobPausesInWindow,
  incrementJobAnomalyCount,
  incrementJobPauseCount,
  addJobPauseDuration,
  addJobHmsCode,
  updateJobTotalLayers,
  deleteOldLayerTransitions,
  deleteOldTempAnomalies,
  deleteOldJobPauses,
};
