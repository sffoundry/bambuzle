'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { dataDir, authHeaders, fakePrinterManager, startServer, cleanup } = require('./helpers');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const {
  createBackupService, listBackups, pruneBackups, verifyIntegrity, sha256File, readSha256Sidecar, backupFilename,
} = require('../src/db/backup');
const { restoreBackup } = require('../scripts/restore');

after(cleanup);

const DEVICE_ID = 'SECRETDEV0001';
let tmpCounter = 0;
function tmpDir(name) {
  const dir = path.join(dataDir, `${name}-${++tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seed() {
  getDb();
  queries.upsertPrinter({ deviceId: DEVICE_ID, name: 'Secret Printer', model: 'X1C' });
  queries.insertEvent({ deviceId: DEVICE_ID, eventType: 'state_change', message: 'seeded-row' });
}

function makeService(dir, keep = 7) {
  return createBackupService({ getDb, backup: { enabled: true, cron: '30 3 * * *', dir, keep } });
}

test('/healthz and /readyz are public and leak no device details', async () => {
  seed();
  const pm = fakePrinterManager({ clients: { [DEVICE_ID]: { connected: true } } });
  const srv = await startServer({ printerManager: pm, deps: { getCloudAuthStatus: () => 'needs_login' } });
  try {
    const h = await fetch(`${srv.baseUrl}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { status: 'ok' });

    const r = await fetch(`${srv.baseUrl}/readyz`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes(DEVICE_ID), 'no device id');
    assert.ok(!text.includes('Secret Printer'), 'no printer name');
    const body = JSON.parse(text);
    assert.equal(body.status, 'degraded'); // never logged in to Bambu Cloud
    assert.equal(body.checks.db.ok, true);
    assert.equal(body.checks.cloudAuth.status, 'needs_login');
    assert.deepEqual(body.checks.printers, { configured: 1, connected: 1 });
  } finally {
    await srv.close();
  }
});

test('/readyz is ok when authenticated with printers connected', async () => {
  seed();
  const pm = fakePrinterManager({ clients: { [DEVICE_ID]: { connected: true } } });
  const srv = await startServer({ printerManager: pm, deps: { getCloudAuthStatus: () => 'authenticated' } });
  try {
    const body = await (await fetch(`${srv.baseUrl}/readyz`)).json();
    assert.equal(body.status, 'ok');
  } finally {
    await srv.close();
  }
});

test('/api/system requires the admin token', async () => {
  const backupService = makeService(tmpDir('sysbk'));
  const srv = await startServer({ deps: { backupService } });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/system`)).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/api/system/backup`, { method: 'POST' })).status, 401);

    const res = await fetch(`${srv.baseUrl}/api/system`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, require('../package.json').version);
    assert.equal(typeof body.uptimeSec, 'number');
    assert.ok(body.db.sizeBytes > 0);
    for (const t of ['samples', 'events', 'print_jobs']) assert.equal(typeof body.db.rowCounts[t], 'number');
    assert.equal(body.backup.schedule.cron, '30 3 * * *');

    const bk = await fetch(`${srv.baseUrl}/api/system/backup`, { method: 'POST', headers: authHeaders });
    assert.equal(bk.status, 200);
    const result = await bk.json();
    assert.equal(result.ok, true);
    const after = await (await fetch(`${srv.baseUrl}/api/system`, { headers: authHeaders })).json();
    assert.equal(after.backup.last.path, result.path);
  } finally {
    await srv.close();
  }
});

test('backup is a verified, consistent copy with a matching sha256', async () => {
  seed();
  const dir = tmpDir('bk');
  const svc = makeService(dir);
  const result = await svc.runBackup();
  assert.equal(result.ok, true, result.error);
  assert.match(path.basename(result.path), /^bambuzle-\d{8}-\d{6}(-\d+)?\.db$/);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.deepEqual(verifyIntegrity(result.path), { ok: true, detail: 'ok' });
  assert.equal(readSha256Sidecar(result.path), sha256File(result.path));
  assert.equal(result.sha256, sha256File(result.path));
  // Single self-contained file: no leftover .partial, -wal or -shm (even after verifying it)
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(result.path), `${path.basename(result.path)}.sha256`]);

  const copy = new Database(result.path, { readonly: true });
  try {
    const row = copy.prepare("SELECT COUNT(*) AS n FROM events WHERE message = 'seeded-row'").get();
    assert.ok(row.n >= 1);
  } finally {
    copy.close();
  }
  assert.deepEqual(svc.getLastResult(), result);
});

