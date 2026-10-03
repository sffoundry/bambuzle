'use strict';

// Printer connection settings API (BAM-35). Mounted under /api (admin-guarded). The access code is
// write-only: responses carry `hasAccessCode`, never the code.

const express = require('express');
const conns = require('../../db/printer-connections');
const { validHost, validAccessCode, validSerial } = require('../../printers/transport-policy');
const { probeLan } = require('../../printers/lan-probe');
const config = require('../../config');

function publicConnection(c) {
  return c && { mode: c.mode, lanHost: c.lanHost, hasAccessCode: Boolean(c.accessCode), source: c.source };
}

/**
 * @param {object} printerManager — needs reconnect(id), getCapabilities(id)
 * @param {object} [opts]
 * @param {function} [opts.probe] — injectable LAN probe (tests)
 */
function createPrinterConnectionsRouter(printerManager, { probe = probeLan } = {}) {
  const router = express.Router();

  const view = (id) => ({
    deviceId: id,
    connection: publicConnection(conns.getConnection(id)),
    capabilities: printerManager.getCapabilities ? printerManager.getCapabilities(id) : null,
  });

  // GET /api/printers/:id/connection
  router.get('/printers/:id/connection', (req, res) => {
    if (!conns.getConnection(req.params.id)) return res.status(404).json({ error: 'Printer not found' });
    res.json(view(req.params.id));
  });

  // PUT /api/printers/:id/connection { mode?, lanHost?, accessCode? }  (accessCode: omit = keep, '' = clear)
  router.put('/printers/:id/connection', (req, res) => {
    const id = req.params.id;
    if (!conns.getConnection(id)) return res.status(404).json({ error: 'Printer not found' });
    const { mode, lanHost, accessCode } = req.body || {};
    if (mode !== undefined && !conns.MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${conns.MODES.join(', ')}` });
    if (lanHost !== undefined && lanHost !== '' && lanHost !== null && !validHost(lanHost)) return res.status(400).json({ error: 'lanHost must be an IPv4 address or hostname' });
    if (accessCode !== undefined && accessCode !== '' && accessCode !== null && !validAccessCode(accessCode)) return res.status(400).json({ error: 'accessCode must be the 8-character LAN access code from the printer screen' });
    conns.setConnection(id, { mode, lanHost, accessCode });
    printerManager.reconnect?.(id);
    res.json(view(id));
  });

  // POST /api/printers/:id/connection/test { lanHost?, accessCode? } — defaults to the saved settings
  router.post('/printers/:id/connection/test', async (req, res) => {
    const id = req.params.id;
    const saved = conns.getConnection(id);
    if (!saved) return res.status(404).json({ error: 'Printer not found' });
    const host = req.body?.lanHost || saved.lanHost;
    const accessCode = req.body?.accessCode || saved.accessCode;
    if (!validHost(host || '') || !validAccessCode(accessCode || '')) {
      return res.status(400).json({ error: 'Need a valid lanHost and 8-character accessCode (saved or in the request)' });
    }
    try {
      res.json(await probe({ serial: id, host, accessCode, tlsVerify: config.lan.tlsVerify }));
    } catch (err) {
      res.status(500).json({ ok: false, stage: 'error', message: err.message });
    }
  });

  // POST /api/printers { serial, name, model?, lanHost, accessCode } — add a LAN-only printer by hand
  router.post('/printers', (req, res) => {
    const { serial, name, model, lanHost, accessCode } = req.body || {};
    if (!validSerial(serial)) return res.status(400).json({ error: 'serial must be the printer serial number (8–20 letters/digits)' });
    if (typeof name !== 'string' || !name.trim() || name.length > 64) return res.status(400).json({ error: 'name is required (max 64 characters)' });
    if (model !== undefined && (typeof model !== 'string' || model.length > 32)) return res.status(400).json({ error: 'model must be a short string' });
    if (!validHost(lanHost)) return res.status(400).json({ error: 'lanHost must be an IPv4 address or hostname' });
    if (!validAccessCode(accessCode)) return res.status(400).json({ error: 'accessCode must be the 8-character LAN access code' });
    if (conns.getConnection(serial)) return res.status(409).json({ error: 'A printer with this serial already exists — edit its connection instead' });
    conns.addManualPrinter({ serial, name: name.trim(), model, lanHost, accessCode });
    printerManager.reconnect?.(serial);
    res.status(201).json(view(serial));
  });

  // DELETE /api/printers/:id — hand-added printers only
  router.delete('/printers/:id', (req, res) => {
    if (!conns.deleteManualPrinter(req.params.id)) {
      return res.status(404).json({ error: 'No hand-added printer with this serial (cloud printers are managed by your Bambu account)' });
    }
    printerManager.reconnect?.(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return router;
}

module.exports = { createPrinterConnectionsRouter, publicConnection };
