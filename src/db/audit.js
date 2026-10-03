'use strict';

// Operator audit trail (BAM-41). Self-contained table (created on first use, like ams-humidity) so it
// stays out of the main migration list.
//
// APPEND-ONLY from the app: this module deliberately exports no update or delete-by-id function. The
// only way rows leave the table is retention pruning (`deleteOldAudit`, run by the daily cleanup cron
// with its own `audit.retentionDays`, separate from telemetry retention).
//
// Writers go through src/server/audit.js (`audit(req, {...})`), which derives actor / source IP / user
// agent from the request. `detail` is a small JSON object and must NEVER carry secrets (access codes,
// passwords, verification codes, tokens, notifier config) — callers pass field names / booleans instead.

const { getDb } = require('./database');

const RESULTS = ['ok', 'denied', 'error', 'rejected'];
const ACTORS = ['admin-token', 'session', 'anonymous']; // BAM-16 per-user accounts will add `user:<id>`
const USER_AGENT_MAX = 200;
const TARGET_MAX = 200;
const ACTION_MAX = 64;
const DETAIL_MAX = 4000;

let ensuredFor = null; // the db handle the table was ensured on (tests close/reopen)

function db() {
  const d = getDb();
  if (ensuredFor !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        actor TEXT NOT NULL DEFAULT 'anonymous',
        source_ip TEXT,
        user_agent TEXT,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT NOT NULL,
        detail TEXT,
        request_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action_ts ON audit_log(action, ts);
    `);
    ensuredFor = d;
  }
  return d;
}

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Normalise a Date / ISO string to the stored form (ISO 8601 UTC with ms, e.g. 2026-10-03T12:00:00.000Z). */
function toStoredTs(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('invalid timestamp');
  return d.toISOString();
}

/**
 * Append one audit row.
 * @param {object} entry
 * @param {string} entry.action — dotted, e.g. 'session.login', 'printer.command'
 * @param {string} entry.result — one of RESULTS
 * @param {string} [entry.actor]
 * @param {string} [entry.sourceIp]
 * @param {string} [entry.userAgent] — truncated to 200 chars
 * @param {string} [entry.target]
 * @param {object} [entry.detail] — JSON-serialisable, no secrets
 * @param {string} [entry.requestId]
 * @param {Date|string} [entry.ts] — defaults to now (tests backdate rows)
 * @returns {number} row id
 */
function insertAudit({ action, result, actor = 'anonymous', sourceIp, userAgent, target, detail, requestId, ts }) {
  if (typeof action !== 'string' || !action) throw new Error('action is required');
  if (!RESULTS.includes(result)) throw new Error(`result must be one of ${RESULTS.join(', ')}`);
  let detailJson = null;
  if (detail !== undefined && detail !== null) {
    detailJson = JSON.stringify(detail);
    if (detailJson.length > DETAIL_MAX) detailJson = JSON.stringify({ truncated: true });
  }
  const info = db().prepare(`
    INSERT INTO audit_log (ts, actor, source_ip, user_agent, action, target, result, detail, request_id)
    VALUES (COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ts ? toStoredTs(ts) : null,
    clip(actor, 64) || 'anonymous',
    clip(sourceIp, 64),
    clip(userAgent, USER_AGENT_MAX),
    clip(action, ACTION_MAX),
    clip(target, TARGET_MAX),
    result,
    detailJson,
    clip(requestId, 64),
  );
  return Number(info.lastInsertRowid);
}

function parseDetail(row) {
  if (!row.detail) return { ...row, detail: null };
  try {
    return { ...row, detail: JSON.parse(row.detail) };
  } catch {
    return row;
  }
}

/**
 * Query the trail, newest first.
 * @param {object} [q]
 * @param {Date|string} [q.from] — inclusive
 * @param {Date|string} [q.to] — inclusive
 * @param {string} [q.action] — exact action ('printer.command') or a category prefix ('printer' → printer.*)
 * @param {string} [q.result]
 * @param {number} [q.limit]
 * @param {boolean} [q.rawDetail] — keep `detail` as the stored JSON string (CSV export)
 */
function queryAudit({ from, to, action, result, limit = 500, rawDetail = false } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('ts >= ?'); params.push(toStoredTs(from)); }
  if (to) { where.push('ts <= ?'); params.push(toStoredTs(to)); }
  if (action) {
    where.push("(action = ? OR action LIKE ? ESCAPE '\\')");
    params.push(action, `${action.replace(/[\\%_]/g, '\\$&')}.%`);
  }
  if (result) { where.push('result = ?'); params.push(result); }
  const rows = db().prepare(`
    SELECT id, ts, actor, source_ip, user_agent, action, target, result, detail, request_id
    FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts DESC, id DESC LIMIT ?
  `).all(...params, limit);
  return rawDetail ? rows : rows.map(parseDetail);
}

/** Retention pruning — the ONLY delete path. @returns {{changes:number}} */
function deleteOldAudit(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) return { changes: 0 }; // 0 / garbage = keep forever
  const cutoff = new Date(Date.now() - n * 86400e3).toISOString();
  return db().prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
}

module.exports = { RESULTS, ACTORS, USER_AGENT_MAX, insertAudit, queryAudit, deleteOldAudit };
