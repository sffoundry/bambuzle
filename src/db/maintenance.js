'use strict';

// Maintenance ledger (BAM-39): print hours per printer, service-interval tasks, completion log,
// and repeat HMS / print_error codes. Schema lives in database.js (maintenance_tasks, maintenance_log).

const { getDb } = require('./database');
const { JOB_DURATION_SQL } = require('./queries');
const { lookupHmsCode } = require('../utils/hms-codes');

/** Fraction of an interval at which a task becomes "due soon". */
const DUE_SOON_RATIO = 0.9;
const REPEAT_ERROR_DAYS = 30;
const REPEAT_ERROR_LIMIT = 10;
const RECENT_LOG_LIMIT = 20;

// Default task set, offered (never auto-created) when a printer has no tasks.
//
// Bambu Lab publishes calendar-based guidance (not print-hour based), retrieved 2026-10-03:
//   X1 series: https://wiki.bambulab.com/en/x1/maintenance/basic-maintenance
//   A1 series: https://wiki.bambulab.com/en/a1/maintenance/basic-maintenance
//   AMS:       https://wiki.bambulab.com/en/ams/maintenance/basic-maintenance
// An interval is set only where the X1 and A1 pages agree:
//   - rods / guide rails: "checked once a month" (X1), "Every month" (A1)          -> 30 days
//   - Z lead screws:      "checked and greased every three months" (X1), "Every 3 months" (A1) -> 90 days
//   - fans:               "checking the fans every week" (X1), "Every week" (A1)  -> 7 days
// Everything else is left null: the wiki gives no fixed interval (nozzle/hotend "from time to time",
// belts "when HMS prompts" on A1, cutter blade and PTFE by rolls of filament, AMS desiccant none),
// so the user sets one. X1-only guidance (e.g. carbon filter every 3 months at ~8 h/day) is not
// applied because printers.model is not reliably mappable to a series.
const DEFAULT_TASKS = Object.freeze([
  { name: 'Clean rods & linear rails', intervalHours: null, intervalDays: 30,
    notes: 'Wipe with isopropyl alcohol. Bambu: do not grease X1/P1 carbon rods. With ABS/ASA, clean every 5 rolls.' },
  { name: 'Grease Z-axis lead screws', intervalHours: null, intervalDays: 90,
    notes: 'Clean, then apply a thin coat of grease and run the bed up/down.' },
  { name: 'Clean fans', intervalHours: null, intervalDays: 7,
    notes: 'Printer off; compressed air over the hotend, part-cooling, aux and exhaust fans.' },
  { name: 'Check/clean nozzle & hotend', intervalHours: null, intervalDays: null,
    notes: 'Bambu: clean when switching filament types or on under-extrusion. Set an interval to suit.' },
  { name: 'Clean build plate', intervalHours: null, intervalDays: null, notes: '' },
  { name: 'Check belt tension', intervalHours: null, intervalDays: null,
    notes: 'A1: the printer prompts via HMS when a belt is loose.' },
  { name: 'Replace/dry AMS desiccant', intervalHours: null, intervalDays: null, notes: '' },
  { name: 'Check filament cutter blade', intervalHours: null, intervalDays: null,
    notes: 'Bambu: every 3-5 rolls (1-2 rolls of abrasive CF/GF filament).' },
]);

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Total print hours (ended jobs) and first-job timestamp for a printer. */
function getPrinterHours(deviceId) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(${JOB_DURATION_SQL}), 0) AS total_sec, MIN(j.started_at) AS first_job_at
    FROM print_jobs j WHERE j.device_id = ?
  `).get(deviceId);
  return { totalSec: row.total_sec || 0, firstJobAt: row.first_job_at || null };
}

/**
 * Print seconds on a printer since `baseline` (SQLite datetime). Running jobs are excluded;
 * a job that straddles the baseline only counts the part after it.
 */
function getPrintSecondsSince(deviceId, baseline) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN j.started_at >= datetime(@b) THEN ${JOB_DURATION_SQL}
      ELSE MIN(${JOB_DURATION_SQL}, MAX(0, (julianday(j.ended_at) - julianday(@b)) * 86400))
    END), 0) AS sec
    FROM print_jobs j
    WHERE j.device_id = @d AND j.ended_at IS NOT NULL AND j.ended_at > datetime(@b)
  `).get({ d: deviceId, b: baseline });
  return row.sec || 0;
}

function daysSince(ts) {
  return getDb().prepare("SELECT MAX(0, julianday('now') - julianday(?)) AS d").get(ts).d;
}

