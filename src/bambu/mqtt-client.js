'use strict';

const EventEmitter = require('events');
const mqtt = require('mqtt');
const pino = require('pino');
const { MQTT_BROKER, PUSHALL_INTERVAL_MS } = require('../utils/constants');
const { buildPushall } = require('./commands');
const { parseMessage, deepMerge, extractPrinterState } = require('./message-parser');

/**
 * MqttPrinterClient manages a single MQTT connection to one printer.
 *
 * Events:
 *   'state' — emitted on each state update with (deviceId, extractedState, rawMerged)
 *   'raw'   — emitted with raw parsed JSON message
 *   'connected' — MQTT connected
 *   'disconnected' — MQTT disconnected
 *   'mqtt_error' — connection error
 */
class MqttPrinterClient extends EventEmitter {
  constructor({ deviceId, token, userId, broker, logger }) {
    super();
    this.deviceId = deviceId;
    this.token = token;
    this.userId = userId;
    this.broker = broker || MQTT_BROKER;
    this.log = (logger || pino()).child({ component: 'mqtt', deviceId });
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

    this.log.info({ broker: this.broker }, 'Connecting to MQTT broker');

    this.client = mqtt.connect(this.broker, {
      username: `u_${this.userId}`,
      password: this.token,
      clientId: `bambuzle_${this.deviceId}_${Date.now()}`,
      rejectUnauthorized: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    });

    this.client.on('connect', () => {
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

module.exports = { MqttPrinterClient };
