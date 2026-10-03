'use strict';

const express = require('express');
const { audit, auditThrottled, actorFor } = require('../audit');
const users = require('../../db/users');

// Throttle admin-token guesses per IP
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // `ip:<ip>` / `user:<name>` -> [timestamps]

function recentFailures(ip, now = Date.now()) {
  const recent = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length) attempts.set(ip, recent);
  else attempts.delete(ip);
  return recent;
}

function recordFailure(ip) {
  const now = Date.now();
  attempts.set(ip, [...recentFailures(ip, now), now]);
  // Bound memory: drop idle entries when the map grows
  if (attempts.size > 1000) for (const key of attempts.keys()) recentFailures(key, now);
}

/**
 * Dashboard session endpoints (BAM-30). Mounted outside the /api admin guard.
 * @param {object} adminAuth — from createAdminAuth()
 */
function createSessionRouter(adminAuth) {
  const router = express.Router();

  // GET /api/session — sign-in state, mode and (BAM-16) who you are
  router.get('/', (req, res) => {
    const p = adminAuth.getPrincipal(req);
    res.json({
      required: adminAuth.enabled,
      authenticated: Boolean(p),
      publicRead: adminAuth.publicRead,
      // 'users' once at least one account exists: the sign-in form asks for username + password
      mode: adminAuth.enabled && users.countUsers() > 0 ? 'users' : 'token',
      user: p ? { name: p.name, role: p.role, kind: p.kind } : null,
    });
  });

  // POST /api/session — sign in with { token } (admin token) or { username, password } (BAM-16)
  router.post('/', async (req, res) => {
    if (!adminAuth.enabled) return res.json({ authenticated: true });
    const ip = req.ip || req.socket.remoteAddress;
    const { token, username, password } = req.body || {};
    const userKey = typeof username === 'string' ? `user:${username.toLowerCase().slice(0, 64)}` : null;
    if (recentFailures(`ip:${ip}`).length >= MAX_ATTEMPTS || (userKey && recentFailures(userKey).length >= MAX_ATTEMPTS)) {
      // Throttled: a locked-out guesser keeps hammering, the trail gets one row a minute (BAM-41)
      auditThrottled(req, { action: 'session.rate_limited', result: 'rejected', actor: 'anonymous', detail: { status: 429 } });
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    if (username !== undefined || password !== undefined) {
      let user = null;
      try {
        user = await users.authenticate(username, password);
      } catch {
        user = null;
      }
      if (!user) {
        recordFailure(`ip:${ip}`);
        if (userKey) recordFailure(userKey); // per-account limit too: spreading guesses over IPs doesn't help
        audit(req, { action: 'session.login', result: 'denied', actor: 'anonymous', detail: { reason: 'invalid_credentials', username: String(username || '').slice(0, 32) } });
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const s = users.createSession(user.id);
      res.setHeader('Set-Cookie', adminAuth.userSessionCookie(req, s.token, s.maxAgeSec));
      audit(req, { action: 'session.login', result: 'ok', actor: `user:${user.username}`, detail: { role: user.role } });
      return res.json({ authenticated: true, user: { name: user.username, role: user.role, kind: 'user' } });
    }

    if (!adminAuth.checkToken(token)) {
      recordFailure(`ip:${ip}`); // only failures count, so legitimate sign-ins never lock anyone out
      audit(req, { action: 'session.login', result: 'denied', actor: 'anonymous', detail: { reason: 'invalid_token' } });
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    res.setHeader('Set-Cookie', adminAuth.sessionCookie(req));
    audit(req, { action: 'session.login', result: 'ok', actor: 'admin-token' });
    res.json({ authenticated: true, user: { name: 'session', role: 'admin', kind: 'token-session' } });
  });

  // DELETE /api/session — sign this browser out
  router.delete('/', (req, res) => {
    // Only a signed-in client's sign-out is worth a row; anonymous DELETEs (unguarded route) would just be noise
    const actor = actorFor(req, adminAuth);
    if (actor !== 'anonymous') audit(req, { action: 'session.logout', result: 'ok', actor });
    users.deleteSession(adminAuth.userSessionToken(req)); // revoke server-side, not just the cookie (BAM-16)
    res.setHeader('Set-Cookie', adminAuth.clearCookie());
    res.json({ authenticated: false });
  });

  return router;
}

module.exports = { createSessionRouter };
