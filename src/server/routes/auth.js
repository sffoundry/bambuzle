'use strict';

const express = require('express');
const { login, verifyLogin, getAuthStatus, clearAuth } = require('../../bambu/auth');
const { audit, auditThrottled } = require('../audit');

// Simple in-memory rate limiter for auth endpoints
const AUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map(); // ip -> [timestamps]

function checkAuthRate(req, res, action) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = (authAttempts.get(ip) || []).filter((t) => now - t < AUTH_WINDOW_MS);
  authAttempts.set(ip, attempts);
  if (attempts.length >= AUTH_MAX_ATTEMPTS) {
    auditThrottled(req, { action, result: 'rejected', detail: { reason: 'rate_limited', status: 429 } });
    res.status(429).json({ error: 'Too many attempts — try again later' });
    return false;
  }
  attempts.push(now);
  return true;
}

/**
 * Create auth router.
 * @param {object} callbacks
 * @param {function} callbacks.onAuthenticated — called with (auth) when login completes
 */
function createAuthRouter(callbacks) {
  const router = express.Router();

  // GET /api/auth/status — current auth state
  router.get('/status', (req, res) => {
    res.json({ status: getAuthStatus() });
  });

  // POST /api/auth/login — start login with email + password
  router.post('/login', async (req, res) => {
    if (!checkAuthRate(req, res, 'cloud.login')) return;
    const { email, password } = req.body;
    // Audit (BAM-41): the account email only — never the password or Bambu's error text (it can echo input)
    const detail = { email: typeof email === 'string' ? email.slice(0, 254) : null };
    if (!email || !password) {
      audit(req, { action: 'cloud.login', result: 'rejected', detail: { ...detail, reason: 'missing_fields' } });
      return res.status(400).json({ error: 'email and password are required' });
    }

    try {
      const result = await login(email, password);

      if (result.needsVerification) {
        audit(req, { action: 'cloud.login', result: 'ok', detail: { ...detail, stage: 'needs_verification' } });
        return res.json({
          status: 'needs_verification',
          message: 'A verification code has been sent to your email. Submit it to /api/auth/verify.',
        });
      }

      // Login succeeded directly — trigger printer discovery
      callbacks.onAuthenticated(result);
      audit(req, { action: 'cloud.login', result: 'ok', detail: { ...detail, stage: 'authenticated' } });
      res.json({ status: 'authenticated' });
    } catch (err) {
      audit(req, { action: 'cloud.login', result: 'error', detail: { ...detail, reason: 'login_failed' } });
      res.status(401).json({ error: err.message });
    }
  });

  // POST /api/auth/verify — complete login with emailed verification code
  router.post('/verify', async (req, res) => {
    if (!checkAuthRate(req, res, 'cloud.verify')) return;
    const { code } = req.body;
    if (!code) {
      audit(req, { action: 'cloud.verify', result: 'rejected', detail: { reason: 'missing_code' } });
      return res.status(400).json({ error: 'code is required' });
    }

    try {
      const auth = await verifyLogin(code);
      callbacks.onAuthenticated(auth);
      audit(req, { action: 'cloud.verify', result: 'ok' });
      res.json({ status: 'authenticated' });
    } catch (err) {
      audit(req, { action: 'cloud.verify', result: 'error', detail: { reason: 'verify_failed' } });
      res.status(401).json({ error: err.message });
    }
  });

  // POST /api/auth/logout — clear auth (does not disconnect existing MQTT yet)
  router.post('/logout', (req, res) => {
    clearAuth();
    callbacks.onLoggedOut?.();
    audit(req, { action: 'cloud.logout', result: 'ok' });
    res.json({ status: 'needs_login' });
  });

  return router;
}

module.exports = { createAuthRouter };