/**
 * Due status from hours/days since the baseline and the task's intervals.
 * @returns {'ok'|'due_soon'|'due'|'unscheduled'}
 */
function computeStatus({ hoursSince, daysSince: days, intervalHours, intervalDays }) {
  const ratios = [];
  if (intervalHours != null && intervalHours > 0) ratios.push(hoursSince / intervalHours);
  if (intervalDays != null && intervalDays > 0) ratios.push(days / intervalDays);
  if (!ratios.length) return { status: 'unscheduled', ratio: null };
  const ratio = Math.max(...ratios);
  const status = ratio >= 1 ? 'due' : ratio >= DUE_SOON_RATIO ? 'due_soon' : 'ok';
  return { status, ratio: round(ratio, 3) };
}

/** Decorate a task row with hours/days since last done and its status. */
function shapeTask(row, printerHours) {
  const hours = printerHours || getPrinterHours(row.device_id);
  // Never done: count from the printer's first recorded job, else from the task's creation.
  const baseline = row.last_done_at || hours.firstJobAt || row.created_at;
  const baselineSource = row.last_done_at ? 'last_done' : hours.firstJobAt ? 'first_job' : 'created';
  const hoursSince = getPrintSecondsSince(row.device_id, baseline) / 3600;
  const days = daysSince(baseline);
  const { status, ratio } = computeStatus({
    hoursSince, daysSince: days, intervalHours: row.interval_hours, intervalDays: row.interval_days,
  });
  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name,
    intervalHours: row.interval_hours,
    intervalDays: row.interval_days,
    lastDoneAt: row.last_done_at,
    notes: row.notes || '',
    createdAt: row.created_at,
    baseline,
    baselineSource,
    hoursSince: round(hoursSince, 2),
    daysSince: round(days, 2),
    hoursRemaining: row.interval_hours != null ? round(row.interval_hours - hoursSince, 2) : null,
    daysRemaining: row.interval_days != null ? round(row.interval_days - days, 2) : null,
    ratio,
    status,
  };
}

// ─── Task CRUD ───

function getTaskRow(id) {
  return getDb().prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(id);
}

function getTask(id) {
  const row = getTaskRow(id);
  return row ? shapeTask(row) : null;
}

function getTasks(deviceId) {
  const hours = getPrinterHours(deviceId);
  return getDb().prepare('SELECT * FROM maintenance_tasks WHERE device_id = ? ORDER BY name COLLATE NOCASE, id')
    .all(deviceId).map((r) => shapeTask(r, hours));
}

