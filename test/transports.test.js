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
  const { url, options } = buildConnectOptions({ kind: 'lan', deviceId: '0948AB521500157', lan: { host: '192.168.1.93', accessCode: '12345678' } });
  assert.equal(url, 'mqtts://192.168.1.93:8883');
  assert.equal(options.username, 'bblp');
  assert.equal(options.password, '12345678');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.maxVersion, 'TLSv1.2');
  assert.match(options.ca, /BEGIN CERTIFICATE/);
  assert.equal(options.checkServerIdentity('192.168.1.93', { subject: { CN: '0948AB521500157' } }), undefined);
  const err = options.checkServerIdentity('192.168.1.93', { subject: { CN: '00M09C431902335' } });
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
  assert.ok(validHost('192.168.1.93') && validHost('printer.local'));
  for (const bad of ['1.2.3.999', 'http://x', 'a b', '-x.com', '', null]) assert.equal(validHost(bad), false, String(bad));
  assert.ok(validAccessCode('a1B2c3D4'));
  assert.equal(validAccessCode('1234567'), false);
  assert.ok(validSerial('0948AB521500157'));
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
