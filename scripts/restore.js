#!/usr/bin/env node
'use strict';

// Restore bambuzle.db from a backup made by src/db/backup.js (BAM-34).
//
//   npm run backup:restore -- <backup-file>
//
// Stop the server first — this refuses to run while something is listening on the
// configured port. The backup is verified (integrity_check + .sha256 sidecar if present),
// the current bambuzle.db / -wal / -shm are moved aside to *.pre-restore-<ts>, and the
// backup is copied into place.

const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const { verifyIntegrity, sha256File, readSha256Sidecar } = require('../src/db/backup');

const DB_NAME = 'bambuzle.db';

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
}

/** Resolves true if something accepts TCP connections on host:port. */
function isPortInUse(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Verify `backupFile` and install it as <dataDir>/bambuzle.db.
 * Does NOT check whether the server is running — the CLI does that first.
 * @returns {{ dbPath: string, restoredFrom: string, sha256Verified: boolean, movedAside: string[] }}
 * @throws if the backup is missing, fails integrity_check, or mismatches its sidecar.
 */
function restoreBackup({ backupFile, dataDir, now = new Date() }) {
  const src = path.resolve(backupFile);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${src}`);

  const integrity = verifyIntegrity(src);
  if (!integrity.ok) throw new Error(`Backup failed integrity_check: ${integrity.detail}`);

  const expected = readSha256Sidecar(src);
  if (fs.existsSync(`${src}.sha256`) && !expected) throw new Error(`Unreadable sha256 sidecar: ${src}.sha256`);
  if (expected) {
    const actual = sha256File(src);
    if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DB_NAME);
  if (path.resolve(dbPath) === src) throw new Error('Backup file is the live database');

  // Fold any WAL into the current DB first so the moved-aside copy is self-contained.
  if (fs.existsSync(dbPath)) {
    try {
      const cur = new Database(dbPath, { fileMustExist: true });
      try { cur.pragma('wal_checkpoint(TRUNCATE)'); } finally { cur.close(); }
    } catch {
      // Current DB unreadable/corrupt — still move it (and its -wal/-shm) aside as-is.
    }
  }

  // Stage the copy next to the target so the final rename is atomic.
  const staged = `${dbPath}.restore-tmp`;
  fs.copyFileSync(src, staged);
  fs.chmodSync(staged, 0o600);

  const ts = timestamp(now);
  const movedAside = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) {
      const aside = `${file}.pre-restore-${ts}`;
      fs.renameSync(file, aside);
      movedAside.push(aside);
    }
  }
  fs.renameSync(staged, dbPath);

  return { dbPath, restoredFrom: src, sha256Verified: Boolean(expected), movedAside };
}

async function main(argv) {
  const backupFile = argv[0];
  if (!backupFile || backupFile === '-h' || backupFile === '--help') {
    console.error('Usage: npm run backup:restore -- <backup-file>');
    return 2;
  }

  const config = require('../src/config');
  const { port, host } = config.server;
  const probeHost = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  if (await isPortInUse(port, probeHost)) {
    console.error(`Refusing to restore: something is listening on ${probeHost}:${port}. Stop Bambuzle first.`);
    return 1;
  }

  try {
    const result = restoreBackup({ backupFile, dataDir: config.dataDir });
    console.log(`Restored ${result.dbPath}`);
    console.log(`  from:   ${result.restoredFrom} (integrity ok${result.sha256Verified ? ', sha256 ok' : ', no .sha256 sidecar'})`);
    for (const f of result.movedAside) console.log(`  moved aside: ${f}`);
    console.log('Start Bambuzle again to use the restored database.');
    return 0;
  } catch (err) {
    console.error(`Restore failed: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { restoreBackup, isPortInUse };
