'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const rollups = require('../src/db/rollups');

after(cleanup);

const NOW = Date.parse('2026-10-03T12:00:00Z');
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function seed(deviceId, startMs, count, stepSec, temp = (i) => 200 + (i % 10)) {
  const ins = getDb().prepare('INSERT INTO samples (device_id, ts, nozzle_temp, bed_temp, progress) VALUES (?, ?, ?, ?, ?)');
  getDb().transaction(() => {
    for (let i = 0; i < count; i++) ins.run(deviceId, sqlTs(startMs + i * stepSec * 1000), temp(i), 60, i % 100);
  })();
}

test('compaction rolls old raw samples into hourly averages and deletes them atomically; re-runs are no-ops', () => {
  queries.upsertPrinter({ deviceId: 'ROLL0001', name: 'R', model: 'X1C' });
  const old = NOW - 20 * 86400e3; // 20 days ago, older than rawDays=14
  seed('ROLL0001', old, 720, 5, () => 210); // one hour at 5 s, constant 210 °C
  seed('ROLL0001', NOW - 3600e3, 100, 5); // recent raw, must stay
  const r = rollups.compactSamples(14, NOW);
  assert.equal(r.deletedRaw, 720);
  assert.equal(r.rolledHours, 1);
  const hour = getDb().prepare("SELECT * FROM samples_hourly WHERE device_id = 'ROLL0001'").get();
  assert.equal(hour.n, 720);
  assert.equal(hour.nozzle_temp, 210);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM samples WHERE device_id = 'ROLL0001'").get().n, 100, 'recent raw kept');
  assert.deepEqual(rollups.compactSamples(14, NOW), { rolledHours: 0, deletedRaw: 0 }, 'idempotent');
});

test('late raw rows for an already-rolled hour merge weighted, not overwrite', () => {
  queries.upsertPrinter({ deviceId: 'ROLL0002', name: 'R2', model: 'X1C' });
  const old = Date.parse('2026-09-10T08:00:00Z');
  seed('ROLL0002', old, 10, 60, () => 100);
  rollups.compactSamples(14, NOW);
  seed('ROLL0002', old + 30 * 60e3, 30, 60, () => 200); // same hour, arrives later (e.g. restored backup)
  rollups.compactSamples(14, NOW);
  const hour = getDb().prepare("SELECT n, nozzle_temp FROM samples_hourly WHERE device_id = 'ROLL0002'").get();
  assert.equal(hour.n, 40);
  assert.equal(hour.nozzle_temp, 175); // (10×100 + 30×200) / 40
});

test('getHistory: busy windows are bucketed across the WHOLE range (the newest hours are no longer cut off)', () => {
  queries.upsertPrinter({ deviceId: 'ROLL0003', name: 'R3', model: 'X1C' });
  const start = NOW - 24 * 3600e3;
  seed('ROLL0003', start, 17280, 5); // 24 h at 5 s = 17,280 rows
  const h = rollups.getHistory('ROLL0003', { from: sqlTs(start), to: sqlTs(NOW), limit: 10000 }, { rawDays: 14, now: NOW });
  assert.ok(h.length <= 10000, `got ${h.length}`);
  const last = Date.parse(h.at(-1).ts.replace(' ', 'T') + 'Z');
  assert.ok(NOW - last < 15 * 60e3, `newest point should be near the end of the window, was ${(NOW - last) / 60e3} min before`);
  const first = Date.parse(h[0].ts.replace(' ', 'T') + 'Z');
  assert.ok(first - start < 15 * 60e3, 'and the start is still covered');
  assert.ok(h.every((r, i) => i === 0 || r.ts >= h[i - 1].ts), 'ascending');
});

test('getHistory: hourly rollups for the old part + raw for the recent part, in order', () => {
  const h = rollups.getHistory('ROLL0001', { from: sqlTs(NOW - 30 * 86400e3), to: sqlTs(NOW), limit: 5000 }, { rawDays: 14, now: NOW });
  assert.equal(h[0].rollup, 1);
  assert.equal(h[0].nozzle_temp, 210);
  assert.ok(h.slice(1).every((r) => !r.rollup), 'recent rows are raw');
  assert.equal(h.length, 1 + 100);
});

test('/history API uses the rollup-aware history', async () => {
  const srv = await startServer();
  try {
    const rows = await (await fetch(`${srv.baseUrl}/api/printers/ROLL0001/history?from=2020-01-01&limit=5000`, { headers: authHeaders })).json();
    assert.ok(rows.some((r) => r.rollup === 1), 'old part comes from hourly rollups');
    assert.ok(rows.some((r) => !r.rollup));
  } finally {
    await srv.close();
  }
});

test('old rollups are pruned', () => {
  getDb().prepare("INSERT INTO samples_hourly (device_id, hour, n, nozzle_temp) VALUES ('ROLL0001', '2020-01-01 00:00:00', 1, 1)").run();
  assert.ok(rollups.deleteOldRollups(365, NOW) >= 1);
});
