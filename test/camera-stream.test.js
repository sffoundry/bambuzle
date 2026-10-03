'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const {
  JpegTlsSource, RtspsSource, H264Depacketizer, parseSdp, avcConfig, rtspAuthHeader, jpegAuthPacket, CameraHub, createCameraStreams,
} = require('../src/printers/camera-stream');
const { authHeaders, startServer, cleanup, TEST_TOKEN } = require('./helpers');

after(cleanup);
const FIX = path.join(__dirname, 'fixtures', 'tls');
const SERIAL = '01S00TEST000001';
const CA = fs.readFileSync(path.join(FIX, 'test-ca.pem'), 'utf8');
const CODE = 'ABCD1234';
const tlsServer = (onSocket) => new Promise((resolve) => {
  const s = tls.createServer({ cert: fs.readFileSync(path.join(FIX, 'printer.pem')), key: fs.readFileSync(path.join(FIX, 'printer.key')) }, onSocket);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const JPEG = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7), Buffer.from([0xff, 0xd9])]);
const jpegFrame = (img) => { const h = Buffer.alloc(16); h.writeUInt32LE(img.length, 0); return Buffer.concat([h, img]); };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('JPEG auth packet layout', () => {
  const p = jpegAuthPacket(CODE);
  assert.equal(p.length, 80);
  assert.equal(p.readUInt32LE(0), 0x40);
  assert.equal(p.readUInt32LE(4), 0x3000);
  assert.equal(p.subarray(16, 20).toString(), 'bblp');
  assert.equal(p.subarray(48, 56).toString(), CODE);
});

test('JpegTlsSource: logs in after a verified handshake and emits whole JPEG frames (split across reads)', async () => {
  let auth = null;
  const server = await tlsServer((s) => {
    s.once('data', (d) => {
      auth = d;
      const all = Buffer.concat([jpegFrame(JPEG(3000)), jpegFrame(Buffer.from('not a jpeg')), jpegFrame(JPEG(10))]);
      s.write(all.subarray(0, 1000));
      setTimeout(() => s.write(all.subarray(1000)), 20);
    });
  });
  const src = new JpegTlsSource({ serial: SERIAL, host: '127.0.0.1', port: server.address().port, accessCode: CODE, tlsVerify: true, ca: CA });
  const got = [];
  try {
    await new Promise((resolve, reject) => {
      src.on('jpeg', (j) => { got.push(j.length); if (got.length === 2) resolve(); });
      src.on('error', reject);
      src.start();
    });
    assert.deepEqual(got, [3006, 16]);
    assert.equal(auth.subarray(48, 56).toString(), CODE);
  } finally {
    src.stop();
    server.close();
  }
});

test('JpegTlsSource: wrong printer certificate → no access code is sent', async () => {
  let received = 0;
  const server = await tlsServer((s) => s.on('data', (d) => { received += d.length; }));
  const src = new JpegTlsSource({ serial: '01S00TEST999999', host: '127.0.0.1', port: server.address().port, accessCode: CODE, tlsVerify: true, ca: CA });
  try {
    const err = await new Promise((resolve) => { src.on('error', resolve); src.start(); });
    assert.equal(err.code, 'ERR_PRINTER_IDENTITY');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received, 0);
  } finally {
    src.stop();
    server.close();
  }
});

// ─── H.264 / RTSP ───
const SPS = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40]);
const PPS = Buffer.from([0x68, 0xeb, 0xe3, 0xcb]);
const IDR = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3000, 0x11)]);
const PFRAME = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(200, 0x22)]);
let seq = 0;
function rtp(payload, ts, marker) {
  const h = Buffer.alloc(12);
  h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | 96; h.writeUInt16BE(seq++ & 0xffff, 2); h.writeUInt32BE(ts, 4); h.writeUInt32BE(1234, 8);
  return Buffer.concat([h, payload]);
}
function stapA(...nals) { return Buffer.concat([Buffer.from([24]), ...nals.flatMap((n) => [Buffer.from([n.length >> 8, n.length & 0xff]), n])]); }
function fuA(nal, size = 1000) {
  const out = [];
  const hdr = nal[0];
  const body = nal.subarray(1);
  for (let i = 0; i < body.length; i += size) {
    const start = i === 0; const end = i + size >= body.length;
    out.push(Buffer.concat([Buffer.from([(hdr & 0xe0) | 28, (start ? 0x80 : 0) | (end ? 0x40 : 0) | (hdr & 0x1f)]), body.subarray(i, i + size)]));
  }
  return out;
}

