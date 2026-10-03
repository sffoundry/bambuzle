'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const maintenance = require('../src/db/maintenance');

after(cleanup);

const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

function near(actual, expected, tol = 0.02, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ~${expected}, got ${actual}`);
}

/** Insert a job that started `hoursAgo` hours back and ran `hours` hours. */
function seedJob(deviceId, { hoursAgo, hours, withDuration = true, running = false }) {
  getDb().prepare(`
    INSERT INTO print_jobs (device_id, subtask_name, started_at, ended_at, end_state, duration_sec)
    VALUES (?, 'part', datetime('now', ?), CASE WHEN ? THEN NULL ELSE datetime('now', ?) END, ?, ?)
  `).run(deviceId, `-${hoursAgo * 3600} seconds`, running ? 1 : 0, `-${(hoursAgo - hours) * 3600} seconds`,
    running ? null : 'FINISH', !running && withDuration ? Math.round(hours * 3600) : null);
}

function setLastDone(taskId, sqlModifier) {
  getDb().prepare("UPDATE maintenance_tasks SET last_done_at = datetime('now', ?) WHERE id = ?").run(sqlModifier, taskId);
}

function insertEvent(deviceId, type, code, sqlModifier = '-1 hours') {
  getDb().prepare(`INSERT INTO events (device_id, ts, event_type, severity, code, message)
    VALUES (?, datetime('now', ?), ?, 'error', ?, 'x')`).run(deviceId, sqlModifier, type, code);
}

before(() => {
  getDb();
  queries.upsertPrinter({ deviceId: 'M1', name: 'Mech', model: 'X1C', nozzleDiameter: 0.4 });
  queries.upsertPrinter({ deviceId: 'M2', name: 'Empty', model: 'A1', nozzleDiameter: 0.4 });
  queries.upsertPrinter({ deviceId: 'M3', name: 'Errors', model: 'P1S', nozzleDiameter: 0.4 });
  // M1: 4 h job 240 h ago (duration_sec set), 2 h job 120 h ago (historical: duration from timestamps),
  // plus a running job that must not count. Total = 6 h.
  seedJob('M1', { hoursAgo: 240, hours: 4 });
  seedJob('M1', { hoursAgo: 120, hours: 2, withDuration: false });
  seedJob('M1', { hoursAgo: 1, hours: 0, running: true });
});

// ─── Hours ───

test('print hours: total excludes running jobs and falls back to ended_at − started_at', () => {
  const { totalSec, firstJobAt } = maintenance.getPrinterHours('M1');
  near(totalSec / 3600, 6, 0.01);
  assert.ok(firstJobAt);
  assert.equal(maintenance.getPrinterHours('M2').totalSec, 0);
});

test('hours since baseline: null-duration job counted via timestamps, straddling job clipped', () => {
  const since = (mod) => maintenance.getPrintSecondsSince('M1',
    getDb().prepare("SELECT datetime('now', ?) AS t").get(mod).t) / 3600;
  near(since('-168 hours'), 2, 0.01, 'only the historical 2 h job');
  near(since('-239 hours'), 5, 0.01, '3 h of the straddling job + 2 h');
  near(since('-1000 hours'), 6, 0.01);
  near(since('-1 hours'), 0, 0.01, 'running job excluded');
});

// ─── Due logic ───

test('computeStatus: hours and days thresholds, due soon at 90%', () => {
  const s = (o) => maintenance.computeStatus({ hoursSince: 0, daysSince: 0, intervalHours: null, intervalDays: null, ...o }).status;
  assert.equal(s({ hoursSince: 50, intervalHours: 100 }), 'ok');
  assert.equal(s({ hoursSince: 90, intervalHours: 100 }), 'due_soon');
  assert.equal(s({ hoursSince: 100, intervalHours: 100 }), 'due');
  assert.equal(s({ daysSince: 6, intervalDays: 30 }), 'ok');
  assert.equal(s({ daysSince: 27, intervalDays: 30 }), 'due_soon');
  assert.equal(s({ daysSince: 31, intervalDays: 30 }), 'due');
  // Either interval can trigger.
  assert.equal(s({ hoursSince: 1, intervalHours: 100, daysSince: 31, intervalDays: 30 }), 'due');
  assert.equal(s({ hoursSince: 95, intervalHours: 100, daysSince: 1, intervalDays: 30 }), 'due_soon');
  assert.equal(s({}), 'unscheduled');
});

test('task status from real data: hours and days', () => {
  const mk = (name, o, mod) => {
    const id = maintenance.createTask({ deviceId: 'M1', name, ...o });
    setLastDone(id, mod);
    return maintenance.getTask(id);
  };
  // 2 print hours since 7 days ago.
  // Off the exact boundary: a clock tick between seeding and setLastDone can clip a few ms of hours
  assert.equal(mk('h-due', { intervalHours: 1.9 }, '-168 hours').status, 'due');
  assert.equal(mk('h-soon', { intervalHours: 2.2 }, '-168 hours').status, 'due_soon');
  assert.equal(mk('h-ok', { intervalHours: 10 }, '-168 hours').status, 'ok');
  assert.equal(mk('d-due', { intervalDays: 7 }, '-8 days').status, 'due');
  assert.equal(mk('d-soon', { intervalDays: 10 }, '-9 days').status, 'due_soon');
  const ok = mk('d-ok', { intervalDays: 30 }, '-3 days');
  assert.equal(ok.status, 'ok');
  near(ok.daysSince, 3, 0.01);
  near(ok.daysRemaining, 27, 0.01);
  getDb().prepare("DELETE FROM maintenance_tasks WHERE name LIKE 'h-%' OR name LIKE 'd-%'").run();
});

test('never-done tasks count from the first job, else from creation', () => {
  const a = maintenance.getTask(maintenance.createTask({ deviceId: 'M1', name: 'never', intervalHours: 5 }));
  assert.equal(a.baselineSource, 'first_job');
  near(a.hoursSince, 6, 0.01);
  assert.equal(a.status, 'due');
  near(a.daysSince, 10, 0.01);

  const b = maintenance.getTask(maintenance.createTask({ deviceId: 'M2', name: 'never', intervalDays: 1 }));
  assert.equal(b.baselineSource, 'created');
  assert.equal(b.hoursSince, 0);
  assert.ok(b.daysSince < 0.01);
  assert.equal(b.status, 'ok');
  getDb().prepare("DELETE FROM maintenance_tasks WHERE name = 'never'").run();
});

// ─── API ───

test('auth: maintenance endpoints return 401 without the admin token', async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance`)).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/M1`)).status, 401);
    const res = await fetch(`${srv.baseUrl}/api/maintenance/M1/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', intervalDays: 1 }),
    });
    assert.equal(res.status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/tasks/1`, { method: 'DELETE' })).status, 401);
  } finally {
    await srv.close();
  }
});

test('validation: bad names / intervals → 400, unknown printer / task → 404', async () => {
  const srv = await startServer();
  const post = (body, dev = 'M1') => fetch(`${srv.baseUrl}/api/maintenance/${dev}/tasks`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
  });
  try {
    for (const body of [
      {},
      { name: '', intervalDays: 7 },
      { name: '   ', intervalDays: 7 },
      { name: 'x'.repeat(101), intervalDays: 7 },
      { name: 42, intervalDays: 7 },
      { name: 'no interval' },
      { name: 'both null', intervalHours: null, intervalDays: null },
      { name: 'neg', intervalHours: -1 },
      { name: 'zero', intervalDays: 0 },
      { name: 'frac days', intervalDays: 1.5 },
      { name: 'nan', intervalHours: 'abc' },
      { name: 'future', intervalDays: 7, lastDoneAt: '2999-01-01' },
      { name: 'bad date', intervalDays: 7, lastDoneAt: 'yesterday' },
    ]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post({ name: 'x', intervalDays: 7 }, 'nope')).status, 404);

    const created = await post({ name: ' Lube rails ', intervalHours: 200, notes: 'n' });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal(task.name, 'Lube rails');
    assert.equal(task.intervalHours, 200);
    assert.equal(task.intervalDays, null);

    const put = (id, body) => fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body),
    });
    assert.equal((await put(task.id, { intervalHours: null })).status, 400, 'would leave no interval');
    assert.equal((await put(task.id, { name: '' })).status, 400);
    assert.equal((await put(task.id, { intervalDays: -3 })).status, 400);
    assert.equal((await put(999999, { name: 'x' })).status, 404);
    assert.equal((await put('abc', { name: 'x' })).status, 404);
    const updated = await (await put(task.id, { intervalHours: null, intervalDays: 14, name: 'Rails' })).json();
    assert.equal(updated.name, 'Rails');
    assert.equal(updated.intervalHours, null);
    assert.equal(updated.intervalDays, 14);

    const done = (id, body) => fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}/done`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
    });
    assert.equal((await done(task.id, { note: 'x'.repeat(501) })).status, 400);
    assert.equal((await done(999999, {})).status, 404);
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/nope`, { headers: authHeaders })).status, 404);
    await fetch(`${srv.baseUrl}/api/maintenance/tasks/${task.id}`, { method: 'DELETE', headers: authHeaders });
  } finally {
    await srv.close();
  }
});

test('mark done writes the log with current print hours and resets the counters', async () => {
  const srv = await startServer();
  try {
    const id = maintenance.createTask({ deviceId: 'M1', name: 'Nozzle', intervalHours: 4 });
    assert.equal(maintenance.getTask(id).status, 'due'); // 6 h since first job
    const res = await fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}/done`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ note: 'swapped 0.4 hardened' }),
    });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.equal(task.status, 'ok');
    assert.equal(task.hoursSince, 0);
    assert.equal(task.baselineSource, 'last_done');
    assert.ok(task.lastDoneAt);

    const log = getDb().prepare('SELECT * FROM maintenance_log WHERE task_id = ?').all(id);
    assert.equal(log.length, 1);
    near(log[0].print_hours_at, 6, 0.01);
    assert.equal(log[0].note, 'swapped 0.4 hardened');

    // Without a body at all.
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}/done`, { method: 'POST', headers: authHeaders })).status, 200);

    const detail = await (await fetch(`${srv.baseUrl}/api/maintenance/M1`, { headers: authHeaders })).json();
    assert.equal(detail.recentLog.length, 2);
    assert.equal(detail.recentLog[1].note, 'swapped 0.4 hardened');
    assert.equal(detail.recentLog[0].taskName, 'Nozzle');
    near(detail.totalPrintHours, 6, 0.01);
    maintenance.deleteTask(id);
  } finally {
    await srv.close();
  }
});

test('delete cascades to the maintenance log', async () => {
  const srv = await startServer();
  try {
    const id = maintenance.createTask({ deviceId: 'M1', name: 'Cascade', intervalDays: 7 });
    maintenance.markTaskDone(id, 'a');
    maintenance.markTaskDone(id, 'b');
    const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM maintenance_log WHERE task_id = ?').get(id).n;
    assert.equal(count(), 2);
    const res = await fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}`, { method: 'DELETE', headers: authHeaders });
    assert.equal(res.status, 200);
    assert.equal(count(), 0);
    assert.equal(maintenance.getTaskRow(id), undefined);
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/tasks/${id}`, { method: 'DELETE', headers: authHeaders })).status, 404);
  } finally {
    await srv.close();
  }
});

test('templates: offered when empty, added idempotently by name', async () => {
  const srv = await startServer();
  try {
    const before = await (await fetch(`${srv.baseUrl}/api/maintenance/M2`, { headers: authHeaders })).json();
    assert.equal(before.tasks.length, 0, 'never auto-created');
    assert.ok(before.templates.length >= 5);
    // Pre-existing task with a template name (different case) must not be duplicated.
    maintenance.createTask({ deviceId: 'M2', name: 'clean FANS', intervalDays: 3 });

    const url = `${srv.baseUrl}/api/maintenance/M2/templates`;
    const first = await fetch(url, { method: 'POST', headers: authHeaders });
    assert.equal(first.status, 201);
    const a = await first.json();
    assert.equal(a.added, maintenance.DEFAULT_TASKS.length - 1);
    assert.equal(a.tasks.length, maintenance.DEFAULT_TASKS.length);

    const second = await fetch(url, { method: 'POST', headers: authHeaders });
    assert.equal(second.status, 200);
    const b = await second.json();
    assert.equal(b.added, 0);
    assert.equal(b.tasks.length, maintenance.DEFAULT_TASKS.length);

    // Unverified intervals are null → "unscheduled" until the user sets one.
    const byName = Object.fromEntries(b.tasks.map((t) => [t.name, t]));
    assert.equal(byName['Clean build plate'].status, 'unscheduled');
    assert.equal(byName['Grease Z-axis lead screws'].intervalDays, 90);
    assert.equal((await fetch(`${srv.baseUrl}/api/maintenance/nope/templates`, { method: 'POST', headers: authHeaders })).status, 404);

    const summary = await (await fetch(`${srv.baseUrl}/api/maintenance`, { headers: authHeaders })).json();
    const m2 = summary.find((p) => p.deviceId === 'M2');
    assert.equal(m2.tasks, maintenance.DEFAULT_TASKS.length);
    assert.equal(m2.due + m2.dueSoon + m2.ok + m2.unscheduled, m2.tasks);
    assert.equal(m2.totalPrintHours, 0);
    assert.ok(summary.find((p) => p.deviceId === 'M1'));
  } finally {
    await srv.close();
  }
});

test('repeat errors: HMS grouped with dictionary text, print_error grouped, 30-day window', async () => {
  const HEATBED = '0300_0100_0001_0003'; // in the dictionary
  for (let i = 0; i < 3; i++) insertEvent('M3', 'hms_error', HEATBED, `-${i + 1} hours`);
  insertEvent('M3', 'hms_error', HEATBED, '-40 days'); // outside the window
  insertEvent('M3', 'hms_error', 'FFFF_FFFF_FFFF_FFFF');
  insertEvent('M3', 'print_error', '0300_8003', '-2 days');
  insertEvent('M3', 'print_error', '0300_8003', '-3 days');
  insertEvent('M3', 'print_error', '0500_4038');
  insertEvent('M1', 'hms_error', HEATBED); // other printer

  const r = maintenance.getRepeatErrors('M3');
  assert.equal(r.windowDays, 30);
  assert.equal(r.hms.length, 2);
  assert.equal(r.hms[0].code, HEATBED);
  assert.equal(r.hms[0].count, 3);
  assert.match(r.hms[0].description, /heatbed temperature is abnormal/i);
  assert.ok(r.hms[0].wikiUrl.startsWith('https://wiki.bambulab.com/'));
  assert.ok(r.hms[0].lastSeen > r.hms[0].firstSeen);
  assert.equal(r.hms[1].count, 1);
  assert.match(r.hms[1].description, /HMS error FFFF_FFFF_FFFF_FFFF/);
  assert.deepEqual(r.printErrors.map((e) => [e.code, e.count]), [['0300_8003', 2], ['0500_4038', 1]]);
  assert.equal(r.printErrors[0].description, undefined);

  const srv = await startServer();
  try {
    const detail = await (await fetch(`${srv.baseUrl}/api/maintenance/M3`, { headers: authHeaders })).json();
    assert.equal(detail.repeatErrors.hms[0].count, 3);
  } finally {
    await srv.close();
  }
});
