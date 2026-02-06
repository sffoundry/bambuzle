'use strict';

const express = require('express');
const queries = require('../../db/queries');

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
    res.status(201).json(formatRule(rule));
  });

  // PUT /api/alerts/:id — update alert rule
  router.put('/:id', (req, res) => {
    const existing = queries.getAlertRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Alert rule not found' });

    const allowed = ['name', 'enabled', 'deviceId', 'conditionType', 'conditionConfig', 'notifyVia', 'notifyConfig', 'cooldownSec'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    queries.updateAlertRule(req.params.id, updates);
    const rule = queries.getAlertRule(req.params.id);
    res.json(formatRule(rule));
  });

  // DELETE /api/alerts/:id — delete alert rule
  router.delete('/:id', (req, res) => {
    const existing = queries.getAlertRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Alert rule not found' });
    queries.deleteAlertRule(req.params.id);
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
