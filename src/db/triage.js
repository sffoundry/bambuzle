'use strict';

// Data loading for job triage (BAM-40). Pure verdict logic lives in src/printers/job-triage.js.

const { getDb } = require('./database');
const queries = require('./queries');
const { triageJob } = require('../printers/job-triage');

function getJob(deviceId, jobId) {
  return getDb().prepare('SELECT * FROM print_jobs WHERE id = ? AND device_id = ?').get(jobId, deviceId) || null;
}

function getJobEvents(jobId) {
  return getDb().prepare(`SELECT ts, event_type, severity, code, message FROM events
    WHERE job_id = ? AND event_type IN ('hms_error', 'print_error', 'state_change', 'command') ORDER BY ts`).all(jobId);
}

/** Full triage for one job, or null if it doesn't belong to this printer. */
function triageForJob(deviceId, jobId) {
  const job = getJob(deviceId, jobId);
  if (!job) return null;
  return triageJob({
    job,
    events: getJobEvents(jobId),
    anomalies: queries.getTempAnomalies(jobId),
    pauses: queries.getJobPauses(jobId),
    layers: queries.getLayerTransitions(jobId),
  });
}

/** Verdicts for a printer's recent jobs (newest first) — without the full timelines. */
function triageRecentJobs(deviceId, limit = 25) {
  return queries.getJobs(deviceId, limit).map((j) => {
    const t = triageForJob(deviceId, j.id);
    return { id: j.id, subtask_name: j.subtask_name, started_at: j.started_at, ended_at: j.ended_at, end_state: j.end_state, verdict: t.verdict, reasons: t.reasons };
  });
}

module.exports = { triageForJob, triageRecentJobs };