function createTask({ deviceId, name, intervalHours = null, intervalDays = null, notes = '', lastDoneAt = null }) {
  const r = getDb().prepare(`
    INSERT INTO maintenance_tasks (device_id, name, interval_hours, interval_days, notes, last_done_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, name, intervalHours, intervalDays, notes || '', lastDoneAt);
  return Number(r.lastInsertRowid);
}

const UPDATABLE = { name: 'name', intervalHours: 'interval_hours', intervalDays: 'interval_days', notes: 'notes' };

function updateTask(id, fields) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(UPDATABLE)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return;
  params.push(id);
  getDb().prepare(`UPDATE maintenance_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** Set (or clear) when a task was last done without writing a log row, e.g. "I did this last week". */
function setLastDone(id, lastDoneAt) {
  getDb().prepare('UPDATE maintenance_tasks SET last_done_at = ? WHERE id = ?').run(lastDoneAt, id);
}

function deleteTask(id) {
  return getDb().prepare('DELETE FROM maintenance_tasks WHERE id = ?').run(id).changes > 0;
}

/** Mark a task done now: write a log row (with the printer's current total print hours) and reset. */
function markTaskDone(id, note = '') {
  const db = getDb();
  return db.transaction(() => {
    const row = getTaskRow(id);
    if (!row) return null;
    const { totalSec } = getPrinterHours(row.device_id);
    const now = db.prepare("SELECT datetime('now') AS now").get().now;
    db.prepare('INSERT INTO maintenance_log (task_id, done_at, print_hours_at, note) VALUES (?, ?, ?, ?)')
      .run(id, now, round(totalSec / 3600, 2), note || '');
    db.prepare('UPDATE maintenance_tasks SET last_done_at = ? WHERE id = ?').run(now, id);
    return getTask(id);
  })();
}

function getRecentLog(deviceId, limit = RECENT_LOG_LIMIT) {
  return getDb().prepare(`
    SELECT l.id, l.task_id AS taskId, t.name AS taskName, l.done_at AS doneAt,
      l.print_hours_at AS printHoursAt, l.note
    FROM maintenance_log l JOIN maintenance_tasks t ON t.id = l.task_id
    WHERE t.device_id = ?
    ORDER BY l.done_at DESC, l.id DESC
    LIMIT ?
  `).all(deviceId, limit);
}

/** Add the default task set; skips names the printer already has (case-insensitive). */
function addDefaultTasks(deviceId) {
  const db = getDb();
  return db.transaction(() => {
    const existing = new Set(db.prepare('SELECT name FROM maintenance_tasks WHERE device_id = ?')
      .all(deviceId).map((r) => r.name.trim().toLowerCase()));
    let added = 0;
    for (const t of DEFAULT_TASKS) {
      if (existing.has(t.name.toLowerCase())) continue;
      createTask({ deviceId, ...t });
      added++;
    }
    return added;
  })();
}

// ─── Repeat errors ───

const HMS_KEY_RE = /^([0-9A-F]{4})_([0-9A-F]{4})_([0-9A-F]{4})_([0-9A-F]{4})$/i;

/**
 * Top HMS and print_error codes for a printer over the last `days` days.
 * HMS rows carry the dictionary description + wiki URL; print_error rows don't.
 */
function getRepeatErrors(deviceId, { days = REPEAT_ERROR_DAYS, limit = REPEAT_ERROR_LIMIT } = {}) {
  const stmt = getDb().prepare(`
    SELECT code, COUNT(*) AS count, MAX(ts) AS last_seen, MIN(ts) AS first_seen
    FROM events
    WHERE device_id = ? AND event_type = ? AND code IS NOT NULL AND code != ''
      AND ts >= datetime('now', ?)
    GROUP BY code
    ORDER BY count DESC, last_seen DESC
    LIMIT ?
  `);
  const window = `-${days} days`;
  const hms = stmt.all(deviceId, 'hms_error', window, limit).map((r) => {
    const m = HMS_KEY_RE.exec(r.code);
    let description = null;
    let wikiUrl = null;
    let severity = null;
    if (m) {
      const info = lookupHmsCode(parseInt(m[1] + m[2], 16), parseInt(m[3] + m[4], 16));
      description = info.description;
      wikiUrl = info.wikiUrl;
      severity = info.severity;
    }
    return { code: r.code, count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen, description, wikiUrl, severity };
  });
  const printErrors = stmt.all(deviceId, 'print_error', window, limit).map((r) => ({
    code: r.code, count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
  }));
  return { windowDays: days, hms, printErrors };
}

// ─── Aggregates ───

function getPrinterMaintenance(deviceId) {
  const printer = getDb().prepare('SELECT device_id, name, model FROM printers WHERE device_id = ?').get(deviceId);
  if (!printer) return null;
  const hours = getPrinterHours(deviceId);
  const tasks = getTasks(deviceId);
  return {
    deviceId,
    name: printer.name || deviceId,
    model: printer.model,
    totalPrintHours: round(hours.totalSec / 3600, 2),
    firstJobAt: hours.firstJobAt,
    counts: countStatuses(tasks),
    tasks,
    recentLog: getRecentLog(deviceId),
    repeatErrors: getRepeatErrors(deviceId),
    templates: DEFAULT_TASKS,
  };
}

function countStatuses(tasks) {
  const counts = { tasks: tasks.length, due: 0, dueSoon: 0, ok: 0, unscheduled: 0 };
  for (const t of tasks) {
    if (t.status === 'due') counts.due++;
    else if (t.status === 'due_soon') counts.dueSoon++;
    else if (t.status === 'ok') counts.ok++;
    else counts.unscheduled++;
  }
  return counts;
}

function getMaintenanceSummary() {
  return getDb().prepare('SELECT device_id, name, model FROM printers ORDER BY name').all().map((p) => {
    const hours = getPrinterHours(p.device_id);
    const tasks = getTasks(p.device_id);
    return {
      deviceId: p.device_id,
      name: p.name || p.device_id,
      model: p.model,
      totalPrintHours: round(hours.totalSec / 3600, 2),
      ...countStatuses(tasks),
    };
  });
}

module.exports = {
  DEFAULT_TASKS,
  DUE_SOON_RATIO,
  computeStatus,
  getPrinterHours,
  getPrintSecondsSince,
  getTask,
  getTaskRow,
  getTasks,
  createTask,
  updateTask,
  setLastDone,
  deleteTask,
  markTaskDone,
  getRecentLog,
  addDefaultTasks,
  getRepeatErrors,
  getPrinterMaintenance,
  getMaintenanceSummary,
};
