'use strict';

const { WebSocketServer } = require('ws');

let wss = null;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Returns the WSS instance.
 */
function createWebSocket(httpServer, logger) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const log = logger.child({ component: 'websocket' });

  wss.on('connection', (ws) => {
    log.info({ clients: wss.clients.size }, 'WebSocket client connected');

    ws.on('close', () => {
      log.debug({ clients: wss.clients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      log.error({ err }, 'WebSocket client error');
    });
  });

  return wss;
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
  if (wss) {
    wss.close();
    wss = null;
  }
}

module.exports = { createWebSocket, broadcast, clientCount, closeWebSocket };
