'use strict';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const { getJobExportRows, EXPORT_COLUMNS } = require('../src/db/export');
const { csvCell } = require('../src/server/routes/export');

after(cleanup);

/** Minimal RFC 4180 parser (quoted fields, "" escapes, CRLF) for round-trip assertions. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvObjects(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  return { header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

const ids = {};

/** Insert a job at an absolute UTC start time. */
function seedJob(db, { deviceId, started, durationSec, endState, ended = true, withDuration = true, ...extra }) {
  const cols = {
    device_id: deviceId,
    task_id: extra.taskId ?? null,
    subtask_name: extra.subtaskName ?? 'part',
    gcode_file: extra.gcodeFile ?? null,
    started_at: started,
    end_state: endState ?? null,
    progress_pct: extra.progressPct ?? null,
    material: extra.material ?? null,
    material_color: extra.materialColor ?? null,
    duration_sec: ended && withDuration ? durationSec : null,
    pause_count: extra.pauseCount ?? 0,
    total_pause_sec: extra.pauseSec ?? 0,
    anomaly_count: extra.anomalies ?? 0,
    total_layers: extra.totalLayers ?? null,
    hms_codes: extra.hmsCodes ? JSON.stringify(extra.hmsCodes) : null,
  };
  const keys = Object.keys(cols);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO print_jobs (${keys.join(', ')}, ended_at)
    VALUES (${keys.map(() => '?').join(', ')}, CASE WHEN ? THEN datetime(?, ? || ' seconds') END)
  `).run(...keys.map((k) => cols[k]), ended ? 1 : 0, started, String(durationSec || 0));
  return Number(lastInsertRowid);
}

before(() => {
  const db = getDb();
  queries.upsertPrinter({ deviceId: 'P1', name: 'Alpha', model: 'X1C', nozzleDiameter: 0.4 });
  queries.upsertPrinter({ deviceId: 'P2', name: 'Beta, "the second"', model: 'P1S', nozzleDiameter: 0.4 });

  ids.finished = seedJob(db, {
    deviceId: 'P1', started: '2026-09-01 10:00:00', durationSec: 7200, endState: 'FINISH',
    taskId: 'T1', gcodeFile: 'plate_1.gcode', progressPct: 100, material: 'PLA', materialColor: 'FF0000FF',
    pauseCount: 2, pauseSec: 300.5, anomalies: 3, totalLayers: 250, hmsCodes: ['0300_0100_0001_0007', '0500_0200_0002_0001'],
  });
  ids.failed = seedJob(db, { deviceId: 'P1', started: '2026-09-02 10:00:00', durationSec: 1800, endState: 'FAILED', progressPct: 42.5, material: 'PETG' });
  ids.cancelled = seedJob(db, { deviceId: 'P2', started: '2026-09-03 10:00:00', durationSec: 600, endState: 'CANCELLED', subtaskName: 'Bracket, v2 "final"\nsecond line' });
  ids.legacyIdle = seedJob(db, { deviceId: 'P2', started: '2026-09-04 10:00:00', durationSec: 60, endState: 'IDLE', subtaskName: '=HYPERLINK("http://evil.example","x")' });
  ids.nullDuration = seedJob(db, { deviceId: 'P2', started: '2026-09-05 10:00:00', durationSec: 10800, endState: 'FINISH', withDuration: false, subtaskName: '+1' });
  ids.running = seedJob(db, { deviceId: 'P2', started: '2026-09-06 10:00:00', ended: false, subtaskName: '@x', taskId: '-cmd' });
  ids.old = seedJob(db, { deviceId: 'P1', started: '2025-01-15 08:00:00', durationSec: 100, endState: 'FAILED', subtaskName: '-2' });

  // Samples for the finished job (job_id index) incl. a negative reading (cold-bed sensor glitch).
  const ins = db.prepare('INSERT INTO samples (device_id, job_id, ts, nozzle_temp, bed_temp, layer_num) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('P1', ids.finished, '2026-09-01 10:10:00', 210, 60, 10);
  ins.run('P1', ids.finished, '2026-09-01 10:20:00', 220, 61, 120);
  ins.run('P1', ids.failed, '2026-09-02 10:10:00', 240, -3.5, 7);

  // Layer transitions beat samples for layer_count.
  db.prepare('INSERT INTO layer_transitions (device_id, job_id, layer_num, ts) VALUES (?, ?, ?, ?)').run('P1', ids.finished, 248, '2026-09-01 11:59:00');

  const ev = db.prepare('INSERT INTO events (device_id, job_id, ts, event_type, severity, code, message) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ev.run('P1', ids.finished, '2026-09-01 10:30:00', 'hms_error', 'error', '0300_0100_0001_0007', 'x');
  ev.run('P1', ids.finished, '2026-09-01 10:40:00', 'hms_error', 'error', '0500_0200_0002_0001', 'y');
  ev.run('P1', ids.finished, '2026-09-01 10:50:00', 'print_error', 'error', '0300_8003', 'z');
  ev.run('P1', ids.finished, '2026-09-01 10:55:00', 'state_change', 'info', null, 'not counted');
  ev.run('P1', ids.failed, '2026-09-02 10:20:00', 'print_error', 'error', '0300_8003', 'z');
});

// ─── Unit ───

test('csvCell quotes RFC 4180 specials and guards formulas, but not numbers', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('\rx'), "\"'\rx\"");
  assert.equal(csvCell('=A1,B1'), "\"'=A1,B1\"");
  assert.equal(csvCell(-3.5), '-3.5');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('plain'), 'plain');
});

test('getJobExportRows: duration fallback, outcomes, aggregates', () => {
  const { rows, truncated } = getJobExportRows({});
  assert.equal(truncated, false);
  assert.equal(rows.length, 7);
  const byId = Object.fromEntries(rows.map((r) => [r.job_id, r]));
  // Ordered oldest → newest
  assert.deepEqual(rows.map((r) => r.job_id), [ids.old, ids.finished, ids.failed, ids.cancelled, ids.legacyIdle, ids.nullDuration, ids.running]);
  assert.equal(byId[ids.nullDuration].duration_sec, 10800); // fallback: ended_at − started_at
  assert.equal(byId[ids.running].duration_sec, null);
  assert.equal(byId[ids.running].outcome, 'running');
  assert.equal(byId[ids.legacyIdle].outcome, 'cancelled');
  assert.equal(byId[ids.cancelled].outcome, 'cancelled');
  assert.equal(byId[ids.failed].outcome, 'failed');
  const f = byId[ids.finished];
  assert.equal(f.outcome, 'finished');
  assert.equal(f.started_at, '2026-09-01T10:00:00Z');
  assert.equal(f.ended_at, '2026-09-01T12:00:00Z');
  assert.equal(f.layer_count, 248);
  assert.equal(f.hms_error_count, 2);
  assert.equal(f.print_error_count, 1);
  assert.equal(f.hms_codes, '0300_0100_0001_0007 0500_0200_0002_0001');
  assert.equal(f.sample_count, 2);
  assert.equal(f.nozzle_temp_avg, 215);
  assert.equal(f.nozzle_temp_max, 220);
  assert.equal(f.bed_temp_avg, 60.5);
  assert.equal(byId[ids.failed].layer_count, 7); // from samples (no layer_transitions)
  assert.equal(byId[ids.failed].bed_temp_max, -3.5);
  assert.equal(byId[ids.cancelled].sample_count, 0);
  assert.equal(byId[ids.cancelled].nozzle_temp_avg, null);
  assert.deepEqual(Object.keys(f), EXPORT_COLUMNS.map((c) => c.name));
});

// ─── API ───

test('GET /api/export/jobs requires the admin token', async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/export/jobs`)).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/api/export/jobs?format=json`)).status, 401);
    const res = await fetch(`${srv.baseUrl}/api/export/jobs`, { headers: authHeaders });
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test('CSV: BOM, header, row values, quoting and formula-injection guard', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/export/jobs?format=csv`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="bambuzle-jobs-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(res.headers.get('x-bambuzle-truncated'), null);
    assert.equal(res.headers.get('x-bambuzle-export-schema'), '3');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
    const text = buf.toString('utf8');
    if (process.env.EXPORT_DUMP) console.log(text);
    assert.ok(text.endsWith('\r\n'));

    const { header, rows } = csvObjects(text);
    assert.deepEqual(header, EXPORT_COLUMNS.map((c) => c.name));
    assert.equal(rows.length, 7);
    const byId = Object.fromEntries(rows.map((r) => [Number(r.job_id), r]));

    const f = byId[ids.finished];
    assert.equal(f.device_id, 'P1');
    assert.equal(f.printer_name, 'Alpha');
    assert.equal(f.printer_model, 'X1C');
    assert.equal(f.task_id, 'T1');
    assert.equal(f.gcode_file, 'plate_1.gcode');
    assert.equal(f.started_at, '2026-09-01T10:00:00Z');
    assert.equal(f.ended_at, '2026-09-01T12:00:00Z');
    assert.equal(f.end_state, 'FINISH');
    assert.equal(f.outcome, 'finished');
    assert.equal(f.duration_sec, '7200');
    assert.equal(f.progress_pct, '100');
    assert.equal(f.material, 'PLA');
    assert.equal(f.material_color, 'FF0000FF');
    assert.equal(f.pause_count, '2');
    assert.equal(f.pause_total_sec, '300.5');
    assert.equal(f.active_sec, '6900', 'BAM-51: 7200 s wall − 300.5 s paused, rounded');
    assert.equal(f.temp_anomaly_count, '3');
    assert.equal(f.total_layers, '250');
    assert.equal(f.layer_count, '248');
    assert.equal(f.hms_error_count, '2');
    assert.equal(f.print_error_count, '1');

    assert.equal(byId[ids.failed].outcome, 'failed');
    assert.equal(byId[ids.failed].progress_pct, '42.5');
    assert.equal(byId[ids.failed].bed_temp_max, '-3.5', 'negative number stays numeric (no quote prefix)');
    assert.equal(byId[ids.cancelled].outcome, 'cancelled');
    assert.equal(byId[ids.legacyIdle].outcome, 'cancelled');
    assert.equal(byId[ids.legacyIdle].end_state, 'IDLE');
    assert.equal(byId[ids.nullDuration].duration_sec, '10800');
    const r = byId[ids.running];
    assert.equal(r.outcome, 'running');
    assert.equal(r.ended_at, '');
    assert.equal(r.end_state, '');
    assert.equal(r.duration_sec, '');

    // Quoting round-trips commas, quotes and embedded newlines.
    assert.equal(byId[ids.cancelled].subtask_name, 'Bracket, v2 "final"\nsecond line');
    assert.equal(byId[ids.cancelled].printer_name, 'Beta, "the second"');
    assert.ok(text.includes('"Bracket, v2 ""final""\nsecond line"'));

    // Formula-injection guard on user-controlled strings.
    assert.equal(byId[ids.legacyIdle].subtask_name, `'=HYPERLINK("http://evil.example","x")`);
    assert.equal(byId[ids.nullDuration].subtask_name, "'+1");
    assert.equal(r.subtask_name, "'@x");
    assert.equal(r.task_id, "'-cmd");
    assert.equal(byId[ids.old].subtask_name, "'-2", 'numeric-looking text in a string column is still guarded');
  } finally {
    await srv.close();
  }
});

