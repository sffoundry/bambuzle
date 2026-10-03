'use strict';

const { WebSocketServer } = require('ws');

let wss = null;
let verify = null;
let sweepTimer = null;
const REVALIDATE_MS = 30 * 1000;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * `verifyRequest(req)` gates the upgrade (dashboard admin auth, BAM-30).
 * Returns the WSS instance.
 */
function createWebSocket(httpServer, logger, { verifyRequest } = {}) {
  // Handlers use this local reference: closeWebSocket() nulls `wss` while terminated clients still fire 'close'
  const server = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: verifyRequest ? ({ req }) => verifyRequest(req) : undefined,
  });
  const log = logger.child({ component: 'websocket' });

  verify = verifyRequest || null;
  server.on('connection', (ws, req) => {
    ws._authReq = req; // re-checked later: a disabled/deleted user or revoked session loses the stream
    log.info({ clients: server.clients.size }, 'WebSocket client connected');

    ws.on('close', () => {
      log.debug({ clients: server.clients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      log.error({ err }, 'WebSocket client error');
    });
  });

  wss = server;
  if (verify) {
    sweepTimer = setInterval(revalidateClients, REVALIDATE_MS);
    sweepTimer.unref();
  }
  return wss;
}

/**
 * Re-run the upgrade check for every open socket and drop the ones whose credential no longer
 * holds (BAM-16). Called after account changes / sign-out, and every 30 s as a backstop.
 */
function revalidateClients() {
  if (!wss || !verify) return 0;
  let dropped = 0;
  for (const client of wss.clients) {
    const req = client._authReq;
    if (!req) continue;
    delete req._principal; // getPrincipal caches per request — force a fresh session lookup
    let ok = false;
    try { ok = Boolean(verify(req)); } catch { ok = false; }
    if (!ok) { client.terminate(); dropped++; }
  }
  return dropped;
}

/**
 * Broadcast a message to all connected WebSocket clients.
 * @param {string} type — message type (e.g. 'state', 'event')
 * @param {object} data — payload
 */
function broadcast(type, data) {
  if (!wss) return;

  const msg = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

/**
 * Get current number of connected clients.
 */
function clientCount() {
  return wss ? wss.clients.size : 0;
}

function closeWebSocket() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  verify = null;
  if (wss) {
    // ws v8 with an external HTTP server leaves clients open on close(); terminate them so shutdown completes
    for (const client of wss.clients) client.terminate();
    wss.close();
    wss = null;
  }
}

module.exports = { createWebSocket, broadcast, clientCount, closeWebSocket, revalidateClients };