test('pruning keeps exactly N newest backups', async () => {
  const dir = tmpDir('prune');
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, backupFilename(new Date(base + i * 86400_000)));
    fs.writeFileSync(f, 'x');
    fs.writeFileSync(`${f}.sha256`, 'x');
  }
  fs.writeFileSync(path.join(dir, 'unrelated.db'), 'keep me');
  const removed = pruneBackups(dir, 3);
  assert.equal(removed.length, 3);
  const left = listBackups(dir).map((b) => b.name);
  assert.deepEqual(left, ['bambuzle-20260106-000000.db', 'bambuzle-20260105-000000.db', 'bambuzle-20260104-000000.db']);
  assert.ok(fs.existsSync(path.join(dir, 'unrelated.db')));
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.sha256')).length, 3);

  // And via the service, with real backups made in the same second.
  const svcDir = tmpDir('prune-svc');
  const svc = makeService(svcDir, 2);
  for (let i = 0; i < 4; i++) assert.equal((await svc.runBackup()).ok, true);
  assert.equal(listBackups(svcDir).length, 2);
});

test('restore installs the backup and moves the old DB aside', async () => {
  seed();
  const svc = makeService(tmpDir('rbk'));
  const backup = await svc.runBackup();
  assert.equal(backup.ok, true);

  // A separate "installation" whose current DB has different data (+ a WAL).
  const target = tmpDir('restore-target');
  const cur = new Database(path.join(target, 'bambuzle.db'));
  cur.pragma('journal_mode = WAL');
  cur.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('old')");
  cur.close();

  const now = new Date(Date.UTC(2026, 9, 2, 12, 0, 0));
  const result = restoreBackup({ backupFile: backup.path, dataDir: target, now });
  assert.equal(result.sha256Verified, true);
  const aside = path.join(target, 'bambuzle.db.pre-restore-20261002-120000');
  assert.ok(result.movedAside.includes(aside));

  const restored = new Database(path.join(target, 'bambuzle.db'), { readonly: true });
  try {
    assert.ok(restored.prepare("SELECT COUNT(*) AS n FROM events WHERE message = 'seeded-row'").get().n >= 1);
  } finally {
    restored.close();
  }
  const old = new Database(aside, { readonly: true });
  try {
    assert.equal(old.prepare('SELECT v FROM marker').get().v, 'old');
  } finally {
    old.close();
  }
});

test('restore refuses a corrupt backup or a sha256 mismatch', async () => {
  const svc = makeService(tmpDir('rbad'));
  const backup = await svc.runBackup();
  const target = tmpDir('restore-bad');
  fs.writeFileSync(path.join(target, 'bambuzle.db'), 'untouched');

  // sha256 mismatch (file intact, sidecar wrong)
  fs.writeFileSync(`${backup.path}.sha256`, `${'0'.repeat(64)}  ${path.basename(backup.path)}\n`);
  assert.throws(() => restoreBackup({ backupFile: backup.path, dataDir: target }), /sha256 mismatch/);

  // corrupt file
  const corrupt = path.join(target, 'corrupt.db');
  fs.writeFileSync(corrupt, Buffer.alloc(8192, 7));
  assert.throws(() => restoreBackup({ backupFile: corrupt, dataDir: target }), /integrity_check/);

  assert.equal(fs.readFileSync(path.join(target, 'bambuzle.db'), 'utf8'), 'untouched');
  assert.ok(!fs.readdirSync(target).some((f) => f.includes('pre-restore')));
});
