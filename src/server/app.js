'use strict';

const express = require('express');
const path = require('path');
const { createApiRouter } = require('./routes/api');
const { createAlertsRouter } = require('./routes/alerts');
const { createAuthRouter } = require('./routes/auth');

/**
 * @param {object} printerManager
 * @param {object} authCallbacks — { onAuthenticated(auth) }
 */
function createApp(printerManager, authCallbacks) {
  const app = express();

  app.use(express.json());

  // Static files
  app.use(express.static(path.resolve(__dirname, '..', '..', 'public')));

  // API routes
  app.use('/api/auth', createAuthRouter(authCallbacks));
  app.use('/api', createApiRouter(printerManager));
  app.use('/api/alerts', createAlertsRouter());

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'index.html'));
  });

  return app;
}

module.exports = { createApp };
