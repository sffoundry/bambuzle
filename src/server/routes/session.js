'use strict';

const express = require('express');

// Throttle admin-token guesses per IP
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> [timestamps]

function allowAttempt(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, recent);
  if (recent.length >= MAX_ATTEMPTS) return false;
  recent.push(now);
  return true;
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
    if (!allowAttempt(req.ip || req.socket.remoteAddress)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }
    if (!adminAuth.checkToken(req.body?.token)) {
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    res.setHeader('Set-Cookie', adminAuth.sessionCookie(req));
    res.json({ authenticated: true });
  });

  // DELETE /api/session — sign this browser out
  router.delete('/', (req, res) => {
    res.setHeader('Set-Cookie', adminAuth.clearCookie());
    res.json({ authenticated: false });
  });

  return router;
}

module.exports = { createSessionRouter };
