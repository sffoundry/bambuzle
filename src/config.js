'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from project root
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  // No config.json or invalid — use defaults
}

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Directory for the SQLite database and other runtime state (Docker: mount a volume here)
const dataDir = path.resolve(process.env.BAMBUZLE_DATA_DIR || fileConfig.dataDir || PROJECT_ROOT);

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

const backupKeep = parseInt(process.env.BAMBUZLE_BACKUP_KEEP ?? fileConfig.backup?.keep ?? 7, 10);

const config = {
  dataDir,

  // BambuLab credentials (from .env)
  bambu: {
    email: process.env.BAMBU_EMAIL || '',
    password: process.env.BAMBU_PASSWORD || '',
    region: process.env.BAMBU_REGION || 'us', // us, cn, eu
  },

  // Sampling intervals (seconds)
  sampling: {
    activeIntervalSec: fileConfig.sampling?.activeIntervalSec ?? 5,
    idleIntervalSec: fileConfig.sampling?.idleIntervalSec ?? 30,
  },

  // Data retention (days)
  retention: {
    days: fileConfig.retention?.days ?? 90,
    // BAM-36: raw samples are rolled into hourly averages after rawDays; hourly rows kept rollupDays
    rawDays: Math.max(1, parseInt(process.env.BAMBUZLE_RAW_RETENTION_DAYS ?? fileConfig.retention?.rawDays ?? 14, 10) || 14),
    rollupDays: Math.max(1, parseInt(process.env.BAMBUZLE_ROLLUP_RETENTION_DAYS ?? fileConfig.retention?.rollupDays ?? 365, 10) || 365),
  },

  // Operator audit trail (BAM-41) — kept much longer than telemetry; 0 = keep forever
  audit: {
    retentionDays: (() => {
      const n = parseInt(process.env.BAMBUZLE_AUDIT_RETENTION_DAYS ?? fileConfig.audit?.retentionDays ?? 365, 10);
      return Number.isFinite(n) && n >= 0 ? n : 365;
    })(),
  },

  // Dashboard requester auth (BAM-30) — see src/server/admin-auth.js
  auth: {
    mode: (process.env.BAMBUZLE_AUTH || fileConfig.auth?.mode || 'on').toLowerCase() === 'off' ? 'off' : 'on',
    adminToken: process.env.BAMBUZLE_ADMIN_TOKEN || fileConfig.auth?.adminToken || '',
    // Set when behind a reverse proxy (e.g. 1, 'loopback', or a subnet) so req.ip / req.secure are real
    trustProxy: process.env.BAMBUZLE_TRUST_PROXY || fileConfig.auth?.trustProxy || '',
    publicRead: (process.env.BAMBUZLE_PUBLIC_READ ?? String(fileConfig.auth?.publicRead ?? 'false')).toLowerCase() === 'true',
  },

  // SQLite online backups (BAM-34) — see src/db/backup.js
  backup: {
    enabled: envBool(process.env.BAMBUZLE_BACKUP_ENABLED, fileConfig.backup?.enabled ?? true),
    cron: fileConfig.backup?.cron || '30 3 * * *', // daily, after the 03:00 retention cleanup
    dir: path.resolve(dataDir, process.env.BAMBUZLE_BACKUP_DIR || fileConfig.backup?.dir || 'backups'),
    keep: Number.isFinite(backupKeep) && backupKeep >= 1 ? backupKeep : 7,
  },

  // LAN printer connections (BAM-35). Verify printer TLS against Bambu's CA bundle; 'off' is an escape hatch.
  lan: {
    tlsVerify: (process.env.BAMBUZLE_LAN_TLS_VERIFY || fileConfig.lan?.tlsVerify || 'on').toString().toLowerCase() !== 'off',
  },

  // Home Assistant MQTT bridge (BAM-42) — off unless a broker URL is set. Read-only (publish only).
  ha: {
    url: process.env.BAMBUZLE_HA_MQTT_URL || fileConfig.ha?.url || '',
    username: process.env.BAMBUZLE_HA_MQTT_USERNAME || fileConfig.ha?.username || '',
    password: process.env.BAMBUZLE_HA_MQTT_PASSWORD || fileConfig.ha?.password || '',
    prefix: process.env.BAMBUZLE_HA_PREFIX || fileConfig.ha?.prefix || 'bambuzle',
    throttleSec: Number(process.env.BAMBUZLE_HA_THROTTLE_SEC || fileConfig.ha?.throttleSec || 10),
  },

  // HTTP server
  server: {
    port: parseInt(process.env.PORT, 10) || fileConfig.server?.port || 3000,
    host: process.env.HOST || fileConfig.server?.host || '0.0.0.0',
  },

  // Logging
  log: {
    level: process.env.LOG_LEVEL || fileConfig.log?.level || 'info',
  },

  // MQTT broker override (mostly for testing)
  mqtt: {
    broker: fileConfig.mqtt?.broker || null, // null = use default from constants
  },

  // Anomaly detection thresholds
  anomaly: {
    deviationDeg: {
      nozzle: fileConfig.anomaly?.deviationDeg?.nozzle ?? 8,
      nozzle2: fileConfig.anomaly?.deviationDeg?.nozzle2 ?? 8,
      bed: fileConfig.anomaly?.deviationDeg?.bed ?? 5,
      chamber: fileConfig.anomaly?.deviationDeg?.chamber ?? 10,
    },
    rateDegPerSec: {
      nozzle: fileConfig.anomaly?.rateDegPerSec?.nozzle ?? 2.0,
      nozzle2: fileConfig.anomaly?.rateDegPerSec?.nozzle2 ?? 2.0,
      bed: fileConfig.anomaly?.rateDegPerSec?.bed ?? 0.5,
      chamber: fileConfig.anomaly?.rateDegPerSec?.chamber ?? 0.3,
    },
  },
};

module.exports = config;
