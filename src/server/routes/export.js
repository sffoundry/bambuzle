'use strict';

// GET /api/export/jobs — print history download as CSV or JSON (BAM-46).
// Mounted under the /api admin guard. Column reference: docs/export-data-dictionary.md.

const express = require('express');
const { parseIsoParam } = require('./api');
const {
  getJobExportRows, EXPORT_COLUMNS, EXPORT_SCHEMA_VERSION, EXPORT_MAX_ROWS,
} = require('../../db/export');

const UTF8_BOM = '﻿';
// Cells starting with these are interpreted as formulas by Excel / LibreOffice / Sheets.
const FORMULA_START_RE = /^[=+\-@\t\r]/;
const CSV_NEEDS_QUOTES_RE = /[",\r\n]/;

/**
 * Encode one CSV cell (RFC 4180). Only strings are formula-guarded: numeric columns are
 * emitted as numbers, so a negative value stays a number.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (FORMULA_START_RE.test(s)) s = `'${s}`;
  return CSV_NEEDS_QUOTES_RE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the CSV body: BOM, header row, CRLF line endings. */
function toCsv(rows) {
  const names = EXPORT_COLUMNS.map((c) => c.name);
  const lines = [names.join(',')];
  for (const row of rows) lines.push(names.map((n) => csvCell(row[n])).join(','));
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/** SQLite datetime() form: 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toSqlDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** ISO 8601 UTC without milliseconds. */
function toIsoZ(d) {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxRows] — row cap (default 50,000; injectable for tests)
 */
function createExportRouter({ maxRows = EXPORT_MAX_ROWS } = {}) {
  const router = express.Router();

  router.get('/jobs', (req, res) => {
    const format = req.query.format === undefined ? 'csv' : req.query.format;
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ error: 'format must be csv or json' });
    }
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
    // Default window: all time (no lower bound) up to now.
    if (!to) to = new Date();
    if (from && from > to) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    const { rows, truncated } = getJobExportRows({
      deviceId: printer || undefined,
      from: from ? toSqlDatetime(from) : undefined,
      to: toSqlDatetime(to),
      maxRows,
    });

    const fromTag = from ? toIsoZ(from).slice(0, 10) : 'all';
    const filename = `bambuzle-jobs-${fromTag}-${toIsoZ(to).slice(0, 10)}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Bambuzle-Export-Schema', String(EXPORT_SCHEMA_VERSION));
    if (truncated) res.setHeader('X-Bambuzle-Truncated', 'true');

    if (format === 'json') {
      return res.json({
        schema_version: EXPORT_SCHEMA_VERSION,
        generated_at: toIsoZ(new Date()),
        window: { from: from ? toIsoZ(from) : null, to: toIsoZ(to), printer: printer || null },
        truncated,
        max_rows: maxRows,
        columns: EXPORT_COLUMNS,
        jobs: rows,
      });
    }
    res.type('text/csv; charset=utf-8');
    return res.send(toCsv(rows));
  });

  return router;
}

module.exports = { createExportRouter, csvCell, toCsv };
