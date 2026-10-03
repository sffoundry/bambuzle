'use strict';

const http = require('http');
const pino = require('pino');
const { Cron } = require('croner');
const config = require('./config');
const { getAuth, refreshAuth, getDevices, getAuthStatus } = require('./bambu/auth');
const { MqttPrinterClient } = require('./bambu/mqtt-client');
const { parseHmsErrors } = require('./utils/hms-codes');
const { GCODE_STATE } = require('./utils/constants');
const { getActiveTrayMaterial } = require('./utils/material');
const { jobEndState, JOB_END_CANCELLED } = require('./utils/job-state');
const amsHumidity = require('./db/ams-humidity');
const { reconcileHms } = require('./db/hms-active');
const printerConnections = require('./db/printer-connections');
const { chooseTransport, computeCapabilities } = require('./printers/transport-policy');
const { modelKeyFromCloudCode } = require('./utils/printer-models');
const { getDb, closeDb } = require('./db/database');
const { createBackupService } = require('./db/backup');
const queries = require('./db/queries');
const { createApp } = require('./server/app');
const { createAdminAuth } = require('./server/admin-auth');
const { createWebSocket, broadcast, closeWebSocket } = require('./server/websocket');
const { AlertEngine } = require('./alerts/engine');
const { AnomalyDetector } = require('./anomaly/detector');

const log = pino({ level: config.log.level });

// ─── State ───

const mqttClients = {};   // deviceId -> transport (MqttPrinterClient, kind 'cloud' | 'lan') — docs/architecture-transports.md
const signatureRejected = new Set(); // deviceIds whose printer answered "mqtt message verify failed"
const liveStates = {};    // deviceId -> extracted state
const lastSampleTs = {};  // deviceId -> timestamp of last sample write
let currentAuth = null;
let alertEngine = null;
let anomalyDetector = null;
let cronJobs = [];
let tokenRefreshJob = null;
let backupService = null;

const lastMessageAt = {}; // deviceId -> ms timestamp of the last MQTT report (BAM-37 metrics)

const printerManager = {
  getLiveStates: () => liveStates,
  getLastMessageAt: (deviceId) => lastMessageAt[deviceId] || null,
  isConnected: (deviceId) => mqttClients[deviceId]?.connected ?? false,
  getClient: (deviceId) => mqttClients[deviceId] || null,
  getTransportKind: (deviceId) => mqttClients[deviceId]?.kind || null,
  getCapabilities: (deviceId) => computeCapabilities({
    conn: printerConnections.getConnection(deviceId),
    transport: mqttClients[deviceId]?.kind || null,
    connected: mqttClients[deviceId]?.connected ?? false,
    developerMode: liveStates[deviceId]?.diagnostics?.developerMode,
    signatureRejected: signatureRejected.has(deviceId),
    lastError: mqttClients[deviceId]?.lastError || null,
    modelKey: mqttClients[deviceId]?.modelKey || modelKeyFromCloudCode(queries.getPrinter(deviceId)?.model),
    firmwareVersion: mqttClients[deviceId]?.firmwareVersion || null,
  }),
  /** HMS dataset model key (X1C, H2D…): printer's get_version reply, else the cloud model code (BAM-50). */
  getModelKey: (deviceId) => mqttClients[deviceId]?.modelKey || modelKeyFromCloudCode(queries.getPrinter(deviceId)?.model),
  markSignatureRejected: (deviceId) => signatureRejected.add(deviceId),
  /** Re-evaluate one printer's transport after its connection settings changed. */
  reconnect: (deviceId) => syncConnection(deviceId),
};

// ─── Main ───

// Last-resort guard: log async errors instead of letting Node 20 exit on an unhandled rejection
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'Unhandled promise rejection');
});

