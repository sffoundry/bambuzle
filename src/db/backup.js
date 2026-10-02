'use strict';

// SQLite online backups (BAM-34).
//
// Uses better-sqlite3's db.backup() (the SQLite online-backup API), which produces a
// consistent snapshot of a WAL-mode database while it is being written. Never copy the
// live bambuzle.db file directly — it can be torn and is missing whatever is still in -wal.
//
// Each backup is written to a .partial file, verified (opened read-only, PRAGMA
// integrity_check === 'ok'), given a sha256sum-compatible sidecar, then renamed into place
// as bambuzle-YYYYMMDD-HHMMSS.db (UTC). Older backups are pruned to `keep`.
//
// Backups contain the auth_tokens table (Bambu Cloud access token), so files are 0600.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Cron } = require('croner');

const BACKUP_RE = /^bambuzle-(\d{8})-(\d{6})(?:-(\d+))?\.db$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** bambuzle-YYYYMMDD-HHMMSS.db in UTC. */
function backupFilename(date = new Date()) {
  const d = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const t = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `bambuzle-${d}-${t}.db`;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Open read-only and run PRAGMA integrity_check. Returns { ok, detail }. */
function verifyIntegrity(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check', { simple: false });
    const detail = rows.map((r) => r.integrity_check).join('; ');
    return { ok: detail === 'ok', detail };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    if (db) db.close();
  }
}

/** Parse a `<hex>  <name>` sidecar. Returns the hex digest or null. */
function readSha256Sidecar(file) {
  try {
    const m = /^([0-9a-f]{64})\b/i.exec(fs.readFileSync(`${file}.sha256`, 'utf8').trim());
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Backup files in `dir`, newest first. */
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: BACKUP_RE.exec(name) }))
    .filter((e) => e.m)
    .map(({ name, m }) => ({ name, path: path.join(dir, name), key: `${m[1]}${m[2]}`, seq: Number(m[3] || 0) }))
    .sort((a, b) => (a.key === b.key ? b.seq - a.seq : a.key < b.key ? 1 : -1));
}

/** Delete all but the `keep` newest backups (and their sidecars). Returns removed file names. */
function pruneBackups(dir, keep) {
  const removed = [];
  for (const b of listBackups(dir).slice(Math.max(1, keep))) {
    fs.rmSync(b.path, { force: true });
    fs.rmSync(`${b.path}.sha256`, { force: true });
    removed.push(b.name);
  }
  return removed;
}

// Several backups in the same second get -1, -2… suffixes, always above any existing one for
// that second so the newest file also sorts newest (even after older ones were pruned).
// The backup inherits WAL mode from the live DB, which makes every later open (even
// read-only) create -wal/-shm files next to it. Switch the copy to a rollback journal so a
// backup is a single self-contained file. Bambuzle re-enables WAL when it opens a restored DB.
function toRollbackJournal(file) {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

function uniqueTarget(dir, date) {
  const name = backupFilename(date);
  const m = BACKUP_RE.exec(name);
  const sameSecond = listBackups(dir).filter((b) => b.key === `${m[1]}${m[2]}`);
  if (sameSecond.length === 0) return path.join(dir, name);
  const seq = Math.max(...sameSecond.map((b) => b.seq)) + 1;
  return path.join(dir, name.replace(/\.db$/, `-${seq}.db`));
}

/**
 * @param {object} opts
 * @param {() => import('better-sqlite3').Database} opts.getDb
 * @param {object} opts.backup — config.backup: { enabled, cron, dir, keep }
 * @param {object} [opts.log] — pino logger
 */
function createBackupService({ getDb, backup, log }) {
  const { enabled, cron, dir, keep } = backup;
  let job = null;
  let inFlight = null;
  let lastResult = seedFromDisk();

  // After a restart, report the newest backup on disk (not re-verified this process: ok=null).
  function seedFromDisk() {
    const newest = listBackups(dir)[0];
    if (!newest) return null;
    try {
      const st = fs.statSync(newest.path);
      return { ok: null, path: newest.path, time: st.mtime.toISOString(), size: st.size, source: 'disk' };
    } catch {
      return null;
    }
  }

  async function doBackup() {
    const started = new Date();
    const target = uniqueTarget(dir, started);
    const partial = `${target}.partial`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await getDb().backup(partial);
      fs.chmodSync(partial, 0o600);
      toRollbackJournal(partial);

      const integrity = verifyIntegrity(partial);
      if (!integrity.ok) throw new Error(`integrity_check failed: ${integrity.detail}`);

      const sha256 = sha256File(partial);
      fs.renameSync(partial, target);
      fs.writeFileSync(`${target}.sha256`, `${sha256}  ${path.basename(target)}\n`, { mode: 0o600 });

      const pruned = pruneBackups(dir, keep);
      const size = fs.statSync(target).size;
      lastResult = {
        ok: true,
        path: target,
        time: started.toISOString(),
        size,
        sha256,
        durationMs: Date.now() - started.getTime(),
        pruned: pruned.length,
      };
      log?.info({ path: target, size, pruned: pruned.length }, 'Database backup complete');
    } catch (err) {
      for (const f of [partial, `${partial}-wal`, `${partial}-shm`]) fs.rmSync(f, { force: true });
      lastResult = { ok: false, path: null, time: started.toISOString(), size: null, error: err.message };
      log?.error({ err: err.message }, 'Database backup failed');
    }
    return lastResult;
  }

  /** Run a backup now; concurrent callers share the in-flight run. Never rejects. */
  function runBackup() {
    if (!inFlight) inFlight = doBackup().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (!enabled || job) return;
    job = new Cron(cron, { protect: true }, () => runBackup());
    log?.info({ cron, dir, keep }, 'Database backups scheduled');
  }

  /** Stop the schedule and wait for any running backup (call before closeDb). */
  async function stop() {
    if (job) job.stop();
    job = null;
    if (inFlight) await inFlight;
  }

  function getLastResult() {
    return lastResult;
  }

  function getSchedule() {
    const next = job?.nextRun();
    return { enabled, cron, dir, keep, nextRun: next ? next.toISOString() : null };
  }

  return { runBackup, start, stop, getLastResult, getSchedule };
}

module.exports = {
  createBackupService,
  backupFilename,
  listBackups,
  pruneBackups,
  verifyIntegrity,
  sha256File,
  readSha256Sidecar,
};
