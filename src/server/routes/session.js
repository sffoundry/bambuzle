'use strict';

const express = require('express');
const { audit, auditThrottled, actorFor } = require('../audit');

// Throttle admin-token guesses per IP
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> [timestamps]

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

  // GET /api/session — does this client need to enter the admin token?
  router.get('/', (req, res) => {
    res.json({
      required: adminAuth.enabled,
      authenticated: adminAuth.isAuthorized(req),
      publicRead: adminAuth.publicRead,
    });
  });

  // POST /api/session — exchange the admin token for a session cookie
  router.post('/', (req, res) => {
    if (!adminAuth.enabled) return res.json({ authenticated: true });
    const ip = req.ip || req.socket.remoteAddress;
    if (recentFailures(ip).length >= MAX_ATTEMPTS) {
      // Throttled: a locked-out guesser keeps hammering, the trail gets one row a minute (BAM-41)
      auditThrottled(req, { action: 'session.rate_limited', result: 'rejected', actor: 'anonymous', detail: { status: 429 } });
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }
    if (!adminAuth.checkToken(req.body?.token)) {
      recordFailure(ip); // only failures count, so legitimate sign-ins never lock anyone out
      audit(req, { action: 'session.login', result: 'denied', actor: 'anonymous', detail: { reason: 'invalid_token' } });
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    res.setHeader('Set-Cookie', adminAuth.sessionCookie(req));
    audit(req, { action: 'session.login', result: 'ok', actor: 'admin-token' });
    res.json({ authenticated: true });
  });

  // DELETE /api/session — sign this browser out
  router.delete('/', (req, res) => {
    // Only a signed-in client's sign-out is worth a row; anonymous DELETEs (unguarded route) would just be noise
    const actor = actorFor(req, adminAuth);
    if (actor !== 'anonymous') audit(req, { action: 'session.logout', result: 'ok', actor });
    res.setHeader('Set-Cookie', adminAuth.clearCookie());
    res.json({ authenticated: false });
  });

  return router;
}

module.exports = { createSessionRouter };
