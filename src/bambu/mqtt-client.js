'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const pino = require('pino');
const { MQTT_BROKER, PUSHALL_INTERVAL_MS } = require('../utils/constants');
const { buildPushall } = require('./commands');
const { parseMessage, deepMerge, extractPrinterState } = require('./message-parser');

// Bambu's public CA bundle for verifying printers on LAN MQTT (see certs/README.md)
let lanCaBundle = null;
function getLanCaBundle() {
  if (!lanCaBundle) lanCaBundle = fs.readFileSync(path.join(__dirname, 'certs', 'bambu-ca-bundle.pem'), 'utf8');
  return lanCaBundle;
}

const LAN_MQTT_PORT = 8883;

/** Errors a reconnect can't fix: refused access code (CONNACK 4/5, MQTT5 134/135) or the wrong printer. */
function isFatalLanError(err) {
  return err?.code === 'ERR_PRINTER_IDENTITY' || [4, 5, 134, 135].includes(err?.code);
}

/** TLS identity check for LAN printers: certificate CN must be the expected serial. */
function checkPrinterIdentity(serial, host, cert) {
  const cn = cert?.subject?.CN;
  if (cn && String(cn).toUpperCase() === String(serial).toUpperCase()) return undefined;
  const err = new Error(`Printer at ${host} identifies as ${cn || 'unknown'}, expected ${serial} — check the IP address`);
  err.code = 'ERR_PRINTER_IDENTITY';
  return err;
}
const LAN_USERNAME = 'bblp';

/**
 * Connection options for each transport kind (docs/architecture-transports.md).
 * Exported for tests — the TLS policy is security-relevant.
 */
function buildConnectOptions({ kind, deviceId, token, userId, broker, lan, tlsVerify = true, reconnect = true }) {
  const common = {
    clientId: `bambuzle_${deviceId}_${Date.now()}`,
    keepalive: 30,
    reconnectPeriod: reconnect ? 5000 : 0,
    connectTimeout: 30000,
  };
  if (kind === 'lan') {
    if (!lan?.host || !lan?.accessCode) throw new Error('LAN transport needs host and accessCode');
    return {
      url: `mqtts://${lan.host}:${LAN_MQTT_PORT}`,
      options: {
        ...common,
        username: LAN_USERNAME,
        password: lan.accessCode,
        // Verify the chain against Bambu's CAs. Printers are addressed by IP (not in the cert), but each
        // printer's cert CN is its serial — so pin identity to the serial instead of the hostname. This also
        // catches DHCP handing the IP to a different Bambu printer. Verified against an H2D and X1C 2026-10-03.
        // TLS 1.2 max: some P2S firmware never answers a TLS 1.3 ClientHello.
        rejectUnauthorized: tlsVerify,
        ca: tlsVerify ? getLanCaBundle() : undefined,
        checkServerIdentity: tlsVerify ? (host, cert) => checkPrinterIdentity(deviceId, host, cert) : () => undefined,
        maxVersion: 'TLSv1.2',
      },
    };
  }
  return {
    url: broker || MQTT_BROKER,
    options: { ...common, username: `u_${userId}`, password: token, rejectUnauthorized: true },
  };
}

/**
 * MqttPrinterClient manages a single MQTT connection to one printer — over Bambu Cloud (`kind: 'cloud'`)
 * or directly to the printer on the LAN (`kind: 'lan'`). It implements the transport contract in
 * docs/architecture-transports.md.
 *
 * Events:
 *   'state' — emitted on each state update with (deviceId, extractedState, rawMerged)
 *   'raw'   — emitted with raw parsed JSON message
 *   'connected' — MQTT connected
 *   'disconnected' — MQTT disconnected
 *   'mqtt_error' — connection error
 */
class MqttPrinterClient extends EventEmitter {
  constructor({ deviceId, kind = 'cloud', token, userId, broker, lan, tlsVerify = true, reconnect = true, logger, connectFn }) {
    super();
    this.deviceId = deviceId;
    this.kind = kind;
    this.token = token;
    this.userId = userId;
    this.broker = broker || MQTT_BROKER;
    this.lan = lan || null;
    this.tlsVerify = tlsVerify;
    this.reconnect = reconnect;
    this.connectFn = connectFn || mqtt.connect; // injectable for tests
    this.log = (logger || pino()).child({ component: 'mqtt', deviceId, transport: kind });
    this.client = null;
    this.mergedState = {};
    this.lastPushall = 0;
    this._reconnectTimer = null;
    this._destroyed = false;
  }

  get reportTopic() {
    return `device/${this.deviceId}/report`;
  }

  get requestTopic() {
    return `device/${this.deviceId}/request`;
  }

