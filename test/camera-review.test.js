'use strict';

// Regression tests for the BAM-9 review (code-review/2026-10-03-v0110-review.md).
process.env.BAMBUZLE_CAMERA_RECHECK_MS = '150';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { RtspsSource, JpegTlsSource, H264Depacketizer, createCameraStreams } = require('../src/printers/camera-stream');
const { Fmp4Writer, parseSps } = require('../src/printers/fmp4');
const { makeH264 } = require('./support/h264-pcm');
const users = require('../src/db/users');
const queries = require('../src/db/queries');
const conns = require('../src/db/printer-connections');
const { getDb } = require('../src/db/database');

after(cleanup);
const json = { 'Content-Type': 'application/json' };
const PW = 'viewer password 1';

/** A source with a dummy socket, to drive its parser directly. */
function detached(Src) {
  const s = new Src({ serial: 'S', host: '127.0.0.1', accessCode: 'ABCD1234' });
  s.sock = { write() {}, destroy() {} };
  const errors = [];
  s.on('error', (e) => errors.push(e.message));
  return { s, errors, feed: (b) => { try { s._data(b); } catch (e) { errors.push(e.message); } } };
}

test('#1: a session revoked mid-stream ends the response cleanly — no write-after-end crash with a slow reader', async () => {
  // A hub that pushes big frames forever
  let timer;
  const hub = {
    viewers: new Set(),
    subscribe(fn) {
      this.viewers.add(fn);
      timer = setInterval(() => fn({ type: 'jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(400000, 1)]) }), 5);
      return () => { clearInterval(timer); this.viewers.delete(fn); };
    },
  };
  const pm = { getLiveStates: () => ({}), isConnected: () => true, getCameraTarget: () => ({ ok: true, protocol: 'jpeg-tls', host: '10.0.0.9', accessCode: 'ABCD1234' }) };
  const srv = await startServer({ printerManager: pm, deps: { cameraStreams: { hubFor: () => hub, viewerCount: () => hub.viewers.size } } });
  const u = await users.createUser({ username: 'camviewer', password: PW, role: 'viewer' });
  try {
    const login = await fetch(`${srv.baseUrl}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'camviewer', password: PW }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${srv.baseUrl}/api/printers/CAM1/camera/stream`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // then stop reading: the server's buffer fills up
    await users.updateUser(u.id, { disabled: true });
    await new Promise((r) => setTimeout(r, 600)); // several re-checks + frames after end()
    assert.equal(hub.viewers.size, 0, 'viewer unsubscribed when its session was revoked');
    assert.equal((await fetch(`${srv.baseUrl}/healthz`)).status, 200, 'server still alive');
    await reader.cancel().catch(() => {});
  } finally {
    clearInterval(timer);
    await srv.close();
  }
});

test('#2: malformed RTSP Content-Length is a protocol error, not an endless loop', () => {
  for (const cl of ['-100000', 'abc', '99999999', '1e3']) {
    const { s, errors, feed } = detached(RtspsSource);
    s.pending = { resolve() {}, reject() {} };
    feed(Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: ${cl}\r\n\r\nxx`));
    assert.match(errors.join(), /Content-Length/, cl);
  }
  const { errors, feed } = detached(RtspsSource);
  feed(Buffer.from('ANNOUNCE rtsp://x RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
  assert.match(errors.join(), /Unexpected data/);
  const big = detached(RtspsSource);
  big.feed(Buffer.alloc(70 * 1024, 0x41)); // no header end
  assert.match(big.errors.join(), /Malformed RTSP/);
});

test('#3: short SPS / empty PPS in band are ignored, never thrown out of the socket handler', () => {
  const { s, errors } = detached(RtspsSource);
  const configs = [];
  s.on('config', (c) => configs.push(c));
  const idr = Buffer.from([0x65, 1, 2, 3]);
  s._au([Buffer.from([0x67, 0x42]), Buffer.from([0x68]).subarray(0, 0), idr], 0); // SPS too short
  assert.equal(configs.length, 0);
  assert.deepEqual(errors, []);
});

test('#4: parseSps rejects corrupt input quickly instead of hanging', () => {
  for (const hex of ['6742001ed0000000', '67', '', '67b3007b82050664']) {
    assert.throws(() => parseSps(Buffer.from(hex, 'hex')), hex);
  }
  // fuzz: random mutations of a real SPS must return or throw within the time budget
  const real = makeH264().sps;
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    const b = Buffer.from(real);
    for (let k = 0; k < 3; k++) b[1 + Math.floor(Math.random() * (b.length - 1))] = Math.floor(Math.random() * 256);
    try { const r = parseSps(b); assert.ok(r.width > 0 && r.width <= 8192 && r.height > 0 && r.height <= 8192); } catch { /* rejected */ }
  }
  assert.ok(Date.now() - t0 < 3000, 'fuzz finished promptly');
});

test('#5: replacing a hub ends its viewers', () => {
  const reg = createCameraStreams({ tlsVerify: true });
  const a = reg.hubFor('S', { protocol: 'rtsps', host: '10.0.0.1', accessCode: 'AAAA1111' });
  const got = [];
  a.source = { stop() {} }; // pretend it's streaming so subscribe doesn't connect
  a.subscribe((m) => got.push(m.type));
  reg.hubFor('S', { protocol: 'rtsps', host: '10.0.0.2', accessCode: 'AAAA1111' });
  assert.ok(got.includes('end'));
  assert.equal(a.viewers.size, 0);
  assert.equal(reg.viewerCount('S'), 0);
  reg.closeAll();
});

test('#6: a second config keeps the fMP4 timeline moving forward', () => {
  const h = makeH264();
  const out = [];
  const w = new Fmp4Writer((b) => out.push(b));
  const avcc = Buffer.concat([Buffer.from([1, h.sps[1], h.sps[2], h.sps[3], 0xff, 0xe1, 0, h.sps.length]), h.sps, Buffer.from([1, 0, h.pps.length]), h.pps]);
  w.config({ avcc, sps: h.sps });
  for (let i = 0; i < 5; i++) w.frame({ data: Buffer.from([0, 0, 0, 1, 0x41]), key: i === 0, ts90k: 1000 + i * 9000 });
  w.config({ avcc, sps: h.sps }); // reconnect
  for (let i = 0; i < 3; i++) w.frame({ data: Buffer.from([0, 0, 0, 1, 0x41]), key: i === 0, ts90k: 500 + i * 9000 }); // new RTP clock
  const tfdts = [];
  const all = Buffer.concat(out);
  for (let at = all.indexOf('tfdt'); at >= 0; at = all.indexOf('tfdt', at + 4)) tfdts.push(Number(all.readBigUInt64BE(at + 8)));
  for (let i = 1; i < tfdts.length; i++) assert.ok(tfdts[i] > tfdts[i - 1], `tfdt ${tfdts}`);
});

test('#7: a new SPS at a keyframe re-announces the decoder config', () => {
  const { s } = detached(RtspsSource);
  const configs = [];
  s.on('config', (c) => configs.push(c.sps.toString('hex')));
  const h1 = makeH264({ widthMbs: 20, heightMbs: 12 });
  const h2 = makeH264({ widthMbs: 40, heightMbs: 23 });
  const idr = Buffer.from([0x65, 1, 2, 3]);
  s._au([h1.sps, h1.pps, idr], 0);
  s._au([Buffer.from([0x41, 9])], 9000);
  s._au([h2.sps, h2.pps, idr], 18000);
  assert.equal(configs.length, 2);
  assert.notEqual(configs[0], configs[1]);
});

test('#8 + #9: big frames in small reads stay linear; runaway FU-A / access units are dropped', () => {
  const { s } = detached(JpegTlsSource);
  const frames = [];
  s.on('jpeg', (j) => frames.push(j.length));
  const size = 3 * 1024 * 1024;
  const hdr = Buffer.alloc(16); hdr.writeUInt32LE(size, 0);
  const all = Buffer.concat([hdr, Buffer.from([0xff, 0xd8]), Buffer.alloc(size - 2, 1)]);
  const t0 = Date.now();
  for (let i = 0; i < all.length; i += 16384) s._data(all.subarray(i, i + 16384));
  assert.deepEqual(frames, [size]);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);

  const aus = [];
  const d = new H264Depacketizer((n) => aus.push(n.length));
  const rtp = (payload, marker, ts = 1) => { const h = Buffer.alloc(12); h[0] = 0x80; h[1] = marker ? 0x80 : 0; h.writeUInt32BE(ts, 4); return Buffer.concat([h, payload]); };
  const frag = Buffer.concat([Buffer.from([0x7c, 0x05]), Buffer.alloc(60000, 1)]); // FU-A middle, no end bit
  d.push(rtp(Buffer.concat([Buffer.from([0x7c, 0x85]), Buffer.alloc(10, 1)]), false));
  for (let i = 0; i < 100; i++) d.push(rtp(frag, false));
  assert.equal(d.fu, null, 'unterminated FU-A dropped past the cap');
  for (let i = 0; i < 100; i++) d.push(rtp(Buffer.concat([Buffer.from([0x41]), Buffer.alloc(60000, 1)]), false));
  d.push(rtp(Buffer.from([0x41, 1]), true));
  assert.deepEqual(aus, [], 'oversized access unit dropped');
  d.push(rtp(Buffer.from([0x41, 2]), true, 2));
  assert.deepEqual(aus, [1], 'next access unit flows again');
});

test('#10: account code import — cloud printers only, code only, never re-fills a deliberately cleared LAN code', () => {
  for (const id of ['IMP1', 'IMP2', 'IMP3']) queries.upsertPrinter({ deviceId: id, name: id, model: 'X1C' });
  assert.deepEqual(conns.importCloudAccessCode('IMP1', 'CODE0001'), { changed: true, reconnect: false });
  assert.equal(conns.getConnection('IMP1').lanHost, null);
  conns.setConnection('IMP2', { lanHost: '10.0.0.5', accessCode: '' });
  assert.deepEqual(conns.importCloudAccessCode('IMP2', 'CODE0002'), { changed: false, reconnect: false });
  conns.setConnection('IMP3', { lanHost: '10.0.0.6', accessCode: 'OLDCODE1' });
  assert.deepEqual(conns.importCloudAccessCode('IMP3', 'NEWCODE1'), { changed: true, reconnect: true });
  getDb().prepare("UPDATE printers SET source = 'removed' WHERE device_id = 'IMP1'").run();
  assert.deepEqual(conns.importCloudAccessCode('IMP1', 'CODE0009'), { changed: false, reconnect: false });
});
