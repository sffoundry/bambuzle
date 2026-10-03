'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');
const { authHeaders, startServer, cleanup } = require('./helpers');
const store = require('../src/db/ams-humidity');
const queries = require('../src/db/queries');
const { AlertEngine } = require('../src/alerts/engine');

after(cleanup);

const T0 = Date.parse('2026-10-01T00:00:00Z');
const unit = (id, percent, index = 2) => ({ id, percent, index, temp: 27 });

test('records every 15 min, sooner on change, ignores sub-minute jitter', () => {
  store._resetThrottle();
  assert.equal(store.recordAmsHumidity('h1', [unit('0', 32), unit('1', 43)], T0), 2);
  assert.equal(store.recordAmsHumidity('h1', [unit('0', 32), unit('1', 43)], T0 + 5 * 60e3), 0, 'unchanged within interval');
  assert.equal(store.recordAmsHumidity('h1', [unit('0', 33), unit('1', 43)], T0 + 30e3), 0, 'change within a minute ignored');
  assert.equal(store.recordAmsHumidity('h1', [unit('0', 33), unit('1', 43)], T0 + 2 * 60e3), 1, 'change after a minute recorded');
  assert.equal(store.recordAmsHumidity('h1', [unit('0', 33), unit('1', 43)], T0 + 16 * 60e3), 1, 'unit 1 hit the interval');
  assert.equal(store.recordAmsHumidity('h1', [{ id: '2', percent: null, index: null }], T0), 0, 'no data, no row');
  assert.equal(store.recordAmsHumidity('h1', undefined, T0), 0);

  const hist = store.getAmsHumidityHistory('h1', { from: '2026-09-30 00:00:00' });
  assert.deepEqual(hist['0'].map((p) => p.pct), [32, 33]);
  assert.deepEqual(hist['1'].map((p) => p.pct), [43, 43]);
});