test('H.264 depacketiser: STAP-A, FU-A and single NAL units, access units on the marker bit', () => {
  const aus = [];
  const d = new H264Depacketizer((nals, ts) => aus.push({ types: nals.map((n) => n[0] & 0x1f), sizes: nals.map((n) => n.length), ts }));
  d.push(rtp(stapA(SPS, PPS), 1000, false));
  const frags = fuA(IDR);
  frags.forEach((f, i) => d.push(rtp(f, 1000, i === frags.length - 1)));
  d.push(rtp(PFRAME, 4000, true));
  d.push(Buffer.from([1, 2, 3])); // junk ignored
  assert.deepEqual(aus.map((a) => a.types), [[7, 8, 5], [1]]);
  assert.equal(aus[0].sizes[2], IDR.length, 'FU-A reassembled exactly');
  assert.deepEqual(aus.map((a) => a.ts), [1000, 4000]);
});

test('SDP parse, avcC config, Digest auth', () => {
  const sdp = ['v=0', 'm=audio 0 RTP/AVP 97', 'a=control:trackID=9', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
    `a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${SPS.toString('base64')},${PPS.toString('base64')}`, 'a=control:trackID=1'].join('\r\n');
  const p = parseSdp(sdp, 'rtsps://10.0.0.5:322/streaming/live/1/');
  assert.equal(p.control, 'rtsps://10.0.0.5:322/streaming/live/1/trackID=1');
  assert.equal(p.codec, 'H264');
  assert.deepEqual([p.sps, p.pps], [SPS, PPS]);
  const cfg = avcConfig(SPS, PPS);
  assert.equal(cfg.codec, 'avc1.64001f');
  assert.deepEqual([...cfg.description.subarray(0, 6)], [1, 0x64, 0x00, 0x1f, 0xff, 0xe1]);
  const h = rtspAuthHeader('Digest realm="Bambu", nonce="abc"', { user: 'bblp', pass: CODE, method: 'DESCRIBE', uri: 'rtsps://x/y' });
  assert.ok(h.includes(`response="${md5(`${md5(`bblp:Bambu:${CODE}`)}:abc:${md5('DESCRIBE:rtsps://x/y')}`)}"`));
  assert.match(rtspAuthHeader('Basic realm="x"', { user: 'bblp', pass: CODE }), /^Basic /);
});