  connect() {
    if (this._destroyed) return;

    const { url, options } = buildConnectOptions(this);
    this.log.info({ url }, 'Connecting to MQTT broker');
    if (this.kind === 'lan' && !this.tlsVerify) this.log.warn('LAN TLS verification is OFF (BAMBUZLE_LAN_TLS_VERIFY=off)');

    this.client = this.connectFn(url, options);

    this.client.on('connect', () => {
      this.lastError = null;
      this.log.info('Connected to MQTT broker');
      this.emit('connected', this.deviceId);

      this.client.subscribe(this.reportTopic, { qos: 0 }, (err) => {
        if (err) {
          this.log.error({ err }, 'Subscribe failed');
          return;
        }
        this.log.info({ topic: this.reportTopic }, 'Subscribed');
        this.sendPushall();
      });
    });

    this.client.on('message', (_topic, payload) => {
      try {
        this._handleMessage(payload);
      } catch (err) {
        this.log.error({ err }, 'Error handling message');
      }
    });

    this.client.on('error', (err) => {
      this.lastError = err?.message || String(err);
      // Wrong access code / wrong printer at this address won't fix itself: stop retrying every 5 s
      // (printers throttle rapid reconnects) until settings change (review BAM-35 #10)
      if (this.kind === 'lan' && isFatalLanError(err)) {
        this.log.error({ err: this.lastError }, 'LAN connection refused — not retrying until settings change');
        this.fatal = true;
        this.emit('mqtt_error', this.deviceId, err);
        this.client.end(true);
        return;
      }
      this.log.error({ err }, 'MQTT error');
      this.emit('mqtt_error', this.deviceId, err);
    });

    this.client.on('close', () => {
      this.log.warn('MQTT connection closed');
      this.emit('disconnected', this.deviceId);
    });

    this.client.on('offline', () => {
      this.log.warn('MQTT client offline');
    });

    this.client.on('reconnect', () => {
      this.log.info('Reconnecting to MQTT broker');
    });
  }

  _handleMessage(payload) {
    const parsed = parseMessage(payload.toString());
    if (!parsed) return;

    this.emit('raw', this.deviceId, parsed);

    // Deep-merge into accumulated state
    this.mergedState = deepMerge(this.mergedState, parsed);

    // Extract normalized state
    const state = extractPrinterState(this.mergedState);
    this.emit('state', this.deviceId, state, this.mergedState);
  }

  /**
   * Send a pushall command, rate-limited to once per PUSHALL_INTERVAL_MS.
   */
  sendPushall() {
    const now = Date.now();
    if (now - this.lastPushall < PUSHALL_INTERVAL_MS) {
      this.log.debug('Pushall rate-limited, skipping');
      return false;
    }

    return this.sendCommand(buildPushall());
  }

  /**
   * Force a pushall regardless of rate limit (for initial connect).
   */
  forcePushall() {
    this.lastPushall = Date.now();
    return this._publish(buildPushall());
  }

  /**
   * Send an arbitrary command to the printer.
   */
  sendCommand(cmd) {
    if (cmd.pushing) {
      this.lastPushall = Date.now();
    }
    return this._publish(cmd);
  }

  /**
   * Publish a print command and wait briefly for the printer's reply (BAM-28).
   * Replies echo `print.command` + `print.sequence_id`; `result`/`reason` are reported when present.
   * Resolves { sent, acknowledged, result, reason } — never rejects.
   */
  sendCommandAwaitReply(cmd, { timeoutMs = 4000 } = {}) {
    const seq = cmd.print?.sequence_id;
    const name = cmd.print?.command;
    return new Promise((resolve) => {
      if (!this._publish(cmd)) return resolve({ sent: false, acknowledged: false });
      const onRaw = (deviceId, msg) => {
        const p = msg?.print;
        if (!p || p.command !== name || String(p.sequence_id) !== String(seq)) return;
        cleanup();
        resolve({ sent: true, acknowledged: true, result: p.result ?? null, reason: p.reason ?? null });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ sent: true, acknowledged: false });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('raw', onRaw);
      };
      this.on('raw', onRaw);
    });
  }

  _publish(cmd) {
    if (!this.client || !this.client.connected) {
      this.log.warn('Cannot publish — not connected');
      return false;
    }

    const payload = JSON.stringify(cmd);
    this.client.publish(this.requestTopic, payload, { qos: 0 });
    this.log.debug({ topic: this.requestTopic, cmd: Object.keys(cmd) }, 'Published command');
    return true;
  }

  /**
   * Update credentials (after token refresh).
   */
  updateCredentials(token, userId) {
    this.token = token;
    this.userId = userId;
    // mqtt.js reconnects with the options captured at connect() — update them too, or a reconnect after a
    // token refresh would still use the old token (review BAM-35)
    if (this.client?.options && this.kind === 'cloud') {
      this.client.options.username = `u_${userId}`;
      this.client.options.password = token;
    }
  }

  /**
   * Disconnect and clean up.
   */
  destroy() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.removeAllListeners();
  }

  get connected() {
    return this.client?.connected ?? false;
  }

  /**
   * Get the current merged state snapshot.
   */
  getState() {
    return extractPrinterState(this.mergedState);
  }
}

module.exports = { MqttPrinterClient, buildConnectOptions, checkPrinterIdentity, isFatalLanError, LAN_MQTT_PORT };
