'use strict';

// Health, readiness and system/backup endpoints (BAM-34).
//
// /healthz and /readyz are PUBLIC (mounted before the /api admin guard) so Docker
// HEALTHCHECKs and orchestrators can probe them. They expose only coarse booleans and
// counts — never device IDs, printer names, tokens or paths.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb, DB_PATH } = require('../../db/database');
const { version } = require('../../../package.json');
const { audit } = require('../audit');

const COUNTED_TABLES = ['samples', 'events', 'print_jobs'];

function dbOk() {
  try {
    return getDb().prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    return false;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function printerCounts(printerManager) {
  const ids = getDb().prepare('SELECT device_id FROM printers').all().map((r) => r.device_id);
  let connected = 0;
  for (const id of ids) {
    try {
      if (printerManager.isConnected(id)) connected++;
    } catch {
      // treat as disconnected
    }
  }
  return { configured: ids.length, connected };
}

function backupCheck(backupService) {
  if (!backupService) return { enabled: false, lastOk: null, lastAgeSec: null };
  const last = backupService.getLastResult();
  return {
    enabled: backupService.getSchedule().enabled,
    lastOk: last ? last.ok : null,
    lastAgeSec: last ? Math.round((Date.now() - Date.parse(last.time)) / 1000) : null,
  };
}

/** GET /healthz, GET /readyz — mount at the app root, outside the /api guard. */
function createHealthRouter(printerManager, { backupService = null, getCloudAuthStatus = () => 'unknown' } = {}) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (dbOk()) return res.json({ status: 'ok' });
    res.status(503).json({ status: 'error' });
  });

  router.get('/readyz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const checks = { db: { ok: dbOk() } };
    if (!checks.db.ok) return res.status(503).json({ status: 'unavailable', checks });

    let cloudAuth;
    try {
      cloudAuth = getCloudAuthStatus();
    } catch {
      cloudAuth = 'unknown';
    }
    checks.cloudAuth = { status: cloudAuth };
    checks.printers = printerCounts(printerManager);
    checks.backup = backupCheck(backupService);

    // Not logged in / no printers online / last backup failed: still serving, so 200 + degraded.
    const degraded = cloudAuth !== 'authenticated'
      || checks.printers.connected === 0
      || checks.backup.lastOk === false;
    res.json({ status: degraded ? 'degraded' : 'ok', checks });
  });

  return router;
}

/** GET /api/system, POST /api/system/backup — mount at /api/system, AFTER the admin guard. */
function createSystemRouter({ backupService = null, dataDir } = {}) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const db = getDb();
    const rowCounts = {};
    for (const table of COUNTED_TABLES) {
      rowCounts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    res.json({
      version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      dataDir,
      db: {
        path: DB_PATH,
        sizeBytes: fileSize(DB_PATH),
        walBytes: fileSize(`${DB_PATH}-wal`),
        rowCounts,
      },
      backup: backupService
        ? { schedule: backupService.getSchedule(), last: backupService.getLastResult() }
        : { schedule: { enabled: false }, last: null },
    });
  });

  router.post('/backup', async (req, res) => {
    if (!backupService) {
      audit(req, { action: 'system.backup', result: 'rejected', detail: { reason: 'backups_not_configured' } });
      return res.status(503).json({ error: 'backups_not_configured' });
    }
    const result = await backupService.runBackup();
    audit(req, {
      action: 'system.backup',
      result: result.ok ? 'ok' : 'error',
      detail: result.ok ? { file: result.path ? path.basename(result.path) : null, size: result.size ?? null } : { reason: 'backup_failed' },
    });
    res.status(result.ok ? 200 : 500).json(result);
  });

  return router;
}

module.exports = { createHealthRouter, createSystemRouter };
