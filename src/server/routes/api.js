'use strict';

const express = require('express');
const queries = require('../../db/queries');
const { buildPause, buildResume, buildStop, buildSetSpeed } = require('../../bambu/commands');

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
      limit: limit ? parseInt(limit, 10) : 5000,
    });
    res.json(samples);
  });

  // GET /api/printers/:id/events — events list
  router.get('/printers/:id/events', (req, res) => {
    const { from, to, limit } = req.query;
    const events = queries.getEvents(req.params.id, {
      from: from || undefined,
      to: to || undefined,
      limit: limit ? parseInt(limit, 10) : 200,
    });
    res.json(events);
  });

  // GET /api/printers/:id/jobs — print job history
  router.get('/printers/:id/jobs', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const jobs = queries.getJobs(req.params.id, limit);
    res.json(jobs);
  });

  // POST /api/printers/:id/command — send command to printer
  router.post('/printers/:id/command', (req, res) => {
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

  // GET /api/events — recent events across all printers
  router.get('/events', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const events = queries.getRecentEvents(limit);
    res.json(events);
  });

  return router;
}

module.exports = { createApiRouter };
