'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const YAML = require('js-yaml');
const { createApiRouter } = require('./routes/api');
const { createAlertsRouter } = require('./routes/alerts');
const { createAuthRouter } = require('./routes/auth');
const { createSessionRouter } = require('./routes/session');
const { createHealthRouter, createSystemRouter } = require('./routes/system');
const { createMetricsRouter } = require('./routes/metrics');
const { getAuthStatus } = require('../bambu/auth');
const config = require('../config');

/**
 * @param {object} printerManager
 * @param {object} authCallbacks — { onAuthenticated(auth) }
 * @param {object} adminAuth — dashboard requester auth from createAdminAuth()
 * @param {object} [deps] — optional extras (BAM-34)
 * @param {object|null} [deps.backupService] — from createBackupService(); null disables backup endpoints
 * @param {function} [deps.getCloudAuthStatus] — returns the Bambu Cloud auth state string
 * @param {string} [deps.dataDir]
 */
function createApp(printerManager, authCallbacks, adminAuth, deps = {}) {
  const {
    backupService = null,
    getCloudAuthStatus = getAuthStatus,
    dataDir = config.dataDir,
  } = deps;
  const app = express();

  // Reverse proxy support (review finding 8): real client IP for throttling, Secure cookie over TLS
  const trustProxy = adminAuth.trustProxy;
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);

  app.use(express.json());

  // CSP relaxed for /api/docs (Swagger UI needs inline scripts)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/docs') || req.path.startsWith('/api-docs')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
      return next();
    }
    next();
  });

  // Liveness/readiness probes — public, before static files and the /api guard
  app.use(createHealthRouter(printerManager, { backupService, getCloudAuthStatus }));
  // Prometheus scrape endpoint (BAM-37) — checks the admin token itself (not under /api)
  app.use(createMetricsRouter({ printerManager, adminAuth, backupService, getCloudAuthStatus, dataDir }));

  // Static files
  app.use(express.static(path.resolve(__dirname, '..', '..', 'public')));

  // API Documentation (Swagger UI)
  const openapiSpec = YAML.load(fs.readFileSync(path.resolve(__dirname, '..', '..', 'openapi.yaml'), 'utf8'));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Bambuzle API Documentation',
  }));
  app.get('/api/spec', (req, res) => res.json(openapiSpec));

  // Dashboard session (token entry) is reachable without a session; everything else under /api is guarded
  app.use('/api/session', createSessionRouter(adminAuth));
  app.use('/api', adminAuth.requireAdmin);

  // API routes
  app.use('/api/auth', createAuthRouter(authCallbacks));
  app.use('/api', createApiRouter(printerManager, { getCloudAuthStatus }));
  app.use('/api/alerts', createAlertsRouter());
  app.use('/api/system', createSystemRouter({ backupService, dataDir }));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'index.html'));
  });

  return app;
}

module.exports = { createApp };
