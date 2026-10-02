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

module.exports = { createApiRouter, clampLimit };