async function main() {
  log.info('Bambuzle starting');

  // Init database
  getDb();
  log.info('Database initialized');

  // Scheduled online backups (BAM-34). Independent of Bambu auth — a never-authenticated (or LAN-only)
  // install still has data worth keeping.
  backupService = createBackupService({ getDb, backup: config.backup, log });
  backupService.start();

  // Alert engine
  alertEngine = new AlertEngine(log);
  alertEngine.ensureDefaults();

  // Anomaly detector
  anomalyDetector = new AnomalyDetector(log, config);

  // Start HTTP server unconditionally so the dashboard is always reachable
  const adminAuth = createAdminAuth({ auth: config.auth, dataDir: config.dataDir, log });
  const app = createApp(printerManager, { onAuthenticated, onLoggedOut }, adminAuth, {
    backupService,
    getCloudAuthStatus: getAuthStatus,
    dataDir: config.dataDir,
  });
  const server = http.createServer(app);
  createWebSocket(server, log, { verifyRequest: adminAuth.verifyWsRequest });

  server.listen(config.server.port, config.server.host, () => {
    log.info({ port: config.server.port, host: config.server.host }, 'HTTP server listening');
  });

  // Housekeeping runs with or without a cloud login (LAN-only installs need it too)
  cronJobs = startCronJobs();

  // LAN printers connect now — they don't need a BambuLab Cloud login (BAM-35)
  syncAllConnections();

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
    if (tokenRefreshJob) tokenRefreshJob.stop();
    await backupService.stop(); // waits for an in-flight backup before the DB closes

    for (const client of Object.values(mqttClients)) {
      client.destroy();
    }

    closeWebSocket(); // terminates open dashboard sockets, otherwise server.close() never resolves

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

  // Re-auth: cloud transports must reconnect with the new credentials; LAN ones are unaffected
  for (const [id, client] of Object.entries(mqttClients)) {
    if (client.kind === 'cloud') {
      client.destroy();
      delete mqttClients[id];
    }
  }
  syncAllConnections();

  // Broadcast fresh printer list to any connected dashboard clients
  broadcast('auth', { status: 'authenticated' });

  if (tokenRefreshJob) tokenRefreshJob.stop();
  tokenRefreshJob = startTokenRefresh();
}

/** BambuLab Cloud logout: drop cloud transports (LAN ones keep running). */
function onLoggedOut() {
  currentAuth = null;
  if (tokenRefreshJob) { tokenRefreshJob.stop(); tokenRefreshJob = null; }
  for (const [id, client] of Object.entries(mqttClients)) {
    if (client.kind === 'cloud') {
      client.destroy();
      delete mqttClients[id];
      broadcast('state', { deviceId: id, state: liveStates[id] || {}, connected: false, capabilities: printerManager.getCapabilities(id) });
    }
  }
  log.info('Logged out of BambuLab Cloud — cloud printers disconnected');
}

// ─── Cron Jobs ───

function startCronJobs() {
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
    const layersDeleted = queries.deleteOldLayerTransitions(days);
    const anomaliesDeleted = queries.deleteOldTempAnomalies(days);
    const pausesDeleted = queries.deleteOldJobPauses(days);
    const amsHumidityDeleted = amsHumidity.deleteOldAmsHumidity(days);
    log.info({
      samplesDeleted: samplesDeleted.changes,
      eventsDeleted: eventsDeleted.changes,
      layersDeleted: layersDeleted.changes,
      anomaliesDeleted: anomaliesDeleted.changes,
      pausesDeleted: pausesDeleted.changes,
      amsHumidityDeleted: amsHumidityDeleted.changes,
    }, 'Cleanup complete');
  });

  return [pushallJob, cleanupJob];
}

/** BambuLab Cloud token refresh — only once logged in. */
function startTokenRefresh() {
  return new Cron('0 */12 * * *', async () => {
    try {
      currentAuth = await refreshAuth(config);
      log.info('Token refreshed');
      for (const client of Object.values(mqttClients)) {
        if (client.kind === 'cloud') client.updateCredentials(currentAuth.token, currentAuth.userId);
      }
    } catch (err) {
      log.error({ err }, 'Token refresh failed');
    }
  });
}

// ─── Transport selection (BAM-35) ───

/** Connect / switch / disconnect one printer according to its connection settings and cloud login. */
function syncConnection(deviceId) {
  const conn = printerConnections.getConnection(deviceId);
  const kind = chooseTransport(conn, Boolean(currentAuth));
  const signature = kind === 'lan' ? `lan:${conn.lanHost}:${conn.accessCode}` : kind === 'cloud' ? 'cloud' : null;
  const existing = mqttClients[deviceId];
  if (existing && existing.signature === signature) return;
  // Carry the merged report over a transport switch: the new client's first partial update would otherwise
  // parse as gcodeState UNKNOWN and log a bogus "RUNNING → UNKNOWN" mid-print (review BAM-35 #6)
  const carriedState = existing?.mergedState && Object.keys(existing.mergedState).length ? existing.mergedState : null;
  if (existing) {
    existing.destroy();
    delete mqttClients[deviceId];
    broadcast('state', { deviceId, state: liveStates[deviceId] || {}, connected: false });
  }
  signatureRejected.delete(deviceId);
  if (!kind) return;
  connectPrinter(deviceId, kind, conn, signature, carriedState);
}

