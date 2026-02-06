'use strict';

const express = require('express');
const { login, verifyLogin, getAuthStatus, clearAuth } = require('../../bambu/auth');

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
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    try {
      const result = await login(email, password);

      if (result.needsVerification) {
        return res.json({
          status: 'needs_verification',
          message: 'A verification code has been sent to your email. Submit it to /api/auth/verify.',
        });
      }

      // Login succeeded directly — trigger printer discovery
      callbacks.onAuthenticated(result);
      res.json({ status: 'authenticated' });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  // POST /api/auth/verify — complete login with emailed verification code
  router.post('/verify', async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    try {
      const auth = await verifyLogin(code);
      callbacks.onAuthenticated(auth);
      res.json({ status: 'authenticated' });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  // POST /api/auth/logout — clear auth (does not disconnect existing MQTT yet)
  router.post('/logout', (req, res) => {
    clearAuth();
    res.json({ status: 'needs_login' });
  });

  return router;
}

module.exports = { createAuthRouter };
