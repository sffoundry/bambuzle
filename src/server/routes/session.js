'use strict';

const express = require('express');
const { audit, auditThrottled, actorFor } = require('../audit');
const users = require('../../db/users');

const { createLimiter } = require('../login-limiter');
const { revalidateClients } = require('../websocket');

// Failed sign-ins are limited per IP and per username. The per-username limit stops guesses spread
// over many IPs, but it would also let anyone lock a real user out; so a client IP that has already
// signed in successfully as that user (in the last 30 days) is exempt from that user's lock.
const limiter = createLimiter({ max: 10 });
const KNOWN_GOOD_MS = 30 * 86400e3;
const knownGood = new Map(); // `<ip>|<username_lc>` -> last success ms

function isKnownGood(ip, nameLc) {
  const t = knownGood.get(`${ip}|${nameLc}`);
  return Boolean(t && Date.now() - t < KNOWN_GOOD_MS);
}

function rememberGood(ip, nameLc) {
  knownGood.set(`${ip}|${nameLc}`, Date.now());
  if (knownGood.size > 5000) {
    const now = Date.now();
    for (const [k, t] of knownGood) if (now - t >= KNOWN_GOOD_MS) knownGood.delete(k);
    if (knownGood.size > 5000) knownGood.delete(knownGood.keys().next().value);
  }
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
    if (adminAuth.crossOriginWrite(req)) return res.status(403).json({ error: 'cross_origin_write_rejected' }); // login CSRF
    if (!adminAuth.enabled) return res.json({ authenticated: true });
    const ip = req.ip || req.socket.remoteAddress;
    const { token, username, password } = req.body || {};
    const nameLc = typeof username === 'string' ? username.toLowerCase().slice(0, 64) : null;
    const userKey = nameLc && !isKnownGood(ip, nameLc) ? `user:${nameLc}` : null;
    if (limiter.blocked(`ip:${ip}`, userKey)) {
      // Throttled: a locked-out guesser keeps hammering, the trail gets one row a minute (BAM-41)
      auditThrottled(req, { action: 'session.rate_limited', result: 'rejected', actor: 'anonymous', detail: { status: 429 } });
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    if (username !== undefined || password !== undefined) {
      // Count the attempt before the (slow) password check so parallel guesses can't all get through
      const release = limiter.reserve(`ip:${ip}`, nameLc ? `user:${nameLc}` : null);
      let user = null;
      try {
        user = await users.authenticate(username, password);
      } catch {
        user = null;
      }
      if (!user) {
        // Only record a name that exists — a password typed into the username box must not land in the trail
        audit(req, { action: 'session.login', result: 'denied', actor: 'anonymous',
          detail: { reason: 'invalid_credentials', ...(users.usernameExists(username) ? { username: username.slice(0, 32) } : {}) } });
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      release();
      rememberGood(ip, nameLc);
      const s = users.createSession(user.id);
      res.setHeader('Set-Cookie', adminAuth.userSessionCookie(req, s.token, s.maxAgeSec));
      audit(req, { action: 'session.login', result: 'ok', actor: `user:${user.username}`, detail: { role: user.role } });
      return res.json({ authenticated: true, user: { name: user.username, role: user.role, kind: 'user' } });
    }

    if (!adminAuth.checkToken(token)) {
      limiter.reserve(`ip:${ip}`); // only failures count, so legitimate sign-ins never lock anyone out
      audit(req, { action: 'session.login', result: 'denied', actor: 'anonymous', detail: { reason: 'invalid_token' } });
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    res.setHeader('Set-Cookie', adminAuth.sessionCookie(req));
    audit(req, { action: 'session.login', result: 'ok', actor: 'admin-token' });
    res.json({ authenticated: true, user: { name: 'session', role: 'admin', kind: 'token-session' } });
  });

  // DELETE /api/session — sign this browser out
  router.delete('/', (req, res) => {
    if (adminAuth.crossOriginWrite(req)) return res.status(403).json({ error: 'cross_origin_write_rejected' }); // forced sign-out
    // Only a signed-in client's sign-out is worth a row; anonymous DELETEs (unguarded route) would just be noise
    const actor = actorFor(req, adminAuth);
    if (actor !== 'anonymous') audit(req, { action: 'session.logout', result: 'ok', actor });
    users.deleteSession(adminAuth.userSessionToken(req)); // revoke server-side, not just the cookie (BAM-16)
    res.setHeader('Set-Cookie', adminAuth.clearCookie());
    revalidateClients();
    res.json({ authenticated: false });
  });

  return router;
}

module.exports = { createSessionRouter, _resetForTests: () => { limiter.reset(); knownGood.clear(); } };