function syncAllConnections() {
  for (const conn of printerConnections.getAllConnections()) syncConnection(conn.deviceId);
  // Forget transports for printers that no longer exist (deleted manual printers)
  for (const id of Object.keys(mqttClients)) {
    if (!printerConnections.getConnection(id)) {
      mqttClients[id].destroy();
      delete mqttClients[id];
    }
  }
}

// ─── Printer Connection ───

function connectPrinter(deviceId, kind, conn, signature, carriedState = null) {
  const client = new MqttPrinterClient({
    deviceId,
    kind,
    token: currentAuth?.token,
    userId: currentAuth?.userId,
    lan: kind === 'lan' ? { host: conn.lanHost, accessCode: conn.accessCode } : null,
    tlsVerify: config.lan.tlsVerify,
    logger: log,
  });
  client.signature = signature;
  if (carriedState) client.mergedState = carriedState;
  log.info({ deviceId, transport: kind }, 'Connecting printer');

  mqttClients[deviceId] = client;

  client.on('state', (deviceId, state) => {
    const prevState = liveStates[deviceId];
    liveStates[deviceId] = state;
    lastMessageAt[deviceId] = Date.now();

    broadcast('state', { deviceId, state, connected: true, capabilities: printerManager.getCapabilities(deviceId) });
    handleJobTransition(deviceId, state, prevState);

    const activeJob = queries.getActiveJob(deviceId);
    maybeCaptureMaterial(activeJob, state);
    maybeSample(deviceId, state, activeJob);
    amsHumidity.recordAmsHumidity(deviceId, state.diagnostics?.amsHumidity);
    anomalyDetector.checkLayerTransition(deviceId, state, activeJob);
    anomalyDetector.checkTemperatureAnomalies(deviceId, state, activeJob);

    // Always reconcile — an empty list means errors cleared, so a later recurrence is recorded again
    if (Array.isArray(state.hmsErrors)) handleHmsErrors(deviceId, state.hmsErrors, activeJob);
    handlePrintError(deviceId, state, prevState, activeJob);

    const printer = queries.getPrinter(deviceId);
    alertEngine.evaluate(deviceId, state, printer?.name || deviceId);
  });

  client.on('connected', (deviceId) => {
    broadcast('state', { deviceId, state: liveStates[deviceId] || {}, connected: true, capabilities: printerManager.getCapabilities(deviceId) });
  });

  client.on('disconnected', (deviceId) => {
    broadcast('state', { deviceId, state: liveStates[deviceId] || {}, connected: false, capabilities: printerManager.getCapabilities(deviceId) });
  });

  client.on('version', (deviceId, info) => {
    log.info({ deviceId, model: info.modelKey, firmware: info.firmwareVersion }, 'Printer version');
  });

  client.on('mqtt_error', (deviceId, err) => {
    log.error({ deviceId, err: err.message }, 'Printer MQTT connection error');
  });

  client.connect();
}

// ─── Print Error (BAM-32) ───

/** Record an event when print_error changes to a non-zero, non-cancel code. */
function handlePrintError(deviceId, state, prevState, activeJob) {
  const curr = state.diagnostics?.printError;
  const prevCode = prevState?.diagnostics?.printError?.code ?? 0;
  if (!curr?.active || curr.code === prevCode) return;

  const message = `Print error ${curr.hex}`;
  queries.insertEvent({ deviceId, jobId: activeJob?.id || null, eventType: 'print_error', severity: 'error', code: curr.hex, message });
  broadcast('event', { device_id: deviceId, event_type: 'print_error', severity: 'error', code: curr.hex, message, ts: new Date().toISOString() });
  log.warn({ deviceId, code: curr.hex }, message);
}

// ─── Job Tracking ───

