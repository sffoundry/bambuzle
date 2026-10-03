'use strict';

// Operator audit trail API (BAM-41). Mounted at /api/audit behind the admin guard, and listed in
// admin-auth `isPrivateRead`, so it stays private even with BAMBUZLE_PUBLIC_READ=true.

const express = require('express');
const { clampLimit, parseIsoParam } = require('./api');
const { toCsv } = require('./export');
const { queryAudit, RESULTS } = require('../../db/audit');

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const EXPORT_MAX_ROWS = 50000;
const ACTION_RE = /^[a-z][a-z_]*(?:\.[a-z_]+)*$/;
const CSV_COLUMNS = ['id', 'ts', 'actor', 'source_ip', 'user_agent', 'action', 'target', 'result', 'detail', 'request_id'];

class BadRequest extends Error {}

/** Shared filter parsing for the list and the export. */
function parseFilters(query) {
  let from;
  let to;
  try {
    from = parseIsoParam(query.from);
    to = parseIsoParam(query.to, { endOfDay: true });
  } catch {
    throw new BadRequest('from/to must be ISO 8601 dates (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)');
  }
  if (!to) to = new Date();
  if (!from) from = new Date(to.getTime() - DEFAULT_DAYS * 86400e3);
  if (from > to) throw new BadRequest('from must be before to');
  const { action, result } = query;
  if (action !== undefined && action !== '' && (typeof action !== 'string' || action.length > 64 || !ACTION_RE.test(action))) {
    throw new BadRequest('action must be an action name (e.g. printer.command) or category (e.g. printer)');
  }
  if (result !== undefined && result !== '' && !RESULTS.includes(result)) {
    throw new BadRequest(`result must be one of ${RESULTS.join(', ')}`);
  }
  return { from, to, action: action || undefined, result: result || undefined };
}

function createAuditRouter() {
  const router = express.Router();

  // GET /api/audit?from&to&action&result&limit — newest first; default last 30 days
  router.get('/', (req, res) => {
    let filters;
    try {
      filters = parseFilters(req.query);
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
    const limit = clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const entries = queryAudit({ ...filters, limit });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      window: { from: filters.from.toISOString(), to: filters.to.toISOString() },
      filters: { action: filters.action || null, result: filters.result || null },
      limit,
      truncated: entries.length >= limit,
      entries,
    });
  });

  // GET /api/audit/export?format=csv&from&to&action&result — CSV download (formula-injection guarded)
  router.get('/export', (req, res) => {
    const format = req.query.format === undefined ? 'csv' : req.query.format;
    if (format !== 'csv') return res.status(400).json({ error: 'format must be csv' });
    let filters;
    try {
      filters = parseFilters(req.query);
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      throw err;
    }
    const rows = queryAudit({ ...filters, limit: EXPORT_MAX_ROWS + 1, rawDetail: true });
    const truncated = rows.length > EXPORT_MAX_ROWS;
    if (truncated) rows.length = EXPORT_MAX_ROWS;
    const day = (d) => d.toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="bambuzle-audit-${day(filters.from)}-${day(filters.to)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) res.setHeader('X-Bambuzle-Truncated', 'true');
    res.type('text/csv; charset=utf-8');
    res.send(toCsv(rows, CSV_COLUMNS));
  });

  return router;
}

module.exports = { createAuditRouter };
