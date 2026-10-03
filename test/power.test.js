'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const pino = require('pino');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { parseReading, readPlug, validatePlug, PlugError } = require('../src/power/plug-readers');
const { createPowerMonitor } = require('../src/power/monitor');
const power = require('../src/db/power');
const queries = require('../src/db/queries');
const { getDb } = require('../src/db/database');
const users = require('../src/db/users');
const { AlertEngine } = require('../src/alerts/engine');
const { _resetForTests } = require('../src/server/routes/session');

after(cleanup);
const log = pino({ level: 'silent' });
const json = { 'Content-Type': 'application/json' };

test('readers parse each plug family', () => {
  assert.deepEqual(parseReading({ kind: 'shelly-gen2' }, { id: 0, apower: 231.4, aenergy: { total: 1520.25 } }), { watts: 231.4, totalWh: 1520.25 });
  assert.deepEqual(parseReading({ kind: 'shelly-gen1' }, { meters: [{ power: 88.2, total: 600 }] }), { watts: 88.2, totalWh: 10 });
  assert.deepEqual(parseReading({ kind: 'tasmota' }, { StatusSNS: { ENERGY: { Power: 145, Total: 2.5 } } }), { watts: 145, totalWh: 2500 });
  assert.equal(parseReading({ kind: 'tasmota', channel: 1 }, { StatusSNS: { ENERGY: { Power: [10, 20] } } }).watts, 20);
  assert.equal(parseReading({ kind: 'homeassistant' }, { state: '0.35', attributes: { unit_of_measurement: 'kW' } }).watts, 350);
  assert.equal(parseReading({ kind: 'homeassistant' }, { state: '120', attributes: { unit_of_measurement: 'W' } }).watts, 120);
  assert.throws(() => parseReading({ kind: 'homeassistant' }, { state: '40', attributes: { unit_of_measurement: '%' } }), PlugError);
  assert.equal(parseReading({ kind: 'http-json', jsonPath: 'data.0.w' }, { data: [{ w: 77 }] }).watts, 77);
  assert.throws(() => parseReading({ kind: 'shelly-gen2' }, { output: true }), /without a power reading/);
  assert.throws(() => parseReading({ kind: 'shelly-gen2' }, { apower: -5 }), /implausible/);
});

test('plug validation', () => {
  assert.deepEqual(validatePlug({ kind: 'shelly-gen2', url: 'http://10.0.0.20' }), []);
  assert.ok(validatePlug({ kind: 'shelly-gen2', url: 'file:///etc/passwd' }).length);
  assert.ok(validatePlug({ kind: 'nope', url: 'http://10.0.0.20' }).length);
  assert.ok(validatePlug({ kind: 'homeassistant', url: 'http://10.0.0.2:8123', entity: 'light.x' }).length);
  assert.deepEqual(validatePlug({ kind: 'homeassistant', url: 'http://10.0.0.2:8123', entity: 'sensor.printer_power' }), []);
  assert.ok(validatePlug({ kind: 'http-json', url: 'http://x', jsonPath: 'a[0]' }).length);
  assert.ok(validatePlug({ kind: 'shelly-gen2', url: 'http://x', channel: 99 }).length);
});

