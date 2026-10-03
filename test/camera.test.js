'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { cameraProtocol, probeCameraPort, cameraCapability, createCameraMonitor, RECHECK_FAIL_MS, RECHECK_OK_MS } = require('../src/printers/camera-probe');
const { extractDiagnostics } = require('../src/bambu/diagnostics');

const FIX = path.join(__dirname, 'fixtures', 'tls');
const SERIAL = '01S00TEST000001';
const CA = fs.readFileSync(path.join(FIX, 'test-ca.pem'), 'utf8');

function startTlsServer() {
  const server = tls.createServer({ cert: fs.readFileSync(path.join(FIX, 'printer.pem')), key: fs.readFileSync(path.join(FIX, 'printer.key')) }, (s) => s.end());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('camera protocol by model', () => {
  assert.deepEqual(cameraProtocol('X1C'), { protocol: 'rtsps', port: 322 });
  assert.deepEqual(cameraProtocol('h2d'), { protocol: 'rtsps', port: 322 });
  assert.deepEqual(cameraProtocol('A1MINI'), { protocol: 'jpeg-tls', port: 6000 });
  assert.deepEqual(cameraProtocol('P1S'), { protocol: 'jpeg-tls', port: 6000 });
  assert.equal(cameraProtocol('UNKNOWN'), null);
  assert.equal(cameraProtocol(null), null);
});

test('probe: verified printer certificate → ok; wrong serial → identity; unknown CA → tls; closed port → refused', async () => {
  const server = await startTlsServer();
  const { port } = server.address();
  try {
    assert.equal((await probeCameraPort({ serial: SERIAL, host: '127.0.0.1', port, ca: CA })).stage, 'ok');
    assert.equal((await probeCameraPort({ serial: '01S00TEST999999', host: '127.0.0.1', port, ca: CA })).stage, 'identity');
    assert.equal((await probeCameraPort({ serial: SERIAL, host: '127.0.0.1', port })).stage, 'tls', 'the throwaway test CA is not in the Bambu bundle');
  } finally {
    server.close();
  }
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  assert.equal((await probeCameraPort({ serial: SERIAL, host: '127.0.0.1', port: closedPort, ca: CA })).stage, 'refused');
});

test('probe: a silent port times out as unreachable', async () => {
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)); // accepts TCP, never speaks TLS
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const r = await probeCameraPort({ serial: SERIAL, host: '127.0.0.1', port: silent.address().port, ca: CA, timeoutMs: 300 });
    assert.equal(r.stage, 'unreachable');
  } finally {
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

test('capability states', () => {
  const rtsps = cameraProtocol('X1C');
  const jpeg = cameraProtocol('A1');
  assert.equal(cameraCapability({ proto: rtsps, reported: { present: false }, host: 'h' }).camera, 'none');
  assert.equal(cameraCapability({ proto: null, reported: null, host: 'h' }).camera, 'unknown');
  assert.equal(cameraCapability({ proto: rtsps, reported: { lanLiveview: false }, host: 'h' }).camera, 'disabled');
  assert.equal(cameraCapability({ proto: rtsps, reported: {}, host: null }).camera, 'unknown');
  assert.equal(cameraCapability({ proto: rtsps, reported: {}, host: 'h', status: null }).camera, 'unknown');
  assert.equal(cameraCapability({ proto: jpeg, reported: {}, host: 'h', status: { ok: true, stage: 'ok' } }).camera, 'available');
  const off = cameraCapability({ proto: rtsps, reported: {}, host: 'h', status: { ok: false, stage: 'refused' } });
  assert.equal(off.camera, 'disabled');
  assert.match(off.cameraHint, /LAN Only Liveview/);
  assert.equal(cameraCapability({ proto: jpeg, reported: {}, host: 'h', status: { ok: false, stage: 'identity', message: 'x' } }).camera, 'unreachable');
});

test('monitor: probes once per interval, re-probes on address change, skips when liveview is off, reports changes', async () => {
  let t = 1_000_000;
  const calls = [];
  const changed = [];
  let result = { ok: false, stage: 'refused', message: 'closed' };
  const mon = createCameraMonitor({ probe: async (o) => { calls.push(o); return result; }, now: () => t, onChange: (id) => changed.push(id) });
  const info = { modelKey: 'X1C', host: '10.0.0.5', reported: { present: true } };
  const settle = () => new Promise((r) => setImmediate(r));

  assert.equal(mon.check(SERIAL, info).camera, 'unknown'); // probe in flight
  mon.check(SERIAL, info); // single-flight
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, 322);
  assert.deepEqual(changed, [SERIAL]);
  assert.equal(mon.check(SERIAL, info).camera, 'disabled');
  assert.equal(calls.length, 1, 'not due yet');

  t += RECHECK_FAIL_MS;
  result = { ok: true, stage: 'ok' };
  mon.check(SERIAL, info);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(mon.check(SERIAL, info).camera, 'available');
  t += RECHECK_FAIL_MS;
  mon.check(SERIAL, info);
  assert.equal(calls.length, 2, 'a working camera is re-checked less often');
  t += RECHECK_OK_MS;
  mon.check(SERIAL, info);
  await settle();
  assert.equal(calls.length, 3);

  mon.check(SERIAL, { ...info, host: '10.0.0.6' });
  await settle();
  assert.equal(calls.length, 4, 'new address → probe now');
  assert.equal(calls[3].host, '10.0.0.6');

  assert.equal(mon.check(SERIAL, { ...info, reported: { lanLiveview: false } }).camera, 'disabled');
  assert.equal(mon.check('OTHER', { modelKey: 'X1C', host: 'not a host!', reported: {} }).camera, 'unknown');
  assert.equal(mon.check('NOCAM', { modelKey: 'P1P', host: '10.0.0.7', reported: { present: false } }).camera, 'none');
  await settle();
  assert.equal(calls.length, 4, 'no probe when liveview is off, the host is invalid or there is no camera');
});

test('diagnostics: camera presence and LAN liveview flag, never the RTSP URL', () => {
  const on = extractDiagnostics({ ipcam: { ipcam_dev: '1', rtsp_url: 'rtsps://10.0.0.5/streaming/live/1' } }).camera;
  assert.deepEqual([on.present, on.lanLiveview], [true, true]);
  assert.ok(!JSON.stringify(on).includes('rtsps'));
  const off = extractDiagnostics({ ipcam: { ipcam_dev: '1', rtsp_url: 'disable' } }).camera;
  assert.equal(off.lanLiveview, false);
  const none = extractDiagnostics({ ipcam: { ipcam_dev: '0' } }).camera;
  assert.deepEqual([none.present, none.lanLiveview], [false, null]);
});
