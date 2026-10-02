'use strict';

// Test harness: isolate runtime state in a temp data dir BEFORE any src module loads config.
// `node --test` runs each test file in its own process, so each file gets a fresh dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambuzle-test-'));
process.env.BAMBUZLE_DATA_DIR = dataDir;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const pino = require('pino');
const { getDb, closeDb } = require('../src/db/database');
const { createApp } = require('../src/server/app');
const { createAdminAuth } = require('../src/server/admin-auth');
const { createWebSocket, closeWebSocket } = require('../src/server/websocket');

const TEST_TOKEN = 'test-admin-token';
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}` };

/** Minimal stand-in for the printer manager in src/index.js. */
function fakePrinterManager({ liveStates = {}, clients = {} } = {}) {
  return {
    getLiveStates: () => liveStates,
    isConnected: (id) => Boolean(clients[id]),
    getClient: (id) => clients[id] || null,
  };
}

/**
 * Start the Express app + WebSocket on an ephemeral port.
 * Auth defaults to ON with TEST_TOKEN; send `authHeaders` to pass the admin guard.
 * @returns {Promise<{ baseUrl: string, server: http.Server, close: () => Promise<void> }>}
 */
async function startServer({
  printerManager = fakePrinterManager(),
  authCallbacks = { onAuthenticated() {} },
  auth = { mode: 'on', adminToken: TEST_TOKEN, publicRead: false },
} = {}) {
  getDb();
  const log = pino({ level: 'silent' });
  const adminAuth = createAdminAuth({ auth, dataDir, log });
  const app = createApp(printerManager, authCallbacks, adminAuth);
  const server = http.createServer(app);
  createWebSocket(server, log, { verifyRequest: adminAuth.verifyWsRequest });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      closeWebSocket();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function cleanup() {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

module.exports = { dataDir, TEST_TOKEN, authHeaders, fakePrinterManager, startServer, cleanup };