test('readPlug over HTTP: request path, HA bearer token, redirects/auth/non-JSON/oversize refused, nothing echoed', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url.startsWith('/rpc/Switch.GetStatus')) return res.end(JSON.stringify({ apower: 150.5, aenergy: { total: 10 } }));
    if (req.url.startsWith('/api/states/')) return res.end(JSON.stringify({ state: '200', attributes: { unit_of_measurement: 'W' } }));
    if (req.url === '/redirect/rpc/Switch.GetStatus?id=0') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
    if (req.url.startsWith('/auth/')) { res.writeHead(401); return res.end('secret page body'); }
    if (req.url.startsWith('/html/')) return res.end('<html>admin secret</html>');
    if (req.url.startsWith('/big/')) return res.end(JSON.stringify({ apower: 1, pad: 'x'.repeat(100000) }));
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await readPlug({ kind: 'shelly-gen2', url: base, channel: 1 })).watts, 150.5);
    assert.equal(seen.at(-1).url, '/rpc/Switch.GetStatus?id=1');
    assert.equal((await readPlug({ kind: 'homeassistant', url: base, entity: 'sensor.p', secret: 'hatoken' })).watts, 200);
    assert.equal(seen.at(-1).auth, 'Bearer hatoken');
    await assert.rejects(readPlug({ kind: 'shelly-gen2', url: `${base}/redirect` }), /redirect/);
    await assert.rejects(readPlug({ kind: 'shelly-gen2', url: `${base}/auth` }), (e) => /refused/.test(e.message) && !e.message.includes('secret'));
    await assert.rejects(readPlug({ kind: 'shelly-gen2', url: `${base}/html` }), (e) => /JSON/.test(e.message) && !e.message.includes('secret'));
    await assert.rejects(readPlug({ kind: 'shelly-gen2', url: `${base}/big` }), /too large/);
    await assert.rejects(readPlug({ kind: 'shelly-gen2', url: 'http://127.0.0.1:1' }), /Can't reach/);
  } finally {
    server.close();
  }
  await assert.rejects(readPlug({ kind: 'shelly-gen2', url: 'http://x' }, { fetchFn: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))), timeoutMs: 50 }), /No answer/);
});

