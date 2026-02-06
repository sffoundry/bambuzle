'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', '..', 'bambuzle.db');

let db = null;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS printers (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'Unknown',
      nozzle_diameter REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES printers(device_id),
      task_id TEXT,
      subtask_name TEXT,
      gcode_file TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_state TEXT,
      progress_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_device ON print_jobs(device_id, started_at);

    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES printers(device_id),
      job_id INTEGER REFERENCES print_jobs(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      bed_temp REAL,
      bed_target REAL,
      nozzle_temp REAL,
      nozzle_target REAL,
      chamber_temp REAL,
      part_fan_speed INTEGER,
      aux_fan_speed INTEGER,
      chamber_fan_speed INTEGER,
      progress REAL,
      layer_num INTEGER,
      total_layers INTEGER,
      remaining_min INTEGER,
      gcode_state TEXT,
      speed_level INTEGER,
      wifi_signal INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device_id, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_job ON samples(job_id);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES printers(device_id),
      job_id INTEGER REFERENCES print_jobs(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      code TEXT,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device_id, ts);

    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      device_id TEXT,
      condition_type TEXT NOT NULL,
      condition_config TEXT NOT NULL DEFAULT '{}',
      notify_via TEXT NOT NULL DEFAULT 'console',
      notify_config TEXT NOT NULL DEFAULT '{}',
      cooldown_sec INTEGER NOT NULL DEFAULT 300,
      last_fired_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
