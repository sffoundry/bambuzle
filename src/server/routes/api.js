'use strict';

const express = require('express');
const queries = require('../../db/queries');
const { buildPause, buildResume, buildStop, buildSetSpeed } = require('../../bambu/commands');
const { getAuthStatus } = require('../../bambu/auth');

// Upper bounds for ?limit= (BAM-30 / code-review 2026-10-02 M3). The charts request 10000 samples.
const MAX_LIMIT = { samples: 20000, events: 2000, jobs: 500 };

/** Parse a ?limit= value, falling back to `def` and clamping to [1, max]. */
function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// Strict ISO 8601 date / date-time (BAM-10 /api/stats). Date.parse alone accepts too much.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const STATS_DEFAULT_DAYS = 30;

/**
 * Parse an ISO date or date-time query value. A bare date as `to` means the end of that (UTC) day.
 * @returns {Date|null} null when missing; throws on garbage
 */
function parseIsoParam(raw, { endOfDay = false } = {}) {
  if (raw === undefined || raw === '') return null;
  const m = typeof raw === 'string' ? ISO_DATE_RE.exec(raw) : null;
  if (!m) throw new Error('invalid');
  const dateOnly = m[4] === undefined;
  // Bare dates and offset-less date-times are treated as UTC (matching how SQLite stores timestamps).
  const normalized = dateOnly
    ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : (m[7] ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`);
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new Error('invalid');
  // Reject roll-over calendar dates like 2026-02-31 and out-of-range times like 25:00.
  const cal = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (cal.getUTCFullYear() !== +m[1] || cal.getUTCMonth() + 1 !== +m[2] || cal.getUTCDate() !== +m[3]) throw new Error('invalid');
  if (!dateOnly && (+m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59))) throw new Error('invalid');
  return d;
}

/** SQLite datetime() form: 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toSqlDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Create API router.
 * @param {object} printerManager — object with getLiveStates(), getClient(deviceId) methods
 */
function createApiRouter(printerManager) {
  const router = express.Router();

  // GET /api/printers — all printers with live state
  router.get('/printers', (req, res) => {
    const dbPrinters = queries.getAllPrinters();
    const liveStates = printerManager.getLiveStates();

    const printers = dbPrinters.map((p) => ({
      ...p,
      live: liveStates[p.device_id] || null,
      connected: printerManager.isConnected(p.device_id),
    }));

    res.json(printers);
  });

  // GET /api/printers/:id/history — time-series samples
  router.get('/printers/:id/history', (req, res) => {
    const { from, to, limit } = req.query;
    const samples = queries.getSamples(req.params.id, {
      from: from || undefined,
      to: to || undefined,
      limit: clampLimit(limit, 5000, MAX_LIMIT.samples),
    });
    res.json(samples);
  });

  // GET /api/printers/:id/events — events list
  router.get('/printers/:id/events', (req, res) => {
    const { from, to, limit } = req.query;
    const events = queries.getEvents(req.params.id, {
      from: from || undefined,
      to: to || undefined,
      limit: clampLimit(limit, 200, MAX_LIMIT.events),
    });
    res.json(events);
  });

  // GET /api/printers/:id/jobs/:jobId/layers — layer transitions for a job
  router.get('/printers/:id/jobs/:jobId/layers', (req, res) => {
    const layers = queries.getLayerTransitions(parseInt(req.params.jobId, 10));
    res.json(layers);
  });

  // GET /api/printers/:id/jobs/:jobId/anomalies — temp anomalies for a job
  router.get('/printers/:id/jobs/:jobId/anomalies', (req, res) => {
    const anomalies = queries.getTempAnomalies(parseInt(req.params.jobId, 10));
    res.json(anomalies);
  });

  // GET /api/printers/:id/jobs/:jobId/pauses — pause records for a job
  router.get('/printers/:id/jobs/:jobId/pauses', (req, res) => {
    const pauses = queries.getJobPauses(parseInt(req.params.jobId, 10));
    res.json(pauses);
  });

  // GET /api/printers/:id/anomalies — temp anomalies in time window
  router.get('/printers/:id/anomalies', (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Both from and to query params are required' });
    }
    const anomalies = queries.getTempAnomaliesInWindow(req.params.id, from, to);
    res.json(anomalies);
  });

  // GET /api/printers/:id/pauses — job pauses in time window
  router.get('/printers/:id/pauses', (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Both from and to query params are required' });
    }
    const pauses = queries.getJobPausesInWindow(req.params.id, from, to);
    res.json(pauses);
  });

  // GET /api/printers/:id/jobs — print job history
  router.get('/printers/:id/jobs', (req, res) => {
    const limit = clampLimit(req.query.limit, 50, MAX_LIMIT.jobs);
    const jobs = queries.getJobs(req.params.id, limit);
    res.json(jobs);
  });

  // POST /api/printers/:id/command — send command to printer (requires auth)
  router.post('/printers/:id/command', (req, res) => {
    if (getAuthStatus() !== 'authenticated') {
      return res.status(401).json({ error: 'Not authenticated — please log in first' });
    }

    const { command, param } = req.body;
    const client = printerManager.getClient(req.params.id);

    if (!client) {
      return res.status(404).json({ error: 'Printer not found or not connected' });
    }

    let cmd;
    switch (command) {
      case 'pause':
        cmd = buildPause();
        break;
      case 'resume':
        cmd = buildResume();
        break;
      case 'stop':
        cmd = buildStop();
        break;
      case 'set_speed':
        cmd = buildSetSpeed(parseInt(param, 10));
        break;
      default:
        return res.status(400).json({ error: `Unknown command: ${command}` });
    }

    const sent = client.sendCommand(cmd);
    res.json({ ok: sent });
  });

  // GET /api/printers/:id/debug/mqtt — raw MQTT merged state for diagnostics
  router.get('/printers/:id/debug/mqtt', (req, res) => {
    const client = printerManager.getClient(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Printer not found or not connected' });
    }
    res.json({
      deviceId: req.params.id,
      connected: client.connected,
      mergedState: client.mergedState,
    });
  });

  // GET /api/stats — print job statistics (BAM-10). Default window: last 30 days.
  router.get('/stats', (req, res) => {
    const { printer } = req.query;
    let from;
    let to;
    try {
      from = parseIsoParam(req.query.from);
      to = parseIsoParam(req.query.to, { endOfDay: true });
    } catch {
      return res.status(400).json({ error: 'from/to must be ISO 8601 dates (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)' });
    }
    if (printer !== undefined && (typeof printer !== 'string' || printer.length > 128)) {
      return res.status(400).json({ error: 'Invalid printer' });
    }
    if (!to) to = new Date();
    if (!from) from = new Date(to.getTime() - STATS_DEFAULT_DAYS * 86400 * 1000);
    if (from > to) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    const window = { from: toSqlDatetime(from), to: toSqlDatetime(to) };
    const stats = queries.getJobStats({ deviceId: printer || undefined, ...window });
    res.json({ window: { ...window, printer: printer || null }, ...stats });
  });

  // GET /api/events — recent events across all printers
  router.get('/events', (req, res) => {
    const { limit, from, to } = req.query;
    const events = queries.getRecentEvents({
      limit: clampLimit(limit, 100, MAX_LIMIT.events),
      from: from || undefined,
      to: to || undefined,
    });
    res.json(events);
  });

  return router;
}

module.exports = { createApiRouter, clampLimit, parseIsoParam };
