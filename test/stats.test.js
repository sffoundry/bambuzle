'use strict';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const { getActiveTrayMaterial } = require('../src/utils/material');

after(cleanup);

// ─── Tray helper ───

const sampleAms = {
  ams: [
    { id: '0', tray: [
      { id: '0', tray_type: 'PLA', tray_color: 'FF0000FF' },
      { id: '1', tray_type: 'PETG', tray_color: '00FF00FF' },
      { id: '2' },
      { id: '3', tray_type: 'ABS', tray_color: '000000FF' },
    ] },
    { id: '1', tray: [
      { id: '0', tray_type: 'TPU', tray_color: 'FFFFFFFF' },
    ] },
  ],
  tray_now: '1',
};

test('getActiveTrayMaterial resolves the active tray (global index = ams_id*4 + tray_id)', () => {
  assert.deepEqual(getActiveTrayMaterial(sampleAms), { material: 'PETG', color: '00FF00FF' });
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: '4' }), { material: 'TPU', color: 'FFFFFFFF' });
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: 3 }), { material: 'ABS', color: '000000FF' });
});

test('getActiveTrayMaterial returns nulls for 255 (none), 254 (external spool) and empty trays', () => {
  const none = { material: null, color: null };
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: '255' }), none);
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: '254' }), none);
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: '2' }), none);
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: '9' }), none);
  assert.deepEqual(getActiveTrayMaterial({ ...sampleAms, tray_now: undefined }), none);
});

test('getActiveTrayMaterial tolerates missing/malformed ams', () => {
  const none = { material: null, color: null };
  assert.deepEqual(getActiveTrayMaterial(null), none);
  assert.deepEqual(getActiveTrayMaterial(undefined), none);
  assert.deepEqual(getActiveTrayMaterial({}), none);
  assert.deepEqual(getActiveTrayMaterial({ tray_now: '0' }), none);
  assert.deepEqual(getActiveTrayMaterial({ ams: [{ id: '0' }], tray_now: '0' }), none);
});

// ─── Seed data ───

/** Insert a job `daysAgo` days back, lasting `hours`. duration null → historical row. */
function seedJob(db, { deviceId, daysAgo, hours, endState, material = null, withDuration = true }) {
  const started = `-${daysAgo} days`;
  const ended = endState ? `-${daysAgo} days` : null;
  db.prepare(`
    INSERT INTO print_jobs (device_id, subtask_name, started_at, ended_at, end_state, material, duration_sec)
    VALUES (?, 'part', datetime('now', ?, '-12 hours'),
      CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?, '-12 hours', ? || ' seconds') END,
      ?, ?, ?)
  `).run(deviceId, started, ended, started, String(Math.round(hours * 3600)), endState,
    material, endState && withDuration ? Math.round(hours * 3600) : null);
}

before(() => {
  const db = getDb();
  queries.upsertPrinter({ deviceId: 'P1', name: 'Alpha', model: 'X1C', nozzleDiameter: 0.4 });
  queries.upsertPrinter({ deviceId: 'P2', name: 'Beta', model: 'P1S', nozzleDiameter: 0.4 });

  // In the default 30-day window:
  seedJob(db, { deviceId: 'P1', daysAgo: 1, hours: 2, endState: 'FINISH', material: 'PLA' });
  seedJob(db, { deviceId: 'P1', daysAgo: 2, hours: 1, endState: 'FINISH', material: 'PLA' });
  seedJob(db, { deviceId: 'P1', daysAgo: 3, hours: 0.5, endState: 'FAILED', material: 'PETG' });
  seedJob(db, { deviceId: 'P2', daysAgo: 4, hours: 1.5, endState: 'IDLE', material: 'PETG' });
  // Historical row: no material, no duration_sec → duration from ended_at − started_at.
  seedJob(db, { deviceId: 'P2', daysAgo: 5, hours: 3, endState: 'FINISH', withDuration: false });
  // Currently running (no end).
  seedJob(db, { deviceId: 'P2', daysAgo: 0, hours: 0, endState: null, material: 'PLA' });
  // Outside the 30-day window:
  seedJob(db, { deviceId: 'P1', daysAgo: 60, hours: 10, endState: 'FAILED', material: 'ABS' });
});

// ─── Queries ───

test('startJob records material and endJob computes duration_sec', () => {
  const id = queries.startJob({ deviceId: 'P1', taskId: 't', subtaskName: 's', gcodeFile: 'g', material: 'ASA', materialColor: 'AABBCCFF' });
  getDb().prepare("UPDATE print_jobs SET started_at = datetime('now', '-90 seconds') WHERE id = ?").run(id);
  queries.endJob(id, 'FINISH', 100);
  const row = getDb().prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  assert.equal(row.material, 'ASA');
  assert.equal(row.material_color, 'AABBCCFF');
  assert.ok(row.duration_sec >= 89 && row.duration_sec <= 92, `duration_sec=${row.duration_sec}`);
  // Keep the seeded fixture clean for the aggregate assertions below.
  getDb().prepare('DELETE FROM print_jobs WHERE id = ?').run(id);
});

function windowDaysAgo(days) {
  return { from: new Date(Date.now() - days * 86400e3).toISOString(), to: new Date().toISOString() };
}

