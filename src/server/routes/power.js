'use strict';

// BAM-18 power API. Roles (src/server/permissions.js):
//   GET  /api/power, /api/power/history/:id        viewer — live readings, circuit totals, energy
//   PUT  /api/power/settings                       admin  — price per kWh, currency, circuit limits
//   *    /api/printers/:id/power-plug[/test]       admin  — plug config (URL, secret) and connection test
// Read-only by design: nothing here can switch a plug. The plug secret is write-only, and the saved
// secret is only ever sent to the saved URL (same rule as the LAN access code).

const express = require('express');
const power = require('../../db/power');
const queries = require('../../db/queries');
const { validatePlug, readPlug, KINDS, PlugError } = require('../../power/plug-readers');
const { audit } = require('../audit');

const CIRCUIT_RE = /^[\w .()-]{1,40}$/;

/** Host only — never the path, query or credentials (they can hold a password). */
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function plugFromBody(b, saved) {
  // Blank URL = keep the saved one (it may embed credentials the UI never sees)
  const url = typeof b.url === 'string' ? b.url.trim() : b.url;
  return {
    kind: b.kind,
    url: !url && saved ? saved.url : url,
    channel: b.channel === undefined || b.channel === null || b.channel === '' ? 0 : Number(b.channel),
    entity: b.entity ? String(b.entity).trim() : null,
    jsonPath: b.jsonPath ? String(b.jsonPath).trim() : null,
    circuit: typeof b.circuit === 'string' ? b.circuit.trim() : '',
    enabled: b.enabled === undefined ? (saved?.enabled ?? true) : b.enabled,
  };
}

function validateSettings(b) {
  const errors = [];
  if (b.pricePerKwh !== undefined && b.pricePerKwh !== null && !(typeof b.pricePerKwh === 'number' && b.pricePerKwh >= 0 && b.pricePerKwh <= 100)) errors.push('pricePerKwh must be a number from 0 to 100');
  if (b.currency !== undefined && b.currency !== null && !(typeof b.currency === 'string' && /^[\p{L}\p{Sc} ]{0,8}$/u.test(b.currency))) errors.push('currency: up to 8 letters or a currency symbol');
  if (b.circuits !== undefined) {
    if (!Array.isArray(b.circuits) || b.circuits.length > 20) errors.push('circuits must be a list of up to 20');
    else {
      const names = new Set();
      for (const c of b.circuits) {
        if (!c || typeof c.name !== 'string' || !CIRCUIT_RE.test(c.name.trim())) { errors.push('circuit names: 1–40 letters, digits, space . _ - ( )'); break; }
        if (!(Number.isFinite(c.limitW) && c.limitW >= 100 && c.limitW <= 100000)) { errors.push(`circuit "${c.name}": limitW must be 100–100000`); break; }
        if (names.has(c.name.trim())) { errors.push(`duplicate circuit "${c.name}"`); break; }
        names.add(c.name.trim());
      }
    }
  }
  return errors;
}

/**
 * @param {object} deps
 * @param {object} deps.powerMonitor — snapshot(), circuitStatus(), pollOnce()
 * @param {function} [deps.read] — injectable plug reader (tests)
 */
