'use strict';

// Operator audit helper (BAM-41). Routes call `audit(req, { action, target, result, detail })` for every
// security-relevant or state-changing operator action — deliberately NOT a blanket middleware, so reads
// never flood the trail. New state-changing routes must call it (see CLAUDE.md).
//
// Actor: with the single shared admin token (BAM-30) there is no per-user identity, so `actor` is the
// credential that authorised the request — 'admin-token' (Bearer), 'session' (cookie) or 'anonymous'.
// `attachAuditActor` sets `req.auditActor` right after the /api guard; BAM-16 per-user accounts can set
// it to e.g. `user:<id>` instead and every call site picks that up unchanged.
//
// `detail` must never contain secrets: pass field names / booleans (`{ accessCodeChanged: true }`),
// never values of access codes, passwords, verification codes, tokens or notifier config.

const crypto = require('crypto');
const { insertAudit } = require('../db/audit');

const DENIAL_THROTTLE_MS = 60 * 1000;
const THROTTLE_MAX_KEYS = 5000;
const lastDenial = new Map(); // `${ip}|${action}` -> { at, suppressed }

function sourceIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

/** Stable per-request id (also returned as X-Request-Id so an operator can correlate a client error). */
function requestId(req) {
  if (!req.auditRequestId) {
    req.auditRequestId = crypto.randomUUID();
    if (req.res && !req.res.headersSent) req.res.setHeader('X-Request-Id', req.auditRequestId);
  }
  return req.auditRequestId;
}

/**
 * Which credential authorised this request. Validates rather than trusting header presence, so a stale
 * bearer header next to a valid cookie is attributed to the cookie.
 */
function actorFor(req, adminAuth) {
  if (!adminAuth || !adminAuth.enabled) return 'anonymous';
  // BAM-16: 'admin-token' (Bearer), 'session' (token sign-in) or the signed-in username
  const p = adminAuth.getPrincipal ? adminAuth.getPrincipal(req) : null;
  if (p) return p.kind === 'user' ? `user:${p.name}` : p.name;
  return 'anonymous';
}

/** Middleware mounted after the /api admin guard: records who the request is acting as. */
function attachAuditActor(adminAuth) {
  return (req, res, next) => {
    if (!req.auditActor) req.auditActor = actorFor(req, adminAuth);
    next();
  };
}

/**
 * Append an audit row for this request. Never throws — auditing must not break the action itself.
 * @param {import('express').Request} req
 * @param {object} entry
 * @param {string} entry.action — dotted name, category first: 'session.login', 'printer.command', …
 * @param {'ok'|'denied'|'error'|'rejected'} entry.result
 * @param {string} [entry.target] — e.g. 'printer:<serial>', 'alert:12'
 * @param {object} [entry.detail] — small, secret-free JSON
 * @param {string} [entry.actor] — override (e.g. sign-in routes mounted before the guard)
 */
function audit(req, { action, result, target, detail, actor } = {}) {
  try {
    insertAudit({
      action,
      result,
      target,
      detail,
      actor: actor || req.auditActor || 'anonymous',
      sourceIp: sourceIp(req),
      userAgent: req.headers?.['user-agent'],
      requestId: requestId(req),
    });
  } catch (err) {
    req.log?.warn?.({ err: err.message, action }, 'audit write failed');
  }
}

/**
 * Like audit(), but records at most one row per source IP + action per minute, so a scanner hammering
 * a guarded endpoint can't flood the table. The next row that gets through carries `suppressed: <n>`.
 * @returns {boolean} whether a row was written
 */
function auditThrottled(req, entry, now = Date.now()) {
  const key = `${sourceIp(req)}|${entry.action}`;
  const prev = lastDenial.get(key);
  if (prev && now - prev.at < DENIAL_THROTTLE_MS) {
    prev.suppressed++;
    return false;
  }
  if (lastDenial.size >= THROTTLE_MAX_KEYS) {
    for (const [k, v] of lastDenial) if (now - v.at >= DENIAL_THROTTLE_MS) lastDenial.delete(k);
    if (lastDenial.size >= THROTTLE_MAX_KEYS) lastDenial.clear();
  }
  const suppressed = prev ? prev.suppressed : 0;
  lastDenial.set(key, { at: now, suppressed: 0 });
  audit(req, suppressed ? { ...entry, detail: { ...entry.detail, suppressed } } : entry);
  return true;
}

/** Tests only. */
function resetAuditThrottle() {
  lastDenial.clear();
}

module.exports = { audit, auditThrottled, attachAuditActor, actorFor, resetAuditThrottle, DENIAL_THROTTLE_MS };
