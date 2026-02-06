'use strict';

const http = require('http');
const pino = require('pino');
const { Cron } = require('croner');
const config = require('./config');
const { getAuth, refreshAuth, getDevices } = require('./bambu/auth');
const { MqttPrinterClient } = require('./bambu/mqtt-client');
const { parseHmsErrors } = require('./utils/hms-codes');
const { GCODE_STATE } = require('./utils/constants');
const { getDb, closeDb } = require('./db/database');
const queries = require('./db/queries');
const { createApp } = require('./server/app');
const { createWebSocket, broadcast, closeWebSocket } = require('./server/websocket');
const { AlertEngine } = require('./alerts/engine');

const log = pino({ level: config.log.level });

// ─── State ───

const mqttClients = {};   // deviceId -> MqttPrinterClient
const liveStates = {};    // deviceId -> extracted state
const lastSampleTs = {};  // deviceId -> timestamp of last sample write
let currentAuth = null;
let alertEngine = null;
let cronJobs = [];

const printerManager = {
  getLiveStates: () => liveStates,
  isConnected: (deviceId) => mqttClients[deviceId]?.connected ?? false,
  getClient: (deviceId) => mqttClients[deviceId] || null,
};

// ─── Main ───

async function main() {
  log.info('Bambuzle starting');

  // Init database
  getDb();
  log.info('Database initialized');

  // Alert engine
  alertEngine = new AlertEngine(log);
  alertEngine.ensureDefaults();

  // Start HTTP server unconditionally so the dashboard is always reachable
  const app = createApp(printerManager, { onAuthenticated });
  const server = http.createServer(app);
  createWebSocket(server, log);

  server.listen(config.server.port, config.server.host, () => {
    log.info({ port: config.server.port, host: config.server.host }, 'HTTP server listening');
  });

  // Attempt auth from .env credentials (non-fatal on failure)
  try {
    const result = await getAuth(config);

    if (result.needsVerification) {
      log.warn('BambuLab account requires a verification code — complete login at the dashboard');
    } else {
      await onAuthenticated(result);
    }
  } catch (err) {
    if (config.bambu.email) {
      log.warn({ err: err.message }, 'Auto-login failed — complete login at the dashboard');
    } else {
      log.info('No credentials in .env — waiting for login via dashboard');
    }
  }

  // ─── Graceful Shutdown ───

  async function shutdown(signal) {
    log.info({ signal }, 'Shutting down');

    for (const job of cronJobs) job.stop();

    for (const client of Object.values(mqttClients)) {
      client.destroy();
    }

    closeWebSocket();

    await new Promise((resolve) => server.close(resolve));

    closeDb();
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ─── Called when auth completes (startup or interactive) ───

async function onAuthenticated(auth) {
  currentAuth = auth;
  log.info({ userId: auth.userId }, 'Authenticated with BambuLab');

  // Discover devices
  let devices;
  try {
    devices = await getDevices(auth);
    log.info({ count: devices.length }, 'Discovered printers');
  } catch (err) {
    log.error({ err }, 'Failed to fetch device list');
    return;
  }

  if (devices.length === 0) {
    log.warn('No printers found on this account');
  }

  // Upsert printers in DB
  for (const d of devices) {
    queries.upsertPrinter(d);
    log.info({ deviceId: d.deviceId, name: d.name, model: d.model }, 'Registered printer');
  }

  // Disconnect any existing MQTT clients (in case of re-auth)
  for (const client of Object.values(mqttClients)) {
    client.destroy();
  }
  for (const key of Object.keys(mqttClients)) delete mqttClients[key];

  // Connect MQTT for each printer
  for (const device of devices) {
    connectPrinter(device, auth);
  }

  // Broadcast fresh printer list to any connected dashboard clients
  broadcast('auth', { status: 'authenticated' });

  // Start periodic jobs (stop old ones first in case of re-auth)
  for (const job of cronJobs) job.stop();
  cronJobs = startCronJobs(auth);
}

// ─── Cron Jobs ───

function startCronJobs(auth) {
  const pushallJob = new Cron('*/5 * * * *', () => {
    for (const client of Object.values(mqttClients)) {
      client.sendPushall();
    }
  });

  const cleanupJob = new Cron('0 3 * * *', () => {
    const days = config.retention.days;
    log.info({ days }, 'Running data retention cleanup');
    const samplesDeleted = queries.deleteOldSamples(days);
    const eventsDeleted = queries.deleteOldEvents(days);
    log.info({ samplesDeleted: samplesDeleted.changes, eventsDeleted: eventsDeleted.changes }, 'Cleanup complete');
  });

  const tokenRefreshJob = new Cron('0 */12 * * *', async () => {
    try {
      currentAuth = await refreshAuth(config);
      log.info('Token refreshed');
      for (const client of Object.values(mqttClients)) {
        client.updateCredentials(currentAuth.token, currentAuth.userId);
      }
    } catch (err) {
      log.error({ err }, 'Token refresh failed');
    }
  });

  return [pushallJob, cleanupJob, tokenRefreshJob];
}

// ─── Printer Connection ───

function connectPrinter(device, auth) {
  const client = new MqttPrinterClient({
    deviceId: device.deviceId,
    token: auth.token,
    userId: auth.userId,
    logger: log,
  });

  mqttClients[device.deviceId] = client;

  client.on('state', (deviceId, state) => {
    const prevState = liveStates[deviceId];
    liveStates[deviceId] = state;

    broadcast('state', { deviceId, state, connected: true });
    handleJobTransition(deviceId, state, prevState);
    maybeSample(deviceId, state);

    if (state.hmsErrors?.length > 0) {
      handleHmsErrors(deviceId, state.hmsErrors);
    }

    const printer = queries.getPrinter(deviceId);
    alertEngine.evaluate(deviceId, state, printer?.name || deviceId);
  });

  client.on('connected', (deviceId) => {
    broadcast('state', { deviceId, state: liveStates[deviceId] || {}, connected: true });
  });

  client.on('disconnected', (deviceId) => {
    broadcast('state', { deviceId, state: liveStates[deviceId] || {}, connected: false });
  });

  client.on('mqtt_error', (deviceId, err) => {
    log.error({ deviceId, err: err.message }, 'Printer MQTT connection error');
  });

  client.connect();
}

// ─── Job Tracking ───

function handleJobTransition(deviceId, state, prevState) {
  const prev = prevState?.gcodeState;
  const curr = state.gcodeState;
  if (prev === curr) return;

  const activeJob = queries.getActiveJob(deviceId);
  queries.insertEvent({
    deviceId,
    jobId: activeJob?.id || null,
    eventType: 'state_change',
    severity: curr === GCODE_STATE.FAILED ? 'error' : 'info',
    message: `State: ${prev || '?'} → ${curr}`,
  });
  broadcast('event', {
    device_id: deviceId,
    event_type: 'state_change',
    severity: curr === GCODE_STATE.FAILED ? 'error' : 'info',
    message: `State: ${prev || '?'} → ${curr}`,
    ts: new Date().toISOString(),
  });

  if ((curr === GCODE_STATE.RUNNING || curr === GCODE_STATE.PREPARE) &&
      (!prev || prev === GCODE_STATE.IDLE || prev === GCODE_STATE.FINISH || prev === GCODE_STATE.FAILED)) {
    if (!activeJob) {
      const jobId = queries.startJob({
        deviceId,
        taskId: state.taskId,
        subtaskName: state.subtaskName,
        gcodeFile: state.gcodeFile,
      });
      log.info({ deviceId, jobId }, 'New print job started');
    }
  }

  if ((prev === GCODE_STATE.RUNNING || prev === GCODE_STATE.PAUSE) &&
      (curr === GCODE_STATE.FINISH || curr === GCODE_STATE.FAILED || curr === GCODE_STATE.IDLE)) {
    if (activeJob) {
      queries.endJob(activeJob.id, curr, state.progress);
      log.info({ deviceId, jobId: activeJob.id, endState: curr }, 'Print job ended');
    }
  }
}

// ─── Sampling ───

function maybeSample(deviceId, state) {
  const now = Date.now();
  const last = lastSampleTs[deviceId] || 0;
  const isActive = state.gcodeState === GCODE_STATE.RUNNING || state.gcodeState === GCODE_STATE.PREPARE;
  const interval = isActive
    ? config.sampling.activeIntervalSec * 1000
    : config.sampling.idleIntervalSec * 1000;

  if (now - last < interval) return;
  lastSampleTs[deviceId] = now;

  const activeJob = queries.getActiveJob(deviceId);
  queries.insertSample({
    deviceId,
    jobId: activeJob?.id || null,
    bedTemp: state.bedTemp,
    bedTarget: state.bedTarget,
    nozzleTemp: state.nozzleTemp,
    nozzleTarget: state.nozzleTarget,
    chamberTemp: state.chamberTemp,
    partFanSpeed: state.partFanSpeed,
    auxFanSpeed: state.auxFanSpeed,
    chamberFanSpeed: state.chamberFanSpeed,
    progress: state.progress,
    layerNum: state.layerNum,
    totalLayers: state.totalLayers,
    remainingMin: state.remainingMin,
    gcodeState: state.gcodeState,
    speedLevel: state.speedLevel,
    wifiSignal: state.wifiSignal,
  });
}

// ─── HMS Error Handling ───

const recentHmsCodes = {};

function handleHmsErrors(deviceId, hmsRaw) {
  const parsed = parseHmsErrors(hmsRaw);
  const prev = recentHmsCodes[deviceId] || new Set();
  const current = new Set(parsed.map((e) => e.key));

  for (const entry of parsed) {
    if (!prev.has(entry.key)) {
      const activeJob = queries.getActiveJob(deviceId);
      queries.insertEvent({
        deviceId,
        jobId: activeJob?.id || null,
        eventType: 'hms_error',
        severity: 'error',
        code: entry.key,
        message: entry.description,
      });
      broadcast('event', {
        device_id: deviceId,
        event_type: 'hms_error',
        severity: 'error',
        code: entry.key,
        message: entry.description,
        ts: new Date().toISOString(),
      });
      log.warn({ deviceId, code: entry.key }, `HMS Error: ${entry.description}`);
    }
  }

  recentHmsCodes[deviceId] = current;
}

// ─── Start ───

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
