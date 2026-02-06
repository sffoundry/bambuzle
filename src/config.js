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

const config = {
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
};

module.exports = config;