test('JSON: shape, schema_version, typed values', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/export/jobs?format=json`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.match(res.headers.get('content-disposition'), /filename="bambuzle-jobs-all-\d{4}-\d{2}-\d{2}\.json"/);
    const body = await res.json();
    assert.equal(body.schema_version, 3);
    assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(body.truncated, false);
    assert.equal(body.window.from, null);
    assert.match(body.window.to, /Z$/);
    assert.equal(body.window.printer, null);
    assert.deepEqual(body.columns.map((c) => c.name), EXPORT_COLUMNS.map((c) => c.name));
    assert.ok(body.columns.every((c) => ['string', 'integer', 'number'].includes(c.type)));
    assert.equal(body.jobs.length, 7);
    const f = body.jobs.find((j) => j.job_id === ids.finished);
    assert.equal(f.duration_sec, 7200);
    assert.equal(f.active_sec, 6900);
    assert.equal(f.subtask_name, 'part');
    // JSON is not formula-guarded: values are raw.
    const idle = body.jobs.find((j) => j.job_id === ids.legacyIdle);
    assert.equal(idle.subtask_name, '=HYPERLINK("http://evil.example","x")');
  } finally {
    await srv.close();
  }
});

test('window and printer filters', async () => {
  const srv = await startServer();
  try {
    const get = async (q) => (await (await fetch(`${srv.baseUrl}/api/export/jobs?format=json&${q}`, { headers: authHeaders })).json());
    const sept = await get('from=2026-09-01&to=2026-09-03');
    assert.deepEqual(sept.jobs.map((j) => j.job_id), [ids.finished, ids.failed, ids.cancelled]);
    assert.equal(sept.window.from, '2026-09-01T00:00:00Z');
    assert.equal(sept.window.to, '2026-09-03T23:59:59Z');

    const p1 = await get('printer=P1');
    assert.deepEqual(p1.jobs.map((j) => j.job_id), [ids.old, ids.finished, ids.failed]);
    assert.equal(p1.window.printer, 'P1');

    const p2sept = await get('printer=P2&from=2026-09-04T00:00:00Z');
    assert.deepEqual(p2sept.jobs.map((j) => j.job_id), [ids.legacyIdle, ids.nullDuration, ids.running]);

    const none = await get('printer=nope');
    assert.equal(none.jobs.length, 0);

    const csv = await fetch(`${srv.baseUrl}/api/export/jobs?from=2026-09-01&to=2026-09-03`, { headers: authHeaders });
    assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="bambuzle-jobs-2026-09-01-2026-09-03.csv"');
    assert.equal(csvObjects(await csv.text()).rows.length, 3);
  } finally {
    await srv.close();
  }
});

test('bad input → 400', async () => {
  const srv = await startServer();
  try {
    for (const q of ['from=garbage', 'to=2026-02-31', 'from=1700000000', 'to=yesterday', 'from=2026-10-01T25:00',
      'from=2026-10-02&to=2026-10-01', 'from=2026-10-01&from=2026-10-02', 'format=xlsx', 'format=csv&format=json',
      'printer=a&printer=b', `printer=${'x'.repeat(129)}`]) {
      const res = await fetch(`${srv.baseUrl}/api/export/jobs?${q}`, { headers: authHeaders });
      assert.equal(res.status, 400, q);
    }
  } finally {
    await srv.close();
  }
});

test('truncation keeps the newest rows and flags it', async () => {
  const srv = await startServer({ deps: { exportMaxRows: 3 } });
  try {
    const res = await fetch(`${srv.baseUrl}/api/export/jobs?format=json`, { headers: authHeaders });
    assert.equal(res.headers.get('x-bambuzle-truncated'), 'true');
    const body = await res.json();
    assert.equal(body.truncated, true);
    assert.deepEqual(body.jobs.map((j) => j.job_id), [ids.legacyIdle, ids.nullDuration, ids.running]);

    const csv = await fetch(`${srv.baseUrl}/api/export/jobs?format=csv`, { headers: authHeaders });
    assert.equal(csv.headers.get('x-bambuzle-truncated'), 'true');
    assert.equal(csvObjects(await csv.text()).rows.length, 3);

    // Exactly at the cap is not truncated.
    const exact = await fetch(`${srv.baseUrl}/api/export/jobs?format=json&printer=P1`, { headers: authHeaders });
    assert.equal(exact.headers.get('x-bambuzle-truncated'), null);
    assert.equal((await exact.json()).truncated, false);
  } finally {
    await srv.close();
  }
});