test('getJobStats overall counters, success rate, hours (with historical fallback)', () => {
  const { overall } = queries.getJobStats(windowDaysAgo(30));
  assert.equal(overall.jobs, 6);
  assert.equal(overall.finished, 3);
  assert.equal(overall.failed, 1);
  assert.equal(overall.cancelled, 1);
  assert.equal(overall.running, 1);
  assert.equal(overall.successRate, 0.6);
  // 2 + 1 + 0.5 + 1.5 + 3 (historical, from timestamps) = 8 hours
  assert.equal(overall.totalPrintHours, 8);
  assert.equal(overall.avgDurationMin, 96); // 480 min / 5 ended jobs
});

test('getJobStats byMaterial groups unknown materials and computes hours', () => {
  const { byMaterial } = queries.getJobStats(windowDaysAgo(30));
  const m = Object.fromEntries(byMaterial.map((r) => [r.material, r]));
  assert.deepEqual(Object.keys(m).sort(), ['PETG', 'PLA', 'Unknown']);
  assert.equal(m.PLA.jobs, 3);
  assert.equal(m.PLA.finished, 2);
  assert.equal(m.PLA.running, 1);
  assert.equal(m.PLA.totalPrintHours, 3);
  assert.equal(m.PLA.successRate, 1);
  assert.equal(m.PETG.failed, 1);
  assert.equal(m.PETG.cancelled, 1);
  assert.equal(m.PETG.successRate, 0);
  assert.equal(m.Unknown.totalPrintHours, 3);
});

test('getJobStats byPrinter, byDay and window/device filtering', () => {
  const s30 = queries.getJobStats(windowDaysAgo(30));
  const p = Object.fromEntries(s30.byPrinter.map((r) => [r.deviceId, r]));
  assert.equal(p.P1.name, 'Alpha');
  assert.equal(p.P1.jobs, 3);
  assert.equal(p.P2.jobs, 3);
  assert.equal(p.P2.cancelled, 1);
  assert.equal(s30.byDay.reduce((n, d) => n + d.finished + d.failed + d.cancelled, 0), 5);
  assert.ok(s30.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));

  const s90 = queries.getJobStats(windowDaysAgo(90));
  assert.equal(s90.overall.jobs, 7);
  assert.equal(s90.overall.failed, 2);
  assert.ok(s90.byMaterial.some((r) => r.material === 'ABS'));

  const p1 = queries.getJobStats({ deviceId: 'P1', ...windowDaysAgo(30) });
  assert.equal(p1.overall.jobs, 3);
  assert.equal(p1.byPrinter.length, 1);

  const empty = queries.getJobStats({ deviceId: 'nope' });
  assert.equal(empty.overall.jobs, 0);
  assert.equal(empty.overall.successRate, null);
  assert.equal(empty.overall.avgDurationMin, null);
  assert.equal(empty.overall.totalPrintHours, 0);
});

// ─── API ───

test('GET /api/stats requires the admin token', async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/stats`)).status, 401);
    const res = await fetch(`${srv.baseUrl}/api/stats`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.overall.jobs, 6); // default window = last 30 days
    assert.equal(body.overall.successRate, 0.6);
    assert.ok(body.window.from && body.window.to);
    assert.ok(Array.isArray(body.byPrinter) && Array.isArray(body.byMaterial) && Array.isArray(body.byDay));
    if (process.env.STATS_DUMP) console.log(JSON.stringify(body, null, 2));
  } finally {
    await srv.close();
  }
});

test('GET /api/stats honours printer and from/to', async () => {
  const srv = await startServer();
  try {
    const from = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
    const all = await (await fetch(`${srv.baseUrl}/api/stats?from=${from}`, { headers: authHeaders })).json();
    assert.equal(all.overall.jobs, 7);
    const p1 = await (await fetch(`${srv.baseUrl}/api/stats?printer=P1&from=${from}`, { headers: authHeaders })).json();
    assert.equal(p1.overall.jobs, 4);
    assert.equal(p1.window.printer, 'P1');
  } finally {
    await srv.close();
  }
});

test('GET /api/stats rejects bad dates with 400', async () => {
  const srv = await startServer();
  try {
    for (const q of ['from=garbage', 'to=2026-02-31', 'from=1700000000', 'to=yesterday', 'from=2026-10-01T25:00',
      'from=2026-10-02&to=2026-10-01', 'from=2026-10-01&from=2026-10-02']) {
      const res = await fetch(`${srv.baseUrl}/api/stats?${q}`, { headers: authHeaders });
      assert.equal(res.status, 400, q);
    }
  } finally {
    await srv.close();
  }
});

test('BAM-51: print hours exclude recorded pause time; a pause longer than the job floors at 0', () => {
  const q = require('../src/db/queries');
  const { getDb } = require('../src/db/database');
  q.upsertPrinter({ deviceId: 'PAUSE0001', name: 'Paused', model: 'X1C' });
  const ins = getDb().prepare(`INSERT INTO print_jobs (device_id, started_at, ended_at, end_state, duration_sec, total_pause_sec)
    VALUES ('PAUSE0001', datetime('now','-3 hours'), datetime('now','-1 hours'), 'FINISH', 7200, ?)`);
  ins.run(3600); // 2 h wall, 1 h paused → 1 h active
  ins.run(99999); // bogus pause longer than the job → 0, never negative
  const { overall } = q.getJobStats({ deviceId: 'PAUSE0001' });
  assert.equal(overall.totalPrintHours, 1);
});