test('monitor: per-minute buckets, trapezoid energy, gaps and failed reads are not integrated, circuits sum', async () => {
  queries.upsertPrinter({ deviceId: 'PWR000001', name: 'P1', model: 'X1C' });
  queries.upsertPrinter({ deviceId: 'PWR000002', name: 'P2', model: 'X1C' });
  power.setPlug('PWR000001', { kind: 'shelly-gen2', url: 'http://10.0.0.21', circuit: 'Garage' });
  power.setPlug('PWR000002', { kind: 'shelly-gen2', url: 'http://10.0.0.22', circuit: 'Garage' });
  power.setSettings({ circuits: [{ name: 'Garage', limitW: 300 }] });
  let t = Date.parse('2026-10-03T10:00:00Z');
  const watts = { PWR000001: 100, PWR000002: 250 };
  let fail = false;
  const mon = createPowerMonitor({ log, now: () => t, read: async (p) => { if (fail && p.deviceId === 'PWR000002') throw new PlugError('down'); return { watts: watts[p.deviceId] }; } });
  for (let i = 0; i < 4; i++) { await mon.pollOnce(); t += 15000; } // 10:00:00 .. 10:00:45 → 3 intervals of 15 s
  const c = mon.circuitStatus().find((x) => x.name === 'Garage');
  assert.deepEqual([c.watts, c.limitW, c.over], [350, 300, true]);
  assert.equal(mon.snapshot('PWR000001').circuitWatts, 350);
  let rows = getDb().prepare("SELECT * FROM power_samples WHERE device_id = 'PWR000001'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minute, '2026-10-03 10:00:00');
  assert.ok(Math.abs(rows[0].wh - 100 * 45 / 3600) < 1e-3, `wh ${rows[0].wh}`);
  // Next minute: a 5-minute gap is not integrated
  t += 5 * 60000;
  await mon.pollOnce();
  rows = getDb().prepare("SELECT * FROM power_samples WHERE device_id = 'PWR000001' ORDER BY minute").all();
  assert.equal(rows.at(-1).wh, 0);
  // A failed read is shown as such and leaves the circuit total without it
  fail = true;
  t += 15000;
  await mon.pollOnce();
  assert.equal(mon.snapshot('PWR000002').ok, false);
  assert.equal(mon.circuitStatus().find((x) => x.name === 'Garage').watts, 100);
  power.deletePlug('PWR000002');
  await mon.pollOnce();
  assert.equal(mon.snapshot('PWR000002'), null, 'removed plug drops out');
});

test('job energy and cost come from the minute samples inside the job window', () => {
  queries.upsertPrinter({ deviceId: 'PWR000003', name: 'P3', model: 'P1S' });
  power.setPlug('PWR000003', { kind: 'tasmota', url: 'http://10.0.0.23' });
  power.setSettings({ pricePerKwh: 0.3, currency: 'USD' });
  const jobId = queries.startJob({ deviceId: 'PWR000003', taskId: 't1', subtaskName: 'Benchy' });
  getDb().prepare("UPDATE print_jobs SET started_at = '2026-10-03 08:00:30', ended_at = '2026-10-03 09:00:10' WHERE id = ?").run(jobId);
  power.upsertMinute('PWR000003', '2026-10-03 07:59:00', { avgW: 5, maxW: 5, wh: 0.1 }); // before: excluded
  for (let m = 0; m <= 60; m++) {
    const mm = String(m % 60).padStart(2, '0');
    const hh = m === 60 ? '09' : '08';
    power.upsertMinute('PWR000003', `2026-10-03 ${hh}:${mm}:00`, { avgW: 120, maxW: 130, wh: 2 });
  }
  power.upsertMinute('PWR000003', '2026-10-03 09:01:00', { avgW: 5, maxW: 5, wh: 0.1 }); // after: excluded
  const r = power.recordJobEnergy(jobId);
  assert.equal(r.energyWh, 122); // 61 minute buckets 08:00 .. 09:00
  const job = getDb().prepare('SELECT energy_wh, energy_cost FROM print_jobs WHERE id = ?').get(jobId);
  assert.equal(job.energy_wh, 122);
  assert.equal(job.energy_cost, 0.0366);
  assert.equal(power.energyTotals(null).jobs >= 1, true);
});

test('alert rule power_limit: per-printer max, one alert per circuit, re-arms under 90%', () => {
  const sent = [];
  const engine = new AlertEngine(log, { notifiers: { console: { notify: async (m) => sent.push(m) } } });
  const rule = { id: 77, condition_type: 'power_limit' };
  const st = (watts, circuitWatts) => ({ power: { ok: true, watts, circuit: 'Garage', circuitWatts, circuitLimitW: 1500 } });
  const check = (devId, s, cfg = { maxWatts: 800 }) => engine._checkCondition({ ...rule, condition_config: cfg }, devId, s, {});
  assert.equal(check('A', st(500, 1000)), null);
  assert.match(check('A', st(900, 1000)).message, /Drawing 900 W/);
  assert.equal(check('A', st(900, 1000)), null, 'fires once');
  assert.equal(check('A', st(750, 1000)), null, 'still within hysteresis band');
  assert.equal(check('A', st(700, 1000)), null, 're-armed below 720');
  assert.ok(check('A', st(850, 1000)));
  assert.match(check('B', st(100, 1600), {}).message, /Circuit "Garage" at 1600 W/);
  assert.equal(check('C', st(100, 1600), {}), null, 'circuit alert is not repeated for another printer on it');
  assert.equal(check('A', { power: { ok: false } }), null);
  assert.equal(check('A', {}), null);
});

test('power API: roles, write-only secret, credentials hidden, secret only reused for the saved URL, audit clean', async () => {
  _resetForTests();
  queries.upsertPrinter({ deviceId: 'PWR000004', name: 'P4', model: 'A1' });
  const reads = [];
  const fakeRead = async (p) => { reads.push(p); return { watts: 42, totalWh: null }; };
  const mon = { snapshot: () => ({ ok: true, watts: 42, circuit: '' }), circuitStatus: () => [], pollOnce: async () => {} };
  await users.createUser({ username: 'pview', password: 'viewer password 1', role: 'viewer' });
  const srv = await startServer({ deps: { powerMonitor: mon, plugReader: fakeRead } });
  const base = srv.baseUrl;
  const call = (method, url, { body, headers = authHeaders } = {}) => fetch(base + url, { method, headers: { ...json, ...headers }, body: body && JSON.stringify(body) });
  try {
    const login = await fetch(`${base}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'pview', password: 'viewer password 1' }) });
    const viewer = { cookie: login.headers.get('set-cookie').split(';')[0] };

    let r = await call('PUT', '/api/printers/PWR000004/power-plug', { body: { kind: 'tasmota', url: 'http://admin:tpw@10.0.0.24', secret: 'tok-1', circuit: 'Office' } });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.plug.hasSecret, true);
    assert.equal(body.plug.secret, undefined);
    assert.ok(!body.plug.url.includes('tpw'), 'URL credentials are hidden');

    assert.equal((await call('GET', '/api/printers/PWR000004/power-plug', { headers: viewer })).status, 403);
    assert.equal((await call('PUT', '/api/power/settings', { headers: viewer, body: { pricePerKwh: 1 } })).status, 403);
    assert.equal((await call('GET', '/api/power', { headers: viewer })).status, 200);
    assert.equal((await call('GET', '/api/power/history/PWR000004', { headers: viewer })).status, 200);

    // Test with the saved plug → saved secret; a different URL → the saved secret is NOT sent
    assert.deepEqual(await (await call('POST', '/api/printers/PWR000004/power-plug/test')).json(), { ok: true, watts: 42, totalWh: null });
    assert.equal(reads.at(-1).secret, 'tok-1');
    await call('POST', '/api/printers/PWR000004/power-plug/test', { body: { kind: 'tasmota', url: 'http://10.0.0.99' } });
    assert.equal(reads.at(-1).secret, null);
    // Changing the URL without re-entering the secret clears it
    body = await (await call('PUT', '/api/printers/PWR000004/power-plug', { body: { kind: 'tasmota', url: 'http://10.0.0.25' } })).json();
    assert.equal(body.plug.hasSecret, false);

    assert.equal((await call('PUT', '/api/printers/PWR000004/power-plug', { body: { kind: 'tasmota', url: 'ftp://x' } })).status, 400);
    assert.equal((await call('PUT', '/api/printers/NOPE/power-plug', { body: { kind: 'tasmota', url: 'http://x' } })).status, 404);
    assert.equal((await call('PUT', '/api/power/settings', { body: { circuits: [{ name: 'A', limitW: 5 }] } })).status, 400);
    assert.equal((await call('PUT', '/api/power/settings', { body: { pricePerKwh: 'free' } })).status, 400);
    r = await call('PUT', '/api/power/settings', { body: { pricePerKwh: 0.25, currency: '€', circuits: [{ name: 'Office', limitW: 1800 }] } });
    assert.equal(r.status, 200);
    const all = await (await call('GET', '/api/power')).json();
    assert.equal(all.settings.pricePerKwh, 0.25);
    assert.ok(all.readings.PWR000004);

    const audit = JSON.stringify(await (await call('GET', '/api/audit?limit=100')).json());
    assert.ok(!audit.includes('tok-1') && !audit.includes('tpw'), 'no secrets or URL credentials in the audit trail');
    assert.ok(audit.includes('power.plug.update'));

    assert.equal((await call('DELETE', '/api/printers/PWR000004/power-plug')).status, 200);
    assert.equal((await call('DELETE', '/api/printers/PWR000004/power-plug')).status, 404);
  } finally {
    await srv.close();
    _resetForTests();
  }
});

test('monitor: a poll requested while one is running is not dropped (plug saved mid-poll)', async () => {
  queries.upsertPrinter({ deviceId: 'PWR000005', name: 'P5', model: 'A1' });
  power.setPlug('PWR000005', { kind: 'shelly-gen2', url: 'http://10.0.0.26' });
  let release;
  let calls = 0;
  const mon = createPowerMonitor({ log, read: async (p) => {
    if (p.deviceId !== 'PWR000005') return { watts: 1 }; // other tests' plugs
    calls++;
    if (calls === 1) await new Promise((r) => { release = r; });
    return { watts: 5 };
  } });
  const first = mon.pollOnce();
  await new Promise((r) => setImmediate(r));
  const second = mon.pollOnce(); // arrives while the first is still waiting on the plug
  release();
  await first;
  await second;
  assert.equal(calls, 2, 'the queued poll ran once the first finished');
  power.deletePlug('PWR000005');
});
