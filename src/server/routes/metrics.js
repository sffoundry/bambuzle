'use strict';

// BAM-37: Prometheus text exposition at GET /metrics (no client library needed).
// Auth: same admin token as the API (Prometheus: `authorization: { credentials: <token> }`),
// or open when BAMBUZLE_PUBLIC_READ=true / auth is off. Labels are limited to configured
// printers (device_id + name) so cardinality stays bounded — never task IDs or file names.

const express = require('express');
const fs = require('fs');
const path = require('path');
const queries = require('../../db/queries');

const { version } = require('../../../package.json');

const STATES = ['IDLE', 'PREPARE', 'RUNNING', 'PAUSE', 'FINISH', 'FAILED', 'UNKNOWN'];

function escapeLabel(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(obj) {
  const parts = Object.entries(obj).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** Collects samples grouped by metric so HELP/TYPE are emitted once per family. */
function createRegistry() {
  const families = new Map();
  return {
    add(name, help, type, value, lbls = {}) {
      if (value == null || Number.isNaN(value)) return;
      if (!families.has(name)) families.set(name, { help, type, samples: [] });
      families.get(name).samples.push(`${name}${labels(lbls)} ${Number(value)}`);
    },
    render() {
      const out = [];
      for (const [name, f] of families) {
        out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`, ...f.samples);
      }
      return out.join('\n') + '\n';
    },
  };
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.printerManager — getLiveStates(), isConnected(id), getLastMessageAt?(id)
 * @param {object} opts.adminAuth
 * @param {object|null} [opts.backupService]
 * @param {function} [opts.getCloudAuthStatus]
 * @param {string} [opts.dataDir]
 */
function createMetricsRouter({ printerManager, adminAuth, backupService = null, getCloudAuthStatus = () => 'unknown', dataDir }) {
  const router = express.Router();

  router.get('/metrics', (req, res) => {
    if (!adminAuth.isAuthorized(req) && !adminAuth.publicRead) {
      return res.status(401).type('text/plain').send('admin_auth_required\n');
    }

    const r = createRegistry();
    const now = Date.now();

    r.add('bambuzle_info', 'Bambuzle build info', 'gauge', 1, { version });
    r.add('bambuzle_uptime_seconds', 'Process uptime', 'gauge', Math.round(process.uptime()));
    r.add('bambuzle_cloud_authenticated', '1 if the server is logged into BambuLab Cloud', 'gauge',
      getCloudAuthStatus() === 'authenticated' ? 1 : 0);

    const live = printerManager.getLiveStates();
    const printers = queries.getAllPrinters();
    let connected = 0;

    for (const p of printers) {
      const id = p.device_id;
      const l = { printer: id, name: p.name || id };
      const s = live[id] || {};
      const isConn = printerManager.isConnected(id);
      if (isConn) connected++;

      r.add('bambuzle_printer_connected', '1 if the printer MQTT connection is up', 'gauge', isConn ? 1 : 0, l);
      const lastAt = printerManager.getLastMessageAt?.(id);
      if (lastAt) {
        r.add('bambuzle_printer_last_message_age_seconds', 'Seconds since the last MQTT report from the printer', 'gauge',
          Math.round((now - lastAt) / 1000), l);
      }
      for (const st of STATES) {
        r.add('bambuzle_printer_state', 'Current gcode state (1 for the active state)', 'gauge',
          (s.gcodeState || (isConn ? 'UNKNOWN' : null)) === st ? 1 : 0, { ...l, state: st });
      }
      r.add('bambuzle_printer_progress_percent', 'Print progress', 'gauge', s.progress, l);
      r.add('bambuzle_printer_remaining_minutes', 'Estimated remaining print time', 'gauge', s.remainingMin, l);
      r.add('bambuzle_printer_layer', 'Current layer', 'gauge', s.layerNum, l);
      for (const [sensor, temp, target] of [
        ['nozzle', s.nozzleTemp, s.nozzleTarget],
        ['nozzle2', s.nozzle2Temp, s.nozzle2Target],
        ['bed', s.bedTemp, s.bedTarget],
        ['chamber', s.chamberTemp, null],
      ]) {
        r.add('bambuzle_printer_temperature_celsius', 'Measured temperature', 'gauge', temp, { ...l, sensor });
        r.add('bambuzle_printer_target_temperature_celsius', 'Target temperature', 'gauge', target, { ...l, sensor });
      }
      for (const [fan, v] of [['part', s.partFanSpeed], ['aux', s.auxFanSpeed], ['chamber', s.chamberFanSpeed],
        ['heatbreak', s.diagnostics?.heatbreakFanSpeed]]) {
        r.add('bambuzle_printer_fan_percent', 'Fan speed', 'gauge', v, { ...l, fan });
      }
      r.add('bambuzle_printer_wifi_signal_dbm', 'Printer Wi-Fi signal', 'gauge', s.wifiSignal, l);
      r.add('bambuzle_printer_hms_active', 'Active HMS errors', 'gauge', Array.isArray(s.hmsErrors) ? s.hmsErrors.length : null, l);
      const pe = s.diagnostics?.printError;
      r.add('bambuzle_printer_print_error_active', '1 if the printer reports a print_error (user cancel excluded)', 'gauge',
        pe ? (pe.active ? 1 : 0) : null, l);
      const fw = s.diagnostics?.firmware;
      r.add('bambuzle_printer_firmware_update_available', '1 if the printer reports a firmware update', 'gauge',
        fw ? (fw.updateAvailable ? 1 : 0) : null, l);
    }

    r.add('bambuzle_printers_configured', 'Printers known to Bambuzle', 'gauge', printers.length);
    r.add('bambuzle_mqtt_connections', 'Open cloud MQTT connections (Bambu bans accounts above ~50)', 'gauge', connected);

    if (dataDir) {
      r.add('bambuzle_db_size_bytes', 'SQLite database file size', 'gauge', fileSize(path.join(dataDir, 'bambuzle.db')));
      r.add('bambuzle_db_wal_size_bytes', 'SQLite WAL file size', 'gauge', fileSize(path.join(dataDir, 'bambuzle.db-wal')));
    }

    if (backupService) {
      const last = backupService.getLastResult();
      r.add('bambuzle_backup_enabled', '1 if scheduled backups are enabled', 'gauge', backupService.getSchedule().enabled ? 1 : 0);
      if (last) {
        r.add('bambuzle_backup_last_timestamp_seconds', 'Time of the most recent backup', 'gauge', Math.round(Date.parse(last.time) / 1000));
        r.add('bambuzle_backup_last_ok', '1 ok, 0 failed (absent if not verified since restart)', 'gauge',
          last.ok == null ? null : (last.ok ? 1 : 0));
      }
    }

    res.type('text/plain; version=0.0.4; charset=utf-8').send(r.render());
  });

  return router;
}

module.exports = { createMetricsRouter };
