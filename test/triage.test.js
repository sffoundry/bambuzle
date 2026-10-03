'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { triageJob, hmsLevel } = require('../src/printers/job-triage');
const queries = require('../src/db/queries');
const { getDb } = require('../src/db/database');

after(cleanup);

const t0 = Date.parse('2026-10-01T10:00:00Z');
const ts = (min) => new Date(t0 + min * 60e3).toISOString().slice(0, 19).replace('T', ' ');

test('hmsLevel from stored key', () => {
  assert.equal(hmsLevel('0300_0100_0001_0007'), 'fatal');
  assert.equal(hmsLevel('0700_2000_0002_0001'), 'serious');
  assert.equal(hmsLevel('0C00_0300_0003_0008'), 'common');
  assert.equal(hmsLevel('bogus'), 'unknown');
});

test('clean job', () => {
  const r = triageJob({ layers: [10, 11, 12].map((n) => ({ layer_num: n, duration_sec: 60, ts: ts(n) })) });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.reasons, []);
});

test('intervene: printer error, self-pause, serious HMS, anomaly burst; reasons explain why', () => {
  const r = triageJob({
    events: [{ ts: ts(5), event_type: 'hms_error', code: '0700_2000_0002_0001', message: 'AMS filament ran out' }],
    pauses: [{ paused_at: ts(5), resumed_at: ts(25), pause_source: 'error', layer_num: 40, hms_codes: '0700_2000_0002_0001' }],
  });
  assert.equal(r.verdict, 'intervene');
  assert.ok(r.reasons.some((x) => /serious HMS/.test(x)));
  assert.ok(r.reasons.some((x) => /paused itself at layer 40/.test(x)));
  assert.equal(r.clusters.length, 1, 'HMS + pause at the same minute form one incident');

  const burst = triageJob({ anomalies: [1, 3, 6].map((m) => ({ ts: ts(m), sensor: 'nozzle', anomaly_type: 'deviation', actual_temp: 180, target_temp: 220 })) });
  assert.equal(burst.verdict, 'intervene');
  const spread = triageJob({ anomalies: [1, 30, 60].map((m) => ({ ts: ts(m), sensor: 'nozzle', anomaly_type: 'deviation', actual_temp: 180 })) });
  assert.equal(spread.verdict, 'inspect', 'same count spread out is only worth a look');
});

test('inspect: user pause, slow layer; a user cancel is not "failed"', () => {
  const r = triageJob({
    pauses: [{ paused_at: ts(5), resumed_at: ts(7), pause_source: 'user', layer_num: 3 }],
    layers: [1, 2, 3, 4, 5, 6].map((n) => ({ layer_num: n, duration_sec: n === 4 ? 900 : 60, ts: ts(n) })),
    events: [{ ts: ts(9), event_type: 'state_change', message: 'State: RUNNING → FAILED (cancelled by user)' }],
  });
  assert.equal(r.verdict, 'inspect');
  assert.ok(r.reasons.some((x) => /layer 4 took 15 min/.test(x)));
  assert.ok(!r.reasons.some((x) => /FAILED/.test(x)));
  assert.deepEqual(r.timeline.map((i) => i.kind), ['stall', 'pause'], 'time-ordered; a user cancel adds no failure item');
});

test('triage API: per-job detail, recent verdicts, 404 for another printer\'s job', async () => {
  queries.upsertPrinter({ deviceId: 'TRI000001', name: 'T', model: 'X1C' });
  queries.upsertPrinter({ deviceId: 'TRI000002', name: 'U', model: 'X1C' });
  const jobId = queries.startJob({ deviceId: 'TRI000001', taskId: 't', subtaskName: 'part', gcodeFile: 'g' });
  queries.insertEvent({ deviceId: 'TRI000001', jobId, eventType: 'print_error', severity: 'error', code: '0300_400D', message: 'Print error 0300_400D' });
  queries.endJob(jobId, 'FAILED', 40);
  const srv = await startServer();
  const get = (u) => fetch(srv.baseUrl + u, { headers: authHeaders });
  try {
    const detail = await (await get(`/api/printers/TRI000001/jobs/${jobId}/triage`)).json();
    assert.equal(detail.verdict, 'intervene');
    assert.equal(detail.job.id, jobId);
    const recent = await (await get('/api/printers/TRI000001/triage')).json();
    assert.equal(recent[0].verdict, 'intervene');
    assert.equal((await get(`/api/printers/TRI000002/jobs/${jobId}/triage`)).status, 404);
    assert.equal((await get('/api/printers/TRI000001/jobs/abc/triage')).status, 400);
  } finally {
    await srv.close();
  }
});