function createPowerRouter({ powerMonitor, read = readPlug }) {
  const router = express.Router();
  const printerExists = (id) => Boolean(queries.getPrinter(id));

  router.get('/power', (req, res) => {
    const readings = {};
    for (const p of power.listPlugs()) readings[p.deviceId] = powerMonitor?.snapshot(p.deviceId) || { ok: null, watts: null, circuit: p.circuit || '', enabled: p.enabled };
    const s = power.getSettings();
    res.json({
      settings: s,
      circuits: powerMonitor?.circuitStatus() || [],
      readings,
      totals: { last30Days: power.energyTotals(30), allTime: power.energyTotals(null) },
    });
  });

  router.get('/power/history/:id', (req, res) => {
    if (!printerExists(req.params.id)) return res.status(404).json({ error: 'Printer not found' });
    res.json(power.getHistory(req.params.id, req.query.hours));
  });

  router.put('/power/settings', (req, res) => {
    const b = req.body || {};
    const errors = validateSettings(b);
    if (errors.length) {
      audit(req, { action: 'power.settings.update', result: 'rejected', detail: { errors } });
      return res.status(400).json({ error: errors.join('; ') });
    }
    const circuits = b.circuits?.map((c) => ({ name: c.name.trim(), limitW: Math.round(c.limitW) }));
    const s = power.setSettings({ pricePerKwh: b.pricePerKwh, currency: b.currency?.trim(), circuits });
    audit(req, { action: 'power.settings.update', result: 'ok', detail: { pricePerKwh: s.pricePerKwh, currency: s.currency, circuits: s.circuits } });
    res.json(s);
  });

  router.get('/printers/:id/power-plug', (req, res) => {
    if (!printerExists(req.params.id)) return res.status(404).json({ error: 'Printer not found' });
    res.json({ deviceId: req.params.id, plug: power.publicPlug(power.getPlug(req.params.id)), kinds: KINDS });
  });

  router.put('/printers/:id/power-plug', (req, res) => {
    const id = req.params.id;
    const target = `printer:${String(id).slice(0, 64)}`;
    if (!printerExists(id)) return res.status(404).json({ error: 'Printer not found' });
    const b = req.body || {};
    const saved = power.getPlug(id);
    const plug = plugFromBody(b, saved);
    const errors = validatePlug(plug);
    if (plug.circuit && !CIRCUIT_RE.test(plug.circuit)) errors.push('circuit: 1–40 letters, digits, space . _ - ( )');
    if (typeof plug.enabled !== 'boolean') errors.push('enabled must be true or false');
    if (b.secret !== undefined && b.secret !== null && !(typeof b.secret === 'string' && b.secret.length <= 500)) errors.push('secret must be a string');
    if (errors.length) {
      audit(req, { action: 'power.plug.update', result: 'rejected', target, detail: { errors } });
      return res.status(400).json({ error: errors.join('; ') });
    }
    // A new address needs the secret typed again: the saved one is only ever sent to the saved URL
    const urlChanged = saved && saved.url !== plug.url;
    const secret = b.secret !== undefined ? b.secret : (urlChanged ? null : undefined);
    const after = power.setPlug(id, { ...plug, secret });
    audit(req, { action: 'power.plug.update', result: 'ok', target, detail: { kind: after.kind, host: hostOf(after.url), circuit: after.circuit, enabled: after.enabled, secretChanged: (saved?.secret || null) !== (after.secret || null) } });
    powerMonitor?.pollOnce?.().catch(() => {});
    res.json({ deviceId: id, plug: power.publicPlug(after) });
  });

  router.delete('/printers/:id/power-plug', (req, res) => {
    const id = req.params.id;
    const removed = power.deletePlug(id);
    audit(req, { action: 'power.plug.delete', result: removed ? 'ok' : 'rejected', target: `printer:${String(id).slice(0, 64)}` });
    if (!removed) return res.status(404).json({ error: 'No plug configured for this printer' });
    powerMonitor?.pollOnce?.().catch(() => {});
    res.json({ deleted: true });
  });

  // POST /api/printers/:id/power-plug/test { kind?, url?, ... } — defaults to the saved plug
  router.post('/printers/:id/power-plug/test', async (req, res) => {
    const id = req.params.id;
    const target = `printer:${String(id).slice(0, 64)}`;
    if (!printerExists(id)) return res.status(404).json({ error: 'Printer not found' });
    const saved = power.getPlug(id);
    const b = req.body && Object.keys(req.body).length ? req.body : null;
    const plug = b ? plugFromBody(b, saved) : saved;
    if (!plug) return res.status(400).json({ error: 'No plug configured — fill in the plug details to test' });
    const errors = validatePlug(plug);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const sameUrl = saved && saved.url === plug.url;
    plug.secret = b?.secret || (sameUrl ? saved.secret : null);
    try {
      const r = await read(plug);
      audit(req, { action: 'power.plug.test', result: 'ok', target, detail: { kind: plug.kind, host: hostOf(plug.url) } });
      res.json({ ok: true, watts: r.watts, totalWh: r.totalWh ?? null });
    } catch (err) {
      audit(req, { action: 'power.plug.test', result: 'error', target, detail: { kind: plug.kind, host: hostOf(plug.url) } });
      res.json({ ok: false, message: err instanceof PlugError ? err.message : 'Plug test failed' });
    }
  });

  return router;
}

module.exports = { createPowerRouter, validateSettings };