/** A fake printer RTSPS server: Digest auth, DESCRIBE/SETUP/PLAY, then one GOP over interleaved RTP. */
async function fakeRtsps({ requireAuth = true } = {}) {
  const log = { methods: [], conns: 0 };
  const server = await tlsServer((s) => {
    log.conns++;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const req = buf.slice(0, i); buf = buf.slice(i + 4);
        const [line, ...hs] = req.split('\r\n');
        const [method, uri] = line.split(' ');
        const h = Object.fromEntries(hs.map((x) => [x.slice(0, x.indexOf(':')).toLowerCase(), x.slice(x.indexOf(':') + 1).trim()]));
        log.methods.push(method);
        const reply = (status, headers = {}, body = '') => s.write(`RTSP/1.0 ${status} X\r\nCSeq: ${h.cseq}\r\n${Object.entries({ ...headers, 'Content-Length': Buffer.byteLength(body) }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
        if (requireAuth && method !== 'OPTIONS') {
          const a = h.authorization || '';
          const expect = md5(`${md5(`bblp:Bambu:${CODE}`)}:n0nce:${md5(`${method}:${uri}`)}`);
          if (!a.includes(`response="${expect}"`)) { reply(401, { 'WWW-Authenticate': 'Digest realm="Bambu", nonce="n0nce"' }); continue; }
        }
        if (method === 'OPTIONS') reply(200, { Public: 'DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
        else if (method === 'DESCRIBE') reply(200, { 'Content-Type': 'application/sdp', 'Content-Base': `${uri}/` }, ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', 'a=control:trackID=1'].join('\r\n'));
        else if (method === 'SETUP') reply(200, { Session: 'S1;timeout=60', Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
        else if (method === 'PLAY') {
          reply(200, { Session: 'S1' });
          const pkts = [rtp(stapA(SPS, PPS), 9000, false), ...fuA(IDR).map((f, k, a) => rtp(f, 9000, k === a.length - 1)), rtp(PFRAME, 12000, true)];
          for (const p of pkts) { const h4 = Buffer.from([0x24, 0, p.length >> 8, p.length & 0xff]); s.write(Buffer.concat([h4, p])); }
        } else reply(200);
      }
    });
  });
  return { server, log };
}

test('RtspsSource: Digest login, SDP without sprop (in-band SPS/PPS), config then key + delta access units', async () => {
  const { server, log } = await fakeRtsps();
  const src = new RtspsSource({ serial: SERIAL, host: '127.0.0.1', port: server.address().port, accessCode: CODE, tlsVerify: true, ca: CA });
  const events = [];
  try {
    await new Promise((resolve, reject) => {
      src.on('config', (c) => events.push(['config', c.codec]));
      src.on('au', (au) => { events.push([au.key ? 'key' : 'delta', au.data.length]); if (events.length === 3) resolve(); });
      src.on('error', reject);
      src.start();
    });
    assert.deepEqual(events[0], ['config', 'avc1.64001f']);
    assert.deepEqual(events[1], ['key', 4 + IDR.length]);
    assert.deepEqual(events[2], ['delta', 4 + PFRAME.length]);
    assert.ok(log.methods.includes('PLAY'));
  } finally {
    src.stop();
    server.close();
  }
});

test('RtspsSource: wrong access code → auth error, no endless retry', async () => {
  const { server } = await fakeRtsps();
  const src = new RtspsSource({ serial: SERIAL, host: '127.0.0.1', port: server.address().port, accessCode: 'WRONG999', tlsVerify: true, ca: CA });
  try {
    const err = await new Promise((resolve) => { src.on('error', resolve); src.start(); });
    assert.equal(err.stage, 'auth');
  } finally {
    src.stop();
    server.close();
  }
});

test('CameraHub: viewers share one upstream; a late viewer gets config + the current GOP; closes when idle', async () => {
  const { server, log } = await fakeRtsps();
  const hub = new CameraHub({ serial: SERIAL, protocol: 'rtsps', host: '127.0.0.1', accessCode: CODE, tlsVerify: true, ca: CA, idleMs: 50 });
  hub.source = null;
  // point the source at the fake server's port
  const port = server.address().port;
  hub.opts.port = port;
  const a = [];
  const offA = hub.subscribe((m) => a.push(m.type));
  await new Promise((r) => { const t = setInterval(() => { if (a.filter((x) => x === 'au').length >= 2) { clearInterval(t); r(); } }, 10); });
  const b = [];
  const offB = hub.subscribe((m) => b.push(m.type));
  assert.deepEqual(b, ['config', 'au', 'au'], 'late joiner starts with config + keyframe + following frames');
  assert.equal(log.conns, 1, 'one upstream connection for two viewers');
  offA(); offB();
  await new Promise((r) => hub.once('closed', r));
  assert.equal(hub.source, null);
  server.close();
});

test('camera route: 409 with a reason, MJPEG for jpeg-tls, viewer allowed, never anonymous', async () => {
  const frames = [];
  const fakeHub = { viewers: new Set(), subscribe(fn) { fn({ type: 'jpeg', data: JPEG(20) }); frames.push(fn); return () => {}; } };
  const cameraStreams = { hubFor: () => fakeHub, viewerCount: () => 0 };
  const targets = { CAMOK: { ok: true, protocol: 'jpeg-tls', host: '10.0.0.9', accessCode: CODE }, CAMNO: { ok: false, status: 409, error: 'The camera is switched off' } };
  const pm = { getLiveStates: () => ({}), isConnected: () => true, getCameraTarget: (id) => targets[id] || null };
  const srv = await startServer({ printerManager: pm, deps: { cameraStreams }, auth: { mode: 'on', adminToken: TEST_TOKEN, publicRead: true } });
  try {
    let r = await fetch(`${srv.baseUrl}/api/printers/CAMNO/camera/stream`, { headers: authHeaders });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /switched off/);
    assert.equal((await fetch(`${srv.baseUrl}/api/printers/CAMOK/camera/stream`)).status, 401, 'public read never includes the camera');
    const ac = new AbortController();
    r = await fetch(`${srv.baseUrl}/api/printers/CAMOK/camera/stream`, { headers: authHeaders, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /multipart\/x-mixed-replace; boundary=bambuzleframe/);
    const { value } = await r.body.getReader().read();
    const text = Buffer.from(value).toString('latin1');
    assert.match(text, /--bambuzleframe\r\nContent-Type: image\/jpeg\r\nContent-Length: 26/);
    ac.abort();
  } finally {
    await srv.close();
  }
});

test('stream registry: a new address or code replaces the hub', () => {
  const reg = createCameraStreams({ tlsVerify: true });
  const h1 = reg.hubFor('S', { protocol: 'rtsps', host: '10.0.0.1', accessCode: 'AAAA1111' });
  assert.equal(reg.hubFor('S', { protocol: 'rtsps', host: '10.0.0.1', accessCode: 'AAAA1111' }), h1);
  assert.notEqual(reg.hubFor('S', { protocol: 'rtsps', host: '10.0.0.2', accessCode: 'AAAA1111' }), h1);
  reg.closeAll();
});

// ─── Real H.264 (generated I_PCM / P-skip bitstream) through RTSPS → hub → fMP4 ───
const { makeH264 } = require('./support/h264-pcm');
const { startFakeRtsps } = require('./support/fake-rtsps');
const { parseSps, Fmp4Writer } = require('../src/printers/fmp4');

function boxes(buf) {
  const out = [];
  for (let off = 0; off + 8 <= buf.length;) {
    const size = buf.readUInt32BE(off);
    out.push(buf.toString('latin1', off + 4, off + 8));
    if (size < 8) break;
    off += size;
  }
  return out;
}

test('fMP4: SPS dimensions, init segment then one moof+mdat per frame with exact durations', async () => {
  const h = makeH264();
  assert.deepEqual(parseSps(h.sps), { width: 320, height: 192 });
  const { server, port } = await startFakeRtsps({ accessCode: CODE, fps: 10, maxFrames: 12, nextFrame: (i) => ({ nals: i % 10 === 0 ? [h.sps, h.pps, h.idr(i, i / 10)] : [h.pSkip(i % 10)] }) });
  const chunks = [];
  const mp4 = new Fmp4Writer((b) => chunks.push(b));
  const src = new RtspsSource({ serial: SERIAL, host: '127.0.0.1', port, accessCode: CODE, tlsVerify: true, ca: CA });
  try {
    await new Promise((resolve, reject) => {
      let n = 0;
      src.on('config', (c) => mp4.config({ avcc: c.description, sps: c.sps }));
      src.on('au', (au) => { mp4.frame(au); if (++n === 12) resolve(); });
      src.on('error', reject);
      src.start();
    });
  } finally {
    src.stop();
    server.close();
  }
  const all = Buffer.concat(chunks);
  const types = boxes(all);
  assert.deepEqual(types.slice(0, 2), ['ftyp', 'moov']);
  assert.equal(types.filter((t) => t === 'moof').length, 11, 'each frame is written once the next arrives');
  assert.equal(types.filter((t) => t === 'mdat').length, 11);
  const init = chunks[0];
  assert.ok(init.includes(Buffer.from('avcC')));
  const tkhdAt = init.indexOf('tkhd');
  assert.equal(init.readUInt32BE(tkhdAt + 4 + 76) >>> 16, 320, 'track width from the SPS');
  const trunAt = all.indexOf('trun');
  assert.equal(all.readUInt32BE(trunAt + 4 + 4 + 8), 9000, 'duration = RTP timestamp delta (10 fps at 90 kHz)');
});
