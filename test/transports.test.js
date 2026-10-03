'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { authHeaders, fakePrinterManager, startServer, cleanup } = require('./helpers');
const { buildConnectOptions, checkPrinterIdentity, MqttPrinterClient } = require('../src/bambu/mqtt-client');
const { chooseTransport, computeCapabilities, validHost, validAccessCode, validSerial } = require('../src/printers/transport-policy');
const { classifyError, probeLan } = require('../src/printers/lan-probe');
const conns = require('../src/db/printer-connections');
const queries = require('../src/db/queries');

after(cleanup);

test('CA bundle parses into all 8 Bambu CA certificates (regression: concatenation glued two)', () => {
  const pem = fs.readFileSync(path.join(__dirname, '..', 'src', 'bambu', 'certs', 'bambu-ca-bundle.pem'), 'utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  assert.equal(blocks.length, 8);
  const cns = blocks.map((b) => new crypto.X509Certificate(b).subject.match(/CN=([^\n]+)/)[1]);
  assert.ok(cns.includes('BBL CA'), 'root that X1C/H2D chain to (verified live 2026-10-03)');
  assert.ok(cns.includes('BBL CA2 RSA'));
});

test('LAN connect options: verified TLS 1.2 to :8883 as bblp, identity pinned to serial', () => {
  const { url, options } = buildConnectOptions({ kind: 'lan', deviceId: '01S00TEST000001', lan: { host: '10.0.0.93', accessCode: '12345678' } });
  assert.equal(url, 'mqtts://10.0.0.93:8883');
  assert.equal(options.username, 'bblp');
  assert.equal(options.password, '12345678');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.maxVersion, 'TLSv1.2');
  assert.match(options.ca, /BEGIN CERTIFICATE/);
  assert.equal(options.checkServerIdentity('10.0.0.93', { subject: { CN: '01S00TEST000001' } }), undefined);
  const err = options.checkServerIdentity('10.0.0.93', { subject: { CN: '01S00TEST000002' } });
  assert.equal(err.code, 'ERR_PRINTER_IDENTITY');
  assert.throws(() => buildConnectOptions({ kind: 'lan', deviceId: 'x', lan: { host: 'h' } }), /accessCode/);

  const off = buildConnectOptions({ kind: 'lan', deviceId: 'x', lan: { host: 'h', accessCode: '12345678' }, tlsVerify: false }).options;
  assert.equal(off.rejectUnauthorized, false);
  assert.equal(off.checkServerIdentity('h', { subject: { CN: 'other' } }), undefined);

  const cloud = buildConnectOptions({ kind: 'cloud', deviceId: 'x', token: 't', userId: '42' });
  assert.match(cloud.url, /^mqtts:\/\//);
  assert.equal(cloud.options.username, 'u_42');
  assert.equal(checkPrinterIdentity('abc', 'h', { subject: { CN: 'ABC' } }), undefined, 'case-insensitive');
});

test('transport choice and capability matrix', () => {
  const lanConn = { mode: 'auto', lanHost: '10.0.0.5', accessCode: '12345678' };
  const cloudConn = { mode: 'auto', lanHost: null, accessCode: null };
  assert.equal(chooseTransport(lanConn, false), 'lan', 'LAN works without a cloud login');
  assert.equal(chooseTransport(cloudConn, false), null);
  assert.equal(chooseTransport(cloudConn, true), 'cloud');
  assert.equal(chooseTransport({ ...lanConn, mode: 'cloud' }, true), 'cloud');
  assert.equal(chooseTransport({ ...cloudConn, mode: 'lan' }, true), null, 'lan mode without settings');

  const cap = (o) => computeCapabilities({ conn: lanConn, connected: true, ...o });
  assert.equal(cap({ transport: 'lan', developerMode: true }).control, 'available');
  assert.equal(cap({ transport: 'lan', developerMode: false }).control, 'signature_required');
  assert.match(cap({ transport: 'lan', developerMode: false }).controlHint, /Developer Mode/);
  assert.equal(cap({ transport: 'cloud', developerMode: false }).control, 'signature_required');
  assert.equal(cap({ transport: 'cloud', developerMode: null }).control, 'unknown');
  assert.equal(cap({ transport: 'cloud', developerMode: null, signatureRejected: true }).control, 'signature_required');
  assert.equal(cap({ transport: 'lan', developerMode: true, connected: false }).control, 'offline');
  assert.equal(computeCapabilities({ conn: cloudConn, transport: null }).controlHint, 'Log in to BambuLab Cloud, or configure a LAN connection');
});

test('input validation', () => {
  assert.ok(validHost('10.0.0.93') && validHost('printer.local'));
  for (const bad of ['1.2.3.999', 'http://x', 'a b', '-x.com', '', null]) assert.equal(validHost(bad), false, String(bad));
  assert.ok(validAccessCode('a1B2c3D4'));
  assert.equal(validAccessCode('1234567'), false);
  assert.ok(validSerial('01S00TEST000001'));
  assert.equal(validSerial('../etc'), false);
});

test('probe error classification (codes seen live on H2D/X1C)', () => {
  assert.equal(classifyError({ code: 5, message: 'Connection refused: Not authorized' }, 'h').stage, 'auth');
  assert.equal(classifyError({ code: 'ERR_PRINTER_IDENTITY', message: 'x' }, 'h').stage, 'identity');
  assert.equal(classifyError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }, 'h').stage, 'tls');
  assert.equal(classifyError({ code: 'EHOSTUNREACH' }, 'h').stage, 'unreachable');
});

