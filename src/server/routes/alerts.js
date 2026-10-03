'use strict';

const express = require('express');
const queries = require('../../db/queries');
const { audit } = require('../audit');

/**
 * Audit detail for a rule (BAM-41): name, condition type and channel ONLY. notify_config holds secrets
 * (bot tokens, webhook URLs, Pushover keys) and is never copied into the trail.
 */
function ruleSummary(rule) {
  return {
    name: rule?.name != null ? String(rule.name).slice(0, 100) : null,
    conditionType: rule?.condition_type ?? null,
    notifyVia: rule?.notify_via ?? null,
  };
}

function createAlertsRouter() {
  const router = express.Router();

  // GET /api/alerts — list all alert rules
  router.get('/', (req, res) => {
    const rules = queries.getAllAlertRules().map(formatRule);
    res.json(rules);
  });

  // GET /api/alerts/:id — get single alert rule
  router.get('/:id', (req, res) => {
    const rule = queries.getAlertRule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Alert rule not found' });
    res.json(formatRule(rule));
  });

  // POST /api/alerts — create alert rule
  router.post('/', (req, res) => {
    const { name, deviceId, conditionType, conditionConfig, notifyVia, notifyConfig, cooldownSec } = req.body;

    if (!name || !conditionType) {
      audit(req, { action: 'alert.create', result: 'rejected', detail: { status: 400, reason: 'missing_fields' } });
      return res.status(400).json({ error: 'name and conditionType are required' });
    }

    const id = queries.createAlertRule({
      name,
      deviceId: deviceId || null,
      conditionType,
      conditionConfig: conditionConfig || {},
      notifyVia: notifyVia || 'console',
      notifyConfig: notifyConfig || {},
      cooldownSec: cooldownSec ?? 300,
    });

    const rule = queries.getAlertRule(id);
    audit(req, { action: 'alert.create', result: 'ok', target: `alert:${id}`, detail: ruleSummary(rule) });
    res.status(201).json(formatRule(rule));
  });

  // PUT /api/alerts/:id — update alert rule
  router.put('/:id', (req, res) => {
    const existing = queries.getAlertRule(req.params.id);
    if (!existing) {
      audit(req, { action: 'alert.update', result: 'rejected', target: `alert:${String(req.params.id).slice(0, 32)}`, detail: { status: 404 } });
      return res.status(404).json({ error: 'Alert rule not found' });
    }

    const allowed = ['name', 'enabled', 'deviceId', 'conditionType', 'conditionConfig', 'notifyVia', 'notifyConfig', 'cooldownSec'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    queries.updateAlertRule(req.params.id, updates);
    const rule = queries.getAlertRule(req.params.id);
    // Field NAMES only (e.g. 'notifyConfig'), never their values
    audit(req, { action: 'alert.update', result: 'ok', target: `alert:${existing.id}`, detail: { ...ruleSummary(rule), fields: Object.keys(updates) } });
    res.json(formatRule(rule));
  });

  // DELETE /api/alerts/:id — delete alert rule
  router.delete('/:id', (req, res) => {
    const existing = queries.getAlertRule(req.params.id);
    if (!existing) {
      audit(req, { action: 'alert.delete', result: 'rejected', target: `alert:${String(req.params.id).slice(0, 32)}`, detail: { status: 404 } });
      return res.status(404).json({ error: 'Alert rule not found' });
    }
    queries.deleteAlertRule(req.params.id);
    audit(req, { action: 'alert.delete', result: 'ok', target: `alert:${existing.id}`, detail: ruleSummary(existing) });
    res.json({ ok: true });
  });

  return router;
}

/** Parse JSON strings in DB row for API response */
function formatRule(rule) {
  return {
    ...rule,
    condition_config: tryParse(rule.condition_config),
    notify_config: tryParse(rule.notify_config),
  };
}

function tryParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

module.exports = { createAlertsRouter };