function handleJobTransition(deviceId, state, prevState) {
  const prev = prevState?.gcodeState;
  const curr = state.gcodeState;
  if (prev === curr) return;

  const activeJob = queries.getActiveJob(deviceId);
  const cancelled = jobEndState(curr, state) === JOB_END_CANCELLED;
  const severity = curr === GCODE_STATE.FAILED && !cancelled ? 'error' : 'info';
  const message = `State: ${prev || '?'} → ${curr}${cancelled ? ' (cancelled by user)' : ''}`;
  queries.insertEvent({
    deviceId,
    jobId: activeJob?.id || null,
    eventType: 'state_change',
    severity,
    message,
  });
  broadcast('event', {
    device_id: deviceId,
    event_type: 'state_change',
    severity,
    message,
    ts: new Date().toISOString(),
  });

  if ((curr === GCODE_STATE.RUNNING || curr === GCODE_STATE.PREPARE) &&
      (!prev || prev === GCODE_STATE.IDLE || prev === GCODE_STATE.FINISH || prev === GCODE_STATE.FAILED)) {
    if (!activeJob) {
      // BAM-10: record the active AMS tray's filament for per-material stats.
      // Required here (not at the top) to keep this change confined to handleJobTransition.
      const { material, color } = getActiveTrayMaterial(state.ams);
      const jobId = queries.startJob({
        deviceId,
        taskId: state.taskId,
        subtaskName: state.subtaskName,
        gcodeFile: state.gcodeFile,
        material,
        materialColor: color,
      });
      log.info({ deviceId, jobId }, 'New print job started');
      anomalyDetector.resetDevice(deviceId);
    }
  }

  // Pause/resume detection
  if (curr === GCODE_STATE.PAUSE && prev === GCODE_STATE.RUNNING) {
    anomalyDetector.handlePause(deviceId, state);
  }
  if (curr === GCODE_STATE.RUNNING && prev === GCODE_STATE.PAUSE) {
    anomalyDetector.handleResume(deviceId);
  }

  if ((prev === GCODE_STATE.RUNNING || prev === GCODE_STATE.PAUSE) &&
      (curr === GCODE_STATE.FINISH || curr === GCODE_STATE.FAILED || curr === GCODE_STATE.IDLE)) {
    if (activeJob) {
      const endState = jobEndState(curr, state);
      queries.endJob(activeJob.id, endState, state.progress);
      log.info({ deviceId, jobId: activeJob.id, endState }, 'Print job ended');
    }
  }
}

// ─── Late material capture (review finding 11) ───

/** The AMS is often still loading during PREPARE (tray_now 255) — fill material once RUNNING. */
function maybeCaptureMaterial(activeJob, state) {
  if (!activeJob || activeJob.material || state.gcodeState !== GCODE_STATE.RUNNING) return;
  const { material, color } = getActiveTrayMaterial(state.ams);
  if (material) queries.setJobMaterial(activeJob.id, material, color);
}

// ─── Sampling ───

function maybeSample(deviceId, state, activeJob) {
  const now = Date.now();
  const last = lastSampleTs[deviceId] || 0;
  const isActive = state.gcodeState === GCODE_STATE.RUNNING || state.gcodeState === GCODE_STATE.PREPARE;
  const interval = isActive
    ? config.sampling.activeIntervalSec * 1000
    : config.sampling.idleIntervalSec * 1000;

  if (now - last < interval) return;
  lastSampleTs[deviceId] = now;

  queries.insertSample({
    deviceId,
    jobId: activeJob?.id || null,
    bedTemp: state.bedTemp,
    bedTarget: state.bedTarget,
    nozzleTemp: state.nozzleTemp,
    nozzleTarget: state.nozzleTarget,
    nozzle2Temp: state.nozzle2Temp,
    nozzle2Target: state.nozzle2Target,
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


function handleHmsErrors(deviceId, hmsRaw, activeJob) {
  const parsed = parseHmsErrors(hmsRaw, printerManager.getModelKey(deviceId));
  // Persisted active set: no duplicate events on restart; cleared codes re-arm (see src/db/hms-active.js)
  const { added } = reconcileHms(deviceId, parsed.map((e) => e.key));
  const isNew = new Set(added);

  for (const entry of parsed) {
    if (isNew.has(entry.key)) {
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
        hms_severity: entry.severity,
        subsystem: entry.subsystem,
        wiki_url: entry.wikiUrl,
        ts: new Date().toISOString(),
      });
      log.warn({ deviceId, code: entry.key, hmsSeverity: entry.severity, subsystem: entry.subsystem }, `HMS Error: ${entry.description}`);
    }
  }

  if (parsed.length > 0) {
    anomalyDetector.trackJobHmsErrors(deviceId, parsed, activeJob);
  }
}

// ─── Start ───

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