test('history API: auth, default 7-day window, bad dates', async () => {
  store._resetThrottle();
  store.recordAmsHumidity('h2', [unit('0', 40)], Date.now() - 2 * 86400e3);
  store._resetThrottle();
  store.recordAmsHumidity('h2', [unit('0', 41)], Date.now() - 30 * 86400e3);
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/printers/h2/ams-humidity`)).status, 401);
    const body = await (await fetch(`${srv.baseUrl}/api/printers/h2/ams-humidity`, { headers: authHeaders })).json();
    assert.deepEqual(body.units['0'].map((p) => p.pct), [40], '30-day-old point outside default window');
    const all = await (await fetch(`${srv.baseUrl}/api/printers/h2/ams-humidity?from=2020-01-01`, { headers: authHeaders })).json();
    assert.equal(all.units['0'].length, 2);
    assert.equal((await fetch(`${srv.baseUrl}/api/printers/h2/ams-humidity?from=nope`, { headers: authHeaders })).status, 400);
  } finally {
    await srv.close();
  }
});

test('retention cleanup removes old rows', () => {
  const before = store.getAmsHumidityHistory('h2', { from: '2020-01-01' })['0'].length;
  store.deleteOldAmsHumidity(7);
  assert.equal(store.getAmsHumidityHistory('h2', { from: '2020-01-01' })['0'].length, before - 1);
});

test('ams_humidity alert is edge-triggered per unit; level fallback for older AMS', async () => {
  const sent = [];
  const engine = new AlertEngine(pino({ level: 'silent' }), { notifiers: { console: { notify: async (a) => sent.push(a.message) } } });
  queries.upsertPrinter({ deviceId: 'h3', name: 'Gamma', model: 'H2D' });
  queries.createAlertRule({ name: 'Wet AMS', deviceId: 'h3', conditionType: 'ams_humidity', conditionConfig: { thresholdPct: 40 }, notifyVia: 'console', cooldownSec: 0 });
  const st = (units) => ({ gcodeState: 'IDLE', diagnostics: { amsHumidity: units } });

  engine.evaluate('h3', st([unit('0', 32), unit('1', 38)]), 'Gamma');
  engine.evaluate('h3', st([unit('0', 32), unit('1', 43)]), 'Gamma'); // unit 1 crosses
  engine.evaluate('h3', st([unit('0', 32), unit('1', 45)]), 'Gamma'); // still above → no repeat
  engine.evaluate('h3', st([unit('0', 32), unit('1', 30)]), 'Gamma'); // recovers
  engine.evaluate('h3', st([{ id: '0', percent: null, index: 1 }, unit('1', 30)]), 'Gamma'); // level fallback
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 2, JSON.stringify(sent));
  assert.equal(queries.getAlertRule(queries.getAllAlertRules().find((r) => r.name === "Wet AMS").id).cooldown_sec, 0, "cooldown 0 is kept, not defaulted to 300");
  assert.match(sent[0], /AMS 2 at 43% RH \(limit 40% RH\)/);
  assert.match(sent[1], /AMS 1 at level 1\/5/);
});

test('history cap keeps the NEWEST rows — review 2 #3', () => {
  const { getDb } = require('../src/db/database');
  store.getAmsHumidityHistory('cap', {}); // ensure table
  const ins = getDb().prepare("INSERT INTO ams_humidity_samples (device_id, ams_id, ts, humidity_pct) VALUES ('cap', '0', ?, ?)");
  const base = Date.parse('2026-01-01T00:00:00Z');
  getDb().transaction(() => {
    for (let i = 0; i < 20100; i++) ins.run(new Date(base + i * 60e3).toISOString().slice(0, 19).replace('T', ' '), i % 100);
  })();
  const series = store.getAmsHumidityHistory('cap', { from: '2025-01-01' })['0'];
  assert.equal(series.length, 20000);
  assert.equal(series.at(-1).ts, new Date(base + 20099 * 60e3).toISOString().slice(0, 19).replace('T', ' '), 'latest row present');
  assert.ok(series[0].ts < series.at(-1).ts, 'still oldest-first');
});

test('a unit crossing during another unit\'s cooldown still alerts after it; hysteresis stops flapping — review 2 #4', async () => {
  const sent = [];
  const engine = new AlertEngine(pino({ level: 'silent' }), { notifiers: { console: { notify: async (a) => sent.push(a.message) } } });
  queries.upsertPrinter({ deviceId: 'h4', name: 'Delta', model: 'H2D' });
  const id = queries.createAlertRule({ name: 'Wet AMS 2', deviceId: 'h4', conditionType: 'ams_humidity', conditionConfig: { thresholdPct: 40 }, notifyVia: 'console', cooldownSec: 300 });
  const st = (a, b) => ({ diagnostics: { amsHumidity: [unit('0', a), unit('1', b)] } });
  const flush = () => new Promise((r) => setImmediate(r));
  const expireCooldown = () => require('../src/db/database').getDb().prepare("UPDATE alert_rules SET last_fired_at = datetime('now', '-1 hour') WHERE id = ?").run(id);

  engine.evaluate('h4', st(30, 30), 'Delta');
  engine.evaluate('h4', st(41, 30), 'Delta'); // AMS 1 fires, cooldown starts
  await flush();
  engine.evaluate('h4', st(41, 42), 'Delta'); // AMS 2 crosses during cooldown → held
  await flush();
  assert.equal(sent.length, 1);
  expireCooldown();
  engine.evaluate('h4', st(41, 42), 'Delta'); // after cooldown: AMS 2 alerts now
  await flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /AMS 2 at 42% RH/);

  // Wobbling 39↔40 at the limit must not re-alert (re-arms only below 37%)
  for (const v of [39, 40, 39, 40]) { expireCooldown(); engine.evaluate('h4', st(v, 42), 'Delta'); }
  await flush();
  assert.equal(sent.length, 2);
  expireCooldown(); engine.evaluate('h4', st(35, 42), 'Delta'); // recovered
  expireCooldown(); engine.evaluate('h4', st(40, 42), 'Delta'); // crosses again → alerts
  await flush();
  assert.equal(sent.length, 3);
});
