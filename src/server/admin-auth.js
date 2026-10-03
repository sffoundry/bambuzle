'use strict';

// Dashboard requester authentication (BAM-30 — interim single shared admin token).
//
// This is distinct from src/bambu/auth.js, which is the *server's* Bambu Cloud session.
// Before BAM-30 any LAN client could stop prints, re-point the cloud login, or add
// webhook rules; now every /api route and the WebSocket require the admin token unless
// auth is explicitly disabled.
//
// Token resolution: BAMBUZLE_ADMIN_TOKEN env → <dataDir>/admin-token file → generated on
// first start (written 0600 and logged once). Browsers get a stateless session cookie
// derived from the token, so rotating the token revokes every session.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { auditThrottled } = require('./audit');
const { requiredRole, hasRole } = require('./permissions');
const users = require('../db/users');

const COOKIE_NAME = 'bambuzle_session';
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const TOKEN_FILE = 'admin-token';

function sessionValueFor(token) {
  return crypto.createHmac('sha256', token).update('bambuzle-session-v1').digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      // Malformed escape in someone else's cookie (cookies are shared across ports) — keep raw, never throw
      out[part.slice(0, idx).trim()] = raw;
    }
  }
  return out;
}

function resolveToken(authConfig, dataDir, log) {
  if (authConfig.adminToken) return authConfig.adminToken;

  const tokenPath = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) {
      log.info({ tokenPath }, 'Dashboard admin token loaded from data dir');
      return existing;
    }
  } catch {
    // Not created yet
  }

  const token = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  log.warn({ tokenPath, token }, 'Generated dashboard admin token (first start) — enter it in the dashboard; set BAMBUZLE_ADMIN_TOKEN to override');
  return token;
}

/**
 * @param {object} opts
 * @param {object} opts.auth — config.auth: { mode: 'on'|'off', adminToken, publicRead }
 * @param {string} opts.dataDir
 * @param {object} opts.log — pino logger
 */