test('probeLan reports Developer Mode from the first status report, without sending commands', async () => {
  const published = [];
  const connectFn = () => {
    const c = Object.assign(new EventEmitter(), { connected: true, subscribe: (t, o, cb) => cb(null), publish: (t, p) => published.push(JSON.parse(p)), end() {} });
    setImmediate(() => {
      c.emit('connect');
      setImmediate(() => c.emit('message', 'device/S1/report', Buffer.from(JSON.stringify({ print: { fun: '3EC18FFF9CFF', gcode_state: 'IDLE' } }))));
    });
    return c;
  };
  const r = await probeLan({ serial: 'S1234567', host: '10.0.0.5', accessCode: '12345678', connectFn, logger: require('pino')({ level: 'silent' }) });
  assert.deepEqual([r.ok, r.stage, r.developerMode], [true, 'connected', true]);
  assert.ok(published.every((m) => m.pushing?.command === 'pushall'), 'only the status request was sent');
});

test('connection API: secrets never returned, validation, manual printers, test endpoint', async () => {
  queries.upsertPrinter({ deviceId: 'CLOUD0001', name: 'Cloudy', model: 'X1C' });
  const reconnects = [];
  const pm = { ...fakePrinterManager(), reconnect: (id) => reconnects.push(id), getCapabilities: (id) => ({ control: 'offline', id }) };
  const srv = await startServer({ printerManager: pm, deps: { lanProbe: async (a) => ({ ok: true, stage: 'connected', echo: { host: a.host, hasCode: Boolean(a.accessCode) } }) } });
  const H = { 'Content-Type': 'application/json', ...authHeaders };
  const call = (method, url, body) => fetch(srv.baseUrl + url, { method, headers: H, body: body && JSON.stringify(body) });
  try {
    let r = await call('PUT', '/api/printers/CLOUD0001/connection', { mode: 'lan', lanHost: '192.168.1.50', accessCode: 'Ab12Cd34' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.connection, { mode: 'lan', lanHost: '192.168.1.50', hasAccessCode: true, source: 'cloud' });
    assert.ok(!JSON.stringify(body).includes('Ab12Cd34'));
    assert.deepEqual(reconnects, ['CLOUD0001']);

    const list = await (await call('GET', '/api/printers')).text();
    assert.ok(!list.includes('Ab12Cd34') && !list.includes('lan_access_code'), 'secret absent from printer list');
    assert.match(list, /"has_access_code":true/);

    for (const bad of [{ mode: 'wifi' }, { lanHost: 'http://evil' }, { accessCode: 'short' }]) {
      assert.equal((await call('PUT', '/api/printers/CLOUD0001/connection', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('PUT', '/api/printers/NOPE00000/connection', { mode: 'lan' })).status, 404);

    r = await call('POST', '/api/printers/CLOUD0001/connection/test', {});
    assert.deepEqual((await r.json()).echo, { host: '192.168.1.50', hasCode: true }, 'uses saved settings');

    r = await call('POST', '/api/printers', { serial: 'LANONLY01', name: 'Garage P1S', lanHost: '10.0.0.9', accessCode: '12345678' });
    assert.equal(r.status, 201);
    assert.equal((await call('POST', '/api/printers', { serial: 'LANONLY01', name: 'dup', lanHost: '10.0.0.9', accessCode: '12345678' })).status, 409);
    assert.equal((await call('POST', '/api/printers', { serial: '../x', name: 'n', lanHost: '10.0.0.9', accessCode: '12345678' })).status, 400);
    assert.equal(conns.getConnection('LANONLY01').source, 'manual');

    assert.equal((await call('DELETE', '/api/printers/CLOUD0001')).status, 404, 'cloud printers are not deletable');
    assert.equal((await call('DELETE', '/api/printers/LANONLY01')).status, 200);
    assert.equal(conns.getConnection('LANONLY01'), null);

    r = await fetch(`${srv.baseUrl}/api/printers/CLOUD0001/connection`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401, 'admin token required');
  } finally {
    await srv.close();
  }
});

test('MqttPrinterClient carries its transport kind', () => {
  const c = new MqttPrinterClient({ deviceId: 'S', kind: 'lan', lan: { host: 'h', accessCode: '12345678' } });
  assert.equal(c.kind, 'lan');
  assert.equal(new MqttPrinterClient({ deviceId: 'S', token: 't', userId: 'u' }).kind, 'cloud');
});

// ─── BAM-35 review fixes ───

test('LAN command route works without a cloud login; cloud printers still need one — review #3', async () => {
  const { createApp } = require('../src/server/app');
  const { createAdminAuth } = require('../src/server/admin-auth');
  const http = require('http');
  const pino = require('pino');
  const { dataDir, TEST_TOKEN } = require('./helpers');
  queries.upsertPrinter({ deviceId: 'LANCMD001', name: 'L', model: 'P1S' });
  const client = { connected: true, sendCommandAwaitReply: async (cmd) => ({ sent: true, acknowledged: true, result: 'success' }) };
  const mk = (kind) => ({
    ...fakePrinterManager({ liveStates: { LANCMD001: { gcodeState: 'RUNNING' } }, clients: { LANCMD001: client } }),
    getTransportKind: () => kind,
    getCapabilities: () => ({ control: kind === 'lan' ? 'available' : 'unknown' }),
  });
  for (const [kind, expected] of [['lan', 200], ['cloud', 503]]) {
    const adminAuth = createAdminAuth({ auth: { mode: 'on', adminToken: TEST_TOKEN }, dataDir, log: pino({ level: 'silent' }) });
    const app = createApp(mk(kind), { onAuthenticated() {} }, adminAuth, { getCloudAuthStatus: () => 'needs_login', dataDir });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/printers/LANCMD001/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify({ command: 'pause' }) });
      assert.equal(r.status, expected, kind);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

test('removing a hand-added printer with history soft-removes it; re-adding revives it; serials are case-insensitive — review #4/#5', async () => {
  const pm = { ...fakePrinterManager(), reconnect() {}, getCapabilities: () => null };
  const srv = await startServer({ printerManager: pm });
  const H = { 'Content-Type': 'application/json', ...authHeaders };
  const call = (method, url, body) => fetch(srv.baseUrl + url, { method, headers: H, body: body && JSON.stringify(body) });
  try {
    let r = await call('POST', '/api/printers', { serial: 'hist0000001', name: 'Hist', lanHost: '10.0.0.7', accessCode: '12345678' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).deviceId, 'HIST0000001', 'normalized to uppercase');
    assert.equal((await call('POST', '/api/printers', { serial: 'HIST0000001', name: 'dup', lanHost: '10.0.0.7', accessCode: '12345678' })).status, 409, 'case-variant duplicate refused');

    queries.insertEvent({ deviceId: 'HIST0000001', eventType: 'state_change', severity: 'info', message: 'x' });
    r = await call('DELETE', '/api/printers/HIST0000001');
    assert.equal(r.status, 200, 'no FK 500');
    assert.equal(conns.getConnection('HIST0000001').source, 'removed');
    assert.equal(conns.getConnection('HIST0000001').accessCode, null, 'secret cleared');
    assert.ok(!(await (await call('GET', '/api/printers')).text()).includes('HIST0000001'), 'hidden from the list');
    assert.equal(queries.getEvents('HIST0000001', { limit: 5 }).length, 1, 'history kept');

    r = await call('POST', '/api/printers', { serial: 'HIST0000001', name: 'Back', lanHost: '10.0.0.8', accessCode: '87654321' });
    assert.equal(r.status, 201, 'revived');
    assert.equal(conns.getConnection('HIST0000001').source, 'manual');
  } finally {
    await srv.close();
  }
});

test('connection test: saved code only goes to the saved host; live LAN session is reused — review #8/#9', async () => {
  queries.upsertPrinter({ deviceId: 'PROBE0001', name: 'P', model: 'X1C' });
  conns.setConnection('PROBE0001', { mode: 'lan', lanHost: '10.0.0.20', accessCode: 'SAVED123' });
  const probes = [];
  let live = false;
  const pm = { ...fakePrinterManager(), reconnect() {}, getTransportKind: () => (live ? 'lan' : null), isConnected: () => live, getCapabilities: () => ({ developerMode: true }) };
  const srv = await startServer({ printerManager: pm, deps: { lanProbe: async (a) => { probes.push(a); return { ok: true, stage: 'connected' }; } } });
  const H = { 'Content-Type': 'application/json', ...authHeaders };
  const test = (body) => fetch(`${srv.baseUrl}/api/printers/PROBE0001/connection/test`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  try {
    const r = await test({ lanHost: '10.9.9.9' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /saved code is only sent to the saved address/);
    assert.equal(probes.length, 0, 'saved code never sent to a new host');
    await test({ lanHost: '10.9.9.9', accessCode: 'TYPED123' });
    assert.deepEqual([probes[0].host, probes[0].accessCode], ['10.9.9.9', 'TYPED123']);
    live = true;
    const reuse = await (await test({})).json();
    assert.equal(reuse.message, 'Connected (live session)');
    assert.equal(probes.length, 1, 'no second LAN session opened');
  } finally {
    await srv.close();
  }
});

test('LAN client stops reconnecting after a refused access code or wrong printer — review #10', async () => {
  const { isFatalLanError } = require('../src/bambu/mqtt-client');
  assert.ok(isFatalLanError({ code: 5 }) && isFatalLanError({ code: 'ERR_PRINTER_IDENTITY' }));
  assert.equal(isFatalLanError({ code: 'ECONNREFUSED' }), false, 'transient errors keep retrying');
  let ended = false;
  const fake = Object.assign(new EventEmitter(), { end: () => { ended = true; } });
  const c = new MqttPrinterClient({ deviceId: 'S1', kind: 'lan', lan: { host: '10.0.0.1', accessCode: '12345678' }, connectFn: () => fake, logger: require('pino')({ level: 'silent' }) });
  c.on('mqtt_error', () => {});
  c.connect();
  fake.emit('error', Object.assign(new Error('Connection refused: Not authorized'), { code: 5 }));
  assert.ok(ended && c.fatal);
  assert.match(c.lastError, /Not authorized/);
  const caps = computeCapabilities({ conn: { mode: 'lan', lanHost: 'h', accessCode: 'x' }, transport: 'lan', connected: false, lastError: c.lastError });
  assert.match(caps.controlHint, /Not connected: Connection refused/);
});

test('cloud token refresh updates the options mqtt.js reconnects with', () => {
  const fake = Object.assign(new EventEmitter(), { options: { username: 'u_1', password: 'old' } });
  const c = new MqttPrinterClient({ deviceId: 'S2', token: 'old', userId: '1', connectFn: () => fake, logger: require('pino')({ level: 'silent' }) });
  c.connect();
  c.updateCredentials('new', '2');
  assert.deepEqual([fake.options.username, fake.options.password], ['u_2', 'new']);
});
