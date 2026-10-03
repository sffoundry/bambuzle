'use strict';

// Maintenance ledger API (BAM-39). Mounted at /api/maintenance, behind the admin guard.

const express = require('express');
const queries = require('../../db/queries');
const maintenance = require('../../db/maintenance');
const { parseIsoParam } = require('./api');

const NAME_MAX = 100;
const NOTES_MAX = 1000;
const NOTE_MAX = 500;
const INTERVAL_HOURS_MAX = 100000;
const INTERVAL_DAYS_MAX = 3650;

class ValidationError extends Error {}

/** undefined = not supplied; null/'' = clear; otherwise a positive number (integer for days). */
function parseInterval(raw, field, { integer, max }) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) {
    throw new ValidationError(`${field} must be a positive ${integer ? 'integer' : 'number'} (max ${max}) or null`);
  }
  return n;
}

function parseName(raw) {
  if (typeof raw !== 'string' || raw.trim().length < 1 || raw.trim().length > NAME_MAX) {
    throw new ValidationError(`name must be 1-${NAME_MAX} characters`);
  }
  return raw.trim();
}

function parseText(raw, field, max) {
  if (raw === undefined) return undefined;
  if (raw === null) return '';
  if (typeof raw !== 'string' || raw.length > max) throw new ValidationError(`${field} must be a string of at most ${max} characters`);
  return raw.trim();
}

/** Optional "last done" date (ISO 8601, not in the future) → SQLite datetime. */
function parseLastDone(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  let d;
  try { d = parseIsoParam(raw); } catch { d = null; }
  if (!d || d.getTime() > Date.now() + 60_000) throw new ValidationError('lastDoneAt must be an ISO 8601 date not in the future');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseTaskId(raw) {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

function sendError(res, err) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  throw err;
}

function createMaintenanceRouter() {
  const router = express.Router();

  // GET /api/maintenance — per-printer summary (hours, due / due-soon counts)
  router.get('/', (req, res) => {
    res.json(maintenance.getMaintenanceSummary());
  });

  // PUT /api/maintenance/tasks/:id — update a task
  router.put('/tasks/:id', (req, res) => {
    const id = parseTaskId(req.params.id);
    const existing = id && maintenance.getTaskRow(id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const body = req.body || {};
    try {
      const fields = {
        name: body.name !== undefined ? parseName(body.name) : undefined,
        intervalHours: parseInterval(body.intervalHours, 'intervalHours', { integer: false, max: INTERVAL_HOURS_MAX }),
        intervalDays: parseInterval(body.intervalDays, 'intervalDays', { integer: true, max: INTERVAL_DAYS_MAX }),
        notes: parseText(body.notes, 'notes', NOTES_MAX),
      };
      const lastDoneAt = parseLastDone(body.lastDoneAt);
      if (fields.intervalHours !== undefined || fields.intervalDays !== undefined) {
        const hours = fields.intervalHours !== undefined ? fields.intervalHours : existing.interval_hours;
        const days = fields.intervalDays !== undefined ? fields.intervalDays : existing.interval_days;
        if (hours == null && days == null) throw new ValidationError('Set intervalHours and/or intervalDays');
      }
      maintenance.updateTask(id, fields);
      if (lastDoneAt !== undefined) maintenance.setLastDone(id, lastDoneAt);
    } catch (err) {
      return sendError(res, err);
    }
    res.json(maintenance.getTask(id));
  });

  // DELETE /api/maintenance/tasks/:id — delete a task (its log cascades)
  router.delete('/tasks/:id', (req, res) => {
    const id = parseTaskId(req.params.id);
    if (!id || !maintenance.deleteTask(id)) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  });

  // POST /api/maintenance/tasks/:id/done — mark done now (optional { note })
  router.post('/tasks/:id/done', (req, res) => {
    const id = parseTaskId(req.params.id);
    if (!id || !maintenance.getTaskRow(id)) return res.status(404).json({ error: 'Task not found' });
    let note;
    try {
      note = parseText((req.body || {}).note, 'note', NOTE_MAX);
    } catch (err) {
      return sendError(res, err);
    }
    res.json(maintenance.markTaskDone(id, note || ''));
  });

  // GET /api/maintenance/:deviceId — tasks with status, hours, recent log, repeat errors
  router.get('/:deviceId', (req, res) => {
    const data = maintenance.getPrinterMaintenance(req.params.deviceId);
    if (!data) return res.status(404).json({ error: 'Printer not found' });
    res.json(data);
  });

  // POST /api/maintenance/:deviceId/tasks — create a task
  router.post('/:deviceId/tasks', (req, res) => {
    const deviceId = req.params.deviceId;
    if (!queries.getPrinter(deviceId)) return res.status(404).json({ error: 'Printer not found' });
    const body = req.body || {};
    let id;
    try {
      const name = parseName(body.name);
      const intervalHours = parseInterval(body.intervalHours, 'intervalHours', { integer: false, max: INTERVAL_HOURS_MAX }) ?? null;
      const intervalDays = parseInterval(body.intervalDays, 'intervalDays', { integer: true, max: INTERVAL_DAYS_MAX }) ?? null;
      if (intervalHours == null && intervalDays == null) throw new ValidationError('Set intervalHours and/or intervalDays');
      const notes = parseText(body.notes, 'notes', NOTES_MAX) ?? '';
      const lastDoneAt = parseLastDone(body.lastDoneAt) ?? null;
      id = maintenance.createTask({ deviceId, name, intervalHours, intervalDays, notes, lastDoneAt });
    } catch (err) {
      return sendError(res, err);
    }
    res.status(201).json(maintenance.getTask(id));
  });

  // POST /api/maintenance/:deviceId/templates — add the recommended task set (idempotent by name)
  router.post('/:deviceId/templates', (req, res) => {
    const deviceId = req.params.deviceId;
    if (!queries.getPrinter(deviceId)) return res.status(404).json({ error: 'Printer not found' });
    const added = maintenance.addDefaultTasks(deviceId);
    res.status(added ? 201 : 200).json({ added, tasks: maintenance.getTasks(deviceId) });
  });

  return router;
}

module.exports = { createMaintenanceRouter };