function createAdminAuth({ auth, dataDir, log }) {
  const enabled = auth.mode !== 'off';
  const publicRead = Boolean(auth.publicRead);
  const token = enabled ? resolveToken(auth, dataDir, log) : null;
  const sessionValue = token ? sessionValueFor(token) : null;

  if (!enabled) {
    log.warn('Dashboard auth DISABLED (BAMBUZLE_AUTH=off) — any client that can reach this server can control printers');
  }

  /**
   * Who is making this request (BAM-16). Resolved once per request and cached on req.
   *   { kind: 'none'|'token'|'token-session'|'user', role, name, userId? } or null (not signed in).
   * - auth off → acts as admin ('none')
   * - Bearer admin token → admin ('token'); the token-derived cookie → admin ('token-session')
   * - user session cookie ('u.<token>') → that user's role
   */
  function getPrincipal(req) {
    if (req._principal !== undefined) return req._principal;
    let p = null;
    if (!enabled) {
      p = { kind: 'none', role: 'admin', name: 'anonymous' };
    } else {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (bearer && safeEqual(bearer[1], token)) p = { kind: 'token', role: 'admin', name: 'admin-token' };
      else if (cookie && cookie.startsWith('u.')) {
        const u = users.sessionUser(cookie.slice(2));
        if (u) p = { kind: 'user', role: u.role, name: u.username, userId: u.id };
      } else if (cookie && safeEqual(cookie, sessionValue)) p = { kind: 'token-session', role: 'admin', name: 'session' };
    }
    req._principal = p;
    return p;
  }

  /** True if the request carries any valid credential (token, token session or user session). */
  function isAuthorized(req) {
    return Boolean(getPrincipal(req));
  }

  function isReadOnly(req) {
    return req.method === 'GET' || req.method === 'HEAD';
  }

  /**
   * GETs that stay private even with publicRead: alert rules hold notifier secrets (bot tokens,
   * webhook URLs), /system exposes paths, and debug/mqtt dumps the raw payload (camera URLs).
   * Express routing is case-insensitive, so compare lowercased.
   */
  function isPrivateRead(req) {
    const p = (req.baseUrl + req.path).toLowerCase();
    return p.startsWith('/api/alerts') || p.startsWith('/api/system') || p.startsWith('/api/audit') || p.includes('/debug/') || /^\/api\/printers\/[^/]+\/files/.test(p);
  }

  /**
   * Same-site CSRF guard for cookie-authenticated writes: SameSite=Strict does not separate other
   * ports on the same host, so a browser write must carry an Origin matching this Host.
   * Bearer-token clients and requests without Origin (curl, scripts) are unaffected.
   */
  function crossOriginWrite(req) {
    if (isReadOnly(req) || (enabled && /^Bearer\s/i.test(req.headers.authorization || ''))) return false;
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }

  /** BAM-41: audit a refused mutating request (throttled per IP + action; reads are never audited). */
  function auditDenial(req, action, status) {
    const credential = /^Bearer\s/i.test(req.headers.authorization || '') ? 'bearer'
      : (parseCookies(req.headers.cookie)[COOKIE_NAME] ? 'cookie' : 'none');
    auditThrottled(req, {
      action,
      result: 'denied',
      actor: 'anonymous',
      target: (req.baseUrl + req.path).slice(0, 200),
      detail: { status, method: req.method, credential },
    });
  }

  /** Express middleware guarding /api. */
  function requireAdmin(req, res, next) {
    // Same-host cross-origin writes are refused even with auth off (review 2, #8)
    if (crossOriginWrite(req)) {
      auditDenial(req, 'access.cross_origin', 403);
      return res.status(403).json({ error: 'cross_origin_write_rejected' });
    }
    const needed = requiredRole(req.method, req.baseUrl + req.path);
    const principal = getPrincipal(req);
    if (principal) {
      if (hasRole(principal.role, needed)) return next();
      // Signed in but not allowed (BAM-16): 403, always audited (throttled)
      // Same actor format as audit.actorFor: users are 'user:<name>' so a username can't impersonate 'admin-token'
      auditThrottled(req, { action: 'access.forbidden', result: 'denied', actor: principal.kind === 'user' ? `user:${principal.name}` : principal.name,
        target: (req.baseUrl + req.path).slice(0, 200), detail: { method: req.method, role: principal.role, required: needed } });
      return res.status(403).json({ error: 'forbidden', required: needed });
    }
    // Anonymous public read: only what a viewer may read (admin/operator-only reads stay private)
    if (publicRead && isReadOnly(req) && needed === 'viewer' && !isPrivateRead(req)) return next();
    if (!isReadOnly(req)) auditDenial(req, 'access.denied', 401);
    res.status(401).json({ error: 'admin_auth_required' });
  }

  /** ws `verifyClient` hook — the dashboard WebSocket is read-only telemetry. */
  function verifyWsRequest(req) {
    return isAuthorized(req) || publicRead;
  }

  function checkToken(candidate) {
    return enabled && typeof candidate === 'string' && safeEqual(candidate, token);
  }

  function sessionCookie(req) {
    const secure = req.secure ? '; Secure' : '';
    return `${COOKIE_NAME}=${sessionValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`;
  }

  /** Cookie for a per-user session (BAM-16). The value is 'u.' + an opaque random token. */
  function userSessionCookie(req, sessionToken, maxAgeSec) {
    const secure = req.secure ? '; Secure' : '';
    return `${COOKIE_NAME}=u.${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  }

  /** The raw user-session token from this request's cookie, if any (for sign-out / password change). */
  function userSessionToken(req) {
    const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return c && c.startsWith('u.') ? c.slice(2) : null;
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  return { enabled, publicRead, trustProxy: auth.trustProxy || '', isAuthorized, getPrincipal, requireAdmin, verifyWsRequest, checkToken, sessionCookie, userSessionCookie, userSessionToken, clearCookie };
}

module.exports = { createAdminAuth, COOKIE_NAME };
