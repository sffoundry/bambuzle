'use strict';

// Printer connection settings API (BAM-35). Mounted under /api (admin-guarded). The access code is
// write-only: responses carry `hasAccessCode`, never the code.

const express = require('express');
const conns = require('../../db/printer-connections');
const { validHost, validAccessCode, validSerial } = require('../../printers/transport-policy');
const { probeLan } = require('../../printers/lan-probe');
const config = require('../../config');
const { audit } = require('../audit');

// Audit trail (BAM-41): access codes are NEVER recorded — only whether one changed / was supplied.
const target = (id) => `printer:${String(id).slice(0, 64)}`;

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
    const before = conns.getConnection(id);
    const reject = (status, error, field) => {
      audit(req, { action: 'printer.connection.update', result: 'rejected', target: target(id), detail: { status, field } });
      return res.status(status).json({ error });
    };
    if (!before) return reject(404, 'Printer not found');
    const { mode, lanHost, accessCode } = req.body || {};
    if (mode !== undefined && !conns.MODES.includes(mode)) return reject(400, `mode must be one of ${conns.MODES.join(', ')}`, 'mode');
    if (lanHost !== undefined && lanHost !== '' && lanHost !== null && !validHost(lanHost)) return reject(400, 'lanHost must be an IPv4 address or hostname', 'lanHost');
    if (accessCode !== undefined && accessCode !== '' && accessCode !== null && !validAccessCode(accessCode)) return reject(400, 'accessCode must be the 8-character LAN access code from the printer screen', 'accessCode');
    conns.setConnection(id, { mode, lanHost, accessCode });
    const after = conns.getConnection(id);
    const detail = {};
    if (after.mode !== before.mode) detail.mode = { from: before.mode, to: after.mode };
    if (after.lanHost !== before.lanHost) detail.lanHost = { from: before.lanHost, to: after.lanHost };
    if (after.accessCode !== before.accessCode) {
      detail.accessCodeChanged = true;
      if (!after.accessCode) detail.accessCodeCleared = true;
    }
    if (!Object.keys(detail).length) detail.unchanged = true;
    audit(req, { action: 'printer.connection.update', result: 'ok', target: target(id), detail });
    printerManager.reconnect?.(id);
    res.json(view(id));
  });

  // POST /api/printers/:id/connection/test { lanHost?, accessCode? } — defaults to the saved settings
  router.post('/printers/:id/connection/test', async (req, res) => {
    const id = req.params.id;
    const saved = conns.getConnection(id);
    const record = (result, detail) => audit(req, { action: 'printer.connection.test', result, target: target(id), detail });
    if (!saved) {
      record('rejected', { status: 404 });
      return res.status(404).json({ error: 'Printer not found' });
    }
    const host = req.body?.lanHost || saved.lanHost;
    // The saved code is only ever sent to the saved host — a new host needs the code typed again (review #8)
    const hostChanged = Boolean(req.body?.lanHost) && req.body.lanHost !== saved.lanHost;
    const accessCode = req.body?.accessCode || (hostChanged ? null : saved.accessCode);
    const probeDetail = { host: validHost(host || '') ? host : null, hostChanged, accessCodeSupplied: Boolean(req.body?.accessCode) };
    if (!validHost(host || '') || !validAccessCode(accessCode || '')) {
      record('rejected', { ...probeDetail, status: 400 });
      return res.status(400).json({ error: hostChanged && !req.body?.accessCode
        ? 'Enter the access code to test a new address (the saved code is only sent to the saved address)'
        : 'Need a valid lanHost and 8-character accessCode (saved or in the request)' });
    }
    // Already connected over LAN with these settings: report the live session instead of opening a second
    // one — printers allow only a few local MQTT clients (review #9)
    if (!hostChanged && !req.body?.accessCode && printerManager.getTransportKind?.(id) === 'lan' && printerManager.isConnected?.(id)) {
      const caps = printerManager.getCapabilities?.(id);
      record('ok', { ...probeDetail, ok: true, stage: 'connected', liveSession: true });
      return res.json({ ok: true, stage: 'connected', message: 'Connected (live session)', developerMode: caps?.developerMode ?? null });
    }
    try {
      const result = await probe({ serial: id, host, accessCode, tlsVerify: config.lan.tlsVerify });
      record(result?.ok ? 'ok' : 'error', { ...probeDetail, ok: Boolean(result?.ok), stage: result?.stage ?? null });
      res.json(result);
    } catch (err) {
      record('error', { ...probeDetail, ok: false, stage: 'error' });
      res.status(500).json({ ok: false, stage: 'error', message: err.message });
    }
  });

  // POST /api/printers { serial, name, model?, lanHost, accessCode } — add a LAN-only printer by hand
  router.post('/printers', (req, res) => {
    const { serial, name, model, lanHost, accessCode } = req.body || {};
    const reject = (status, error, field) => {
      audit(req, {
        action: 'printer.add', result: 'rejected', target: validSerial(serial) ? target(conns.normalizeSerial(serial)) : null, detail: { status, field },
      });
      return res.status(status).json({ error });
    };
    if (!validSerial(serial)) return reject(400, 'serial must be the printer serial number (8–20 letters/digits)', 'serial');
    if (typeof name !== 'string' || !name.trim() || name.length > 64) return reject(400, 'name is required (max 64 characters)', 'name');
    if (model !== undefined && (typeof model !== 'string' || model.length > 32)) return reject(400, 'model must be a short string', 'model');
    if (!validHost(lanHost)) return reject(400, 'lanHost must be an IPv4 address or hostname', 'lanHost');
    if (!validAccessCode(accessCode)) return reject(400, 'accessCode must be the 8-character LAN access code', 'accessCode');
    const existing = conns.findBySerial(serial);
    if (existing && existing.source !== 'removed') {
      audit(req, { action: 'printer.add', result: 'rejected', target: target(existing.device_id), detail: { status: 409, reason: 'duplicate' } });
      return res.status(409).json({ error: 'A printer with this serial already exists — edit its connection instead' });
    }
    const id = conns.addManualPrinter({ serial, name: name.trim(), model, lanHost, accessCode });
    audit(req, {
      action: 'printer.add', result: 'ok', target: target(id),
      detail: { name: name.trim(), model: model || null, lanHost, revived: existing?.source === 'removed' },
    });
    printerManager.reconnect?.(id);
    res.status(201).json(view(id));
  });

  // DELETE /api/printers/:id — hand-added printers only
  router.delete('/printers/:id', (req, res) => {
    if (!conns.deleteManualPrinter(req.params.id)) {
      audit(req, { action: 'printer.remove', result: 'rejected', target: target(req.params.id), detail: { status: 404 } });
      return res.status(404).json({ error: 'No hand-added printer with this serial (cloud printers are managed by your Bambu account)' });
    }
    audit(req, { action: 'printer.remove', result: 'ok', target: target(req.params.id) });
    printerManager.reconnect?.(req.params.id);
    res.json({ deleted: req.params.id });
  });

  return router;
}

module.exports = { createPrinterConnectionsRouter, publicConnection };
