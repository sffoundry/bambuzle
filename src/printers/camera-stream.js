'use strict';

// BAM-9: live camera, LAN only. One upstream connection per printer, shared by every viewer, and
// closed 10 s after the last viewer leaves (printers accept very few camera clients).
//
// Sources (protocol by model: src/printers/camera-probe.js):
//   jpeg-tls  P1 / A1: TLS :6000, 80-byte auth packet (user bblp + access code), then frames of
//             [16-byte header: u32le size, …][JPEG]. Served to the browser as MJPEG.
//   rtsps     X1 / H2: RTSP over TLS :322 (needs "LAN Only Liveview" on), path /streaming/live/1,
//             RTP over the RTSP TCP connection (interleaved), H.264 depacketised here and re-wrapped
//             as fragmented MP4 (src/printers/fmp4.js) for the browser's Media Source Extensions.
//             No transcoding.
// Both: TLS verified against the Bambu CA with CN == serial (as LAN MQTT), access code sent only
// after that check. Protocol details follow ha-bambulab / pybambu (MIT) and RFC 2326 / RFC 6184.

const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getLanCaBundle, checkPrinterIdentity } = require('../bambu/mqtt-client');

const IDLE_CLOSE_MS = 10 * 1000;
const RETRY_MS = [2000, 5000, 10000, 30000];
const STALL_MS = 20 * 1000; // no frame for this long → reconnect
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_RTSP_HEAD = 64 * 1024; // RTSP status line + headers
const MAX_RTSP_BODY = 64 * 1024; // SDP is a few hundred bytes

/**
 * Byte queue for stream parsing: keeps incoming chunks and only copies the bytes a parser asks for,
 * so a large frame arriving in many small reads costs O(n), not O(n²) (review #8).
 */
class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; }
  push(b) { if (b.length) { this.chunks.push(b); this.length += b.length; } }
  /** First n bytes as one Buffer (n ≤ length). Merges only the chunks needed. */
  peek(n) {
    if (this.chunks[0]?.length >= n) return this.chunks[0].subarray(0, n);
    const parts = [];
    let got = 0;
    for (const c of this.chunks) { parts.push(c); got += c.length; if (got >= n) break; }
    const merged = Buffer.concat(parts);
    this.chunks.splice(0, parts.length, merged);
    return merged.subarray(0, n);
  }
  consume(n) {
    this.length -= n;
    while (n > 0) {
      const c = this.chunks[0];
      if (c.length <= n) { n -= c.length; this.chunks.shift(); } else { this.chunks[0] = c.subarray(n); n = 0; }
    }
  }
  take(n) { const b = Buffer.from(this.peek(n)); this.consume(n); return b; }
}

function tlsOptions({ serial, host, port, tlsVerify, ca }) {
  return {
    host,
    port,
    ca: tlsVerify ? (ca || getLanCaBundle()) : undefined,
    rejectUnauthorized: tlsVerify,
    checkServerIdentity: tlsVerify ? (h, cert) => checkPrinterIdentity(serial, h, cert) : () => undefined,
    maxVersion: 'TLSv1.2',
  };
}

// ─── JPEG over TLS (:6000) ───

function jpegAuthPacket(accessCode) {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(0x40, 0);
  b.writeUInt32LE(0x3000, 4);
  b.write('bblp', 16, 'ascii');
  b.write(String(accessCode).slice(0, 32), 48, 'ascii');
  return b;
}

/** Emits 'jpeg' (Buffer), 'error', 'close'. */
class JpegTlsSource extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.sock = null;
    this.q = new ByteQueue();
  }

  start() {
    const { connectFn = tls.connect } = this.opts;
    this.sock = connectFn(tlsOptions({ ...this.opts, port: this.opts.port || 6000 }));
    this.sock.on('secureConnect', () => this.sock.write(jpegAuthPacket(this.opts.accessCode)));
    this.sock.on('data', (d) => safeData(this, d));
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('close', () => this.emit('close'));
  }

  _data(d) {
    this.q.push(d);
    while (this.q.length >= 16) {
      const size = this.q.peek(16).readUInt32LE(0);
      if (size > MAX_FRAME) throw new Error('Camera sent an oversized frame');
      if (this.q.length < 16 + size) return;
      this.q.consume(16);
      const img = this.q.take(size);
      if (img.length > 4 && img[0] === 0xff && img[1] === 0xd8) this.emit('jpeg', img);
      // Anything else (e.g. a short status reply on models that don't serve this protocol) is ignored;
      // the printer then closes the connection.
    }
  }

  stop() {
    try { this.sock?.destroy(); } catch { /* closed */ }
  }
}

/** Parser errors from a misbehaving camera must never escape a socket handler (review #3). */
function safeData(src, d) {
  try {
    src._data(d);
  } catch (err) {
    src.emit('error', err);
    src.stop();
  }
}

// ─── RTSP over TLS (:322) ───

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

/** Authorization header for a 401 challenge (Digest MD5 or Basic). Exported for tests. */
function rtspAuthHeader(challenge, { user, pass, method, uri }) {
  if (/^Digest/i.test(challenge)) {
    const field = (k) => (new RegExp(`${k}="([^"]*)"`, 'i').exec(challenge) || [])[1];
    const realm = field('realm') || '';
    const nonce = field('nonce') || '';
    const ha1 = md5(`${user}:${realm}:${pass}`);
    const ha2 = md5(`${method}:${uri}`);
    if (/qop="?[^"]*\bauth\b/i.test(challenge)) {
      const cnonce = crypto.randomBytes(8).toString('hex');
      const nc = '00000001';
      const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
      return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
    }
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Minimal SDP parse: the H.264 video track's control URL and sprop-parameter-sets. Exported for tests. */
function parseSdp(sdp, baseUrl) {
  const lines = String(sdp).split(/\r?\n/);
  let inVideo = false;
  let control = null;
  let pt = null;
  let sprop = null;
  let codec = null;
  for (const l of lines) {
    if (l.startsWith('m=')) { inVideo = l.startsWith('m=video'); if (inVideo) pt = l.split(' ')[3]; continue; }
    if (!inVideo) continue;
    if (l.startsWith('a=control:')) control = l.slice(10).trim();
    const rtpmap = /^a=rtpmap:(\d+) ([^/]+)/.exec(l);
    if (rtpmap && rtpmap[1] === pt) codec = rtpmap[2].toUpperCase();
    const fmtp = /^a=fmtp:\d+ (.*)$/.exec(l);
    if (fmtp) sprop = (/sprop-parameter-sets=([^;\s]+)/.exec(fmtp[1]) || [])[1] || null;
  }
  if (!control) control = baseUrl;
  else if (!/^rtsps?:\/\//i.test(control)) control = `${baseUrl.replace(/\/$/, '')}/${control.replace(/^\//, '')}`;
  const params = sprop ? sprop.split(',').map((b) => Buffer.from(b, 'base64')).filter((b) => b.length) : [];
  return { control, codec, sps: params.find((n) => (n[0] & 0x1f) === 7) || null, pps: params.find((n) => (n[0] & 0x1f) === 8) || null };
}

/** avcC (ISO 14496-15) decoder config from SPS + PPS, and the WebCodecs codec string. Exported for tests. */
function avcConfig(sps, pps) {
  if (!sps || sps.length < 4 || !pps || !pps.length) throw new Error('Camera sent an invalid SPS/PPS');
  const avcc = Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
  ]);
  const codec = `avc1.${[sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { codec, description: avcc };
}

/**
 * RTP/H.264 depacketiser (RFC 6184: single NAL, STAP-A, FU-A). Feed RTP packets; emits whole access
 * units (on the marker bit or a timestamp change) as arrays of NAL units. Exported for tests.
 */
class H264Depacketizer {
  constructor(onAccessUnit) {
    this.onAU = onAccessUnit;
    this.nals = [];
    this.fu = null;
    this.fuBytes = 0;
    this.bytes = 0;
    this.ts = null;
  }

  push(pkt) {
    if (pkt.length < 12 || (pkt[0] >> 6) !== 2) return;
    const cc = pkt[0] & 0x0f;
    const ext = (pkt[0] & 0x10) !== 0;
    const padding = (pkt[0] & 0x20) !== 0;
    const marker = (pkt[1] & 0x80) !== 0;
    const ts = pkt.readUInt32BE(4);
    let off = 12 + cc * 4;
    if (ext) {
      if (pkt.length < off + 4) return;
      off += 4 + pkt.readUInt16BE(off + 2) * 4;
    }
    let end = pkt.length;
    if (padding) end -= pkt[pkt.length - 1];
    if (off >= end) return;
    if (this.ts !== null && ts !== this.ts && this.nals.length) this._flush();
    this.ts = ts;
    const p = pkt.subarray(off, end);
    const type = p[0] & 0x1f;
    const add = (n) => {
      this.bytes += n.length;
      if (this.bytes > MAX_FRAME) { this.nals = []; this.bytes = 0; this.dropping = true; return; } // runaway access unit (review #9)
      if (!this.dropping) this.nals.push(n);
    };
    if (type >= 1 && type <= 23) add(Buffer.from(p));
    else if (type === 24) { // STAP-A
      let i = 1;
      while (i + 2 <= p.length) {
        const n = p.readUInt16BE(i);
        i += 2;
        if (n === 0 || i + n > p.length) break;
        add(Buffer.from(p.subarray(i, i + n)));
        i += n;
      }
    } else if (type === 28 && p.length > 2) { // FU-A
      const start = (p[1] & 0x80) !== 0;
      const stop = (p[1] & 0x40) !== 0;
      if (start) { this.fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)]), Buffer.from(p.subarray(2))]; this.fuBytes = p.length; }
      else if (this.fu) {
        this.fuBytes += p.length;
        if (this.fuBytes > MAX_FRAME) this.fu = null; // fragments without an end bit (review #9)
        else this.fu.push(Buffer.from(p.subarray(2)));
      }
      if (stop && this.fu) { add(Buffer.concat(this.fu)); this.fu = null; }
    }
    if (marker) this._flush();
  }

  _flush() {
    if (this.nals.length && !this.dropping) this.onAU(this.nals, this.ts);
    this.nals = [];
    this.bytes = 0;
    this.dropping = false;
  }
}

/** Emits 'config' ({ codec, description }), 'au' ({ key, data (AVCC), ts90k }), 'error', 'close'. */
class RtspsSource extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.cseq = 0;
    this.q = new ByteQueue();
    this.pending = null; // { resolve, reject }
    this.session = null;
    this.sps = null;
    this.pps = null;
    this.configSent = false;
    this.keepalive = null;
    this.uri = `rtsps://${opts.host}:${opts.port || 322}/streaming/live/1`;
    this.dep = new H264Depacketizer((nals, ts) => this._au(nals, ts));
  }

  start() {
    const { connectFn = tls.connect } = this.opts;
    this.sock = connectFn(tlsOptions({ ...this.opts, port: this.opts.port || 322 }));
    this.sock.on('secureConnect', () => this._handshake().catch((e) => { this.emit('error', e); this.stop(); }));
    this.sock.on('data', (d) => safeData(this, d));
    this.sock.on('error', (e) => { this.pending?.reject(e); this.emit('error', e); });
    this.sock.on('close', () => { clearInterval(this.keepalive); this.pending?.reject(new Error('Camera closed the connection')); this.emit('close'); });
  }

  stop() {
    clearInterval(this.keepalive);
    try { if (this.session) this.sock?.write(this._req('TEARDOWN', this.uri, {})); } catch { /* closing */ }
    try { this.sock?.destroy(); } catch { /* closed */ }
  }

  _req(method, uri, headers) {
    this.cseq += 1;
    const h = { CSeq: this.cseq, 'User-Agent': 'Bambuzle', ...(this.session ? { Session: this.session } : {}), ...headers };
    if (this.authChallenge) h.Authorization = rtspAuthHeader(this.authChallenge, { user: 'bblp', pass: this.opts.accessCode, method, uri });
    return `${method} ${uri} RTSP/1.0\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
  }

  _send(method, uri, headers = {}) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.sock.write(this._req(method, uri, headers));
    });
  }

  async _call(method, uri, headers) {
    let res = await this._send(method, uri, headers);
    if (res.status === 401 && !this.authTried) {
      this.authTried = true;
      this.authChallenge = res.headers['www-authenticate'] || 'Basic';
      res = await this._send(method, uri, headers);
    }
    if (res.status === 401) throw Object.assign(new Error('Camera refused the access code'), { stage: 'auth' });
    if (res.status === 404 || res.status === 454) throw Object.assign(new Error('Camera stream not found — is "LAN Only Liveview" on?'), { stage: 'disabled' });
    if (res.status !== 200) throw new Error(`Camera answered RTSP ${res.status}`);
    return res;
  }

  async _handshake() {
    await this._call('OPTIONS', this.uri);
    const desc = await this._call('DESCRIBE', this.uri, { Accept: 'application/sdp' });
    const sdp = parseSdp(desc.body, desc.headers['content-base'] || this.uri);
    if (sdp.codec && sdp.codec !== 'H264') throw new Error(`Unsupported camera codec ${sdp.codec}`);
    this.sps = sdp.sps?.length >= 4 ? sdp.sps : null;
    this.pps = sdp.pps?.length ? sdp.pps : null;
    const setup = await this._call('SETUP', sdp.control, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    this.session = (setup.headers.session || '').split(';')[0] || null;
    const timeout = Number((/timeout=(\d+)/.exec(setup.headers.session || '') || [])[1]) || 60;
    await this._call('PLAY', this.uri, { Range: 'npt=0.000-' });
    this.pending = null;
    this.keepalive = setInterval(() => { try { this.sock.write(this._req('GET_PARAMETER', this.uri, {})); } catch { /* closing */ } }, Math.max(5, timeout / 2) * 1000);
    this.keepalive.unref?.();
  }

  _data(d) {
    this.q.push(d);
    for (;;) {
      if (!this.q.length) return;
      if (this.q.peek(1)[0] === 0x24) { // '$' interleaved RTP/RTCP
        if (this.q.length < 4) return;
        const h = this.q.peek(4);
        const len = h.readUInt16BE(2);
        if (this.q.length < 4 + len) return;
        this.q.consume(4);
        const pkt = this.q.take(len);
        if (h[1] === 0) this.dep.push(pkt);
        continue;
      }
      // RTSP response: headers must end within MAX_RTSP_HEAD
      const window = this.q.peek(Math.min(this.q.length, MAX_RTSP_HEAD));
      const headEnd = window.indexOf('\r\n\r\n');
      if (headEnd < 0) {
        if (this.q.length >= MAX_RTSP_HEAD) throw new Error('Malformed RTSP response');
        return;
      }
      const head = window.subarray(0, headEnd).toString('latin1');
      const [statusLine, ...hl] = head.split('\r\n');
      if (!/^RTSP\/1\.0 \d{3}/.test(statusLine)) throw new Error('Unexpected data from the camera'); // e.g. a server→client request
      const headers = {};
      for (const l of hl) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      const cl = headers['content-length'] ?? '0';
      if (!/^\d{1,6}$/.test(cl) || Number(cl) > MAX_RTSP_BODY) throw new Error('Malformed RTSP Content-Length'); // review #2
      const len = Number(cl);
      if (this.q.length < headEnd + 4 + len) return;
      this.q.consume(headEnd + 4);
      const body = this.q.take(len).toString('utf8');
      const status = Number(/^RTSP\/1\.0 (\d{3})/.exec(statusLine)[1]);
      const p = this.pending;
      this.pending = null;
      p?.resolve({ status, headers, body });
    }
  }

  _au(nals, ts) {
    let key = false;
    const parts = [];
    let paramsChanged = false;
    for (const n of nals) {
      const t = n[0] & 0x1f;
      if (t === 7) { if (n.length >= 4 && !n.equals(this.sps || Buffer.alloc(0))) { this.sps = n; paramsChanged = true; } continue; }
      if (t === 8) { if (n.length >= 1 && !n.equals(this.pps || Buffer.alloc(0))) { this.pps = n; paramsChanged = true; } continue; }
      if (t === 9 || t === 6) continue; // AUD / SEI: not needed by the decoder
      if (t === 5) key = true;
      const len = Buffer.alloc(4);
      len.writeUInt32BE(n.length);
      parts.push(len, n);
    }
    if (!parts.length) return;
    // First config, or the camera changed SPS/PPS (e.g. resolution): (re)announce at a keyframe (review #7)
    if (this.sps && this.pps && (!this.configSent || (paramsChanged && key))) {
      this.configSent = true;
      this.emit('config', { ...avcConfig(this.sps, this.pps), sps: this.sps, pps: this.pps });
    }
    if (!this.configSent) return; // can't decode anything before SPS/PPS
    this.emit('au', { key, data: Buffer.concat(parts), ts90k: ts });
  }
}

// ─── Hub: one upstream per printer, many viewers ───

/**
 * @param {object} opts — { serial, protocol: 'jpeg-tls'|'rtsps', host, accessCode, tlsVerify, ca?, connectFn?, log }
 * Viewers subscribe with a callback receiving { type: 'jpeg'|'config'|'au', ... }.
 */
class CameraHub extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.viewers = new Set();
    this.source = null;
    this.idleTimer = null;
    this.retryTimer = null;
    this.stallTimer = null;
    this.attempt = 0;
    this.lastJpeg = null;
    this.config = null;
    this.gop = []; // access units since the last keyframe, so a new viewer can start decoding at once
    this.gopBytes = 0;
    this.status = { state: 'idle', error: null };
  }

  subscribe(fn) {
    this.viewers.add(fn);
    clearTimeout(this.idleTimer);
    if (this.config) fn({ type: 'config', ...this.config });
    for (const au of this.gop) fn({ type: 'au', ...au });
    if (this.lastJpeg) fn({ type: 'jpeg', data: this.lastJpeg });
    if (!this.source && !this.retryTimer) this._connect();
    return () => {
      this.viewers.delete(fn);
      if (!this.viewers.size) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), this.opts.idleMs ?? IDLE_CLOSE_MS);
        this.idleTimer.unref?.();
      }
    };
  }

  _emit(msg) {
    for (const v of this.viewers) { try { v(msg); } catch { /* a viewer's write failed; it unsubscribes on close */ } }
  }

  _connect() {
    this.retryTimer = null;
    const Src = this.opts.protocol === 'rtsps' ? RtspsSource : JpegTlsSource;
    const src = new Src(this.opts);
    this.source = src;
    this.status = { state: 'connecting', error: null };
    const alive = () => {
      clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => { this.status.error = 'No video from the camera'; src.stop(); }, STALL_MS);
      this.stallTimer.unref?.();
    };
    alive();
    src.on('jpeg', (data) => { this.attempt = 0; this.status = { state: 'streaming', error: null }; alive(); this.lastJpeg = data; this._emit({ type: 'jpeg', data }); });
    src.on('config', (cfg) => { this.config = cfg; this.gop = []; this.gopBytes = 0; this.gopFull = false; this._emit({ type: 'config', ...cfg }); });
    src.on('au', (au) => {
      this.attempt = 0;
      this.status = { state: 'streaming', error: null };
      alive();
      if (au.key) { this.gop = []; this.gopBytes = 0; this.gopFull = false; }
      // Once the replay buffer is full, stop adding until the next keyframe — a GOP with holes can't be decoded
      if (!this.gopFull && this.gopBytes + au.data.length < 8 * 1024 * 1024) { this.gop.push(au); this.gopBytes += au.data.length; } else this.gopFull = true;
      this._emit({ type: 'au', ...au });
    });
    src.on('error', (e) => { this.status.error = e.message; this.status.stage = e.stage || null; this.opts.log?.debug?.({ serial: this.opts.serial, err: e.message }, 'Camera error'); });
    src.on('close', () => {
      if (this.source !== src) return;
      clearTimeout(this.stallTimer);
      this.source = null;
      this.gop = [];
      this.gopBytes = 0;
      this.config = null;
      this._emit({ type: 'status', state: 'reconnecting', error: this.status.error });
      if (!this.viewers.size) { this.status.state = 'idle'; return; }
      // Refused access code / liveview off: retry slowly — hammering won't fix it
      const delay = this.status.stage ? 30000 : RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
      this.attempt += 1;
      this.status.state = 'reconnecting';
      this.retryTimer = setTimeout(() => this._connect(), delay);
      this.retryTimer.unref?.();
    });
    src.start();
  }

  close() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.stallTimer);
    this.retryTimer = null;
    const src = this.source;
    this.source = null;
    src?.stop();
    this.gop = [];
    this.config = null;
    this.lastJpeg = null;
    this.status = { state: 'idle', error: null };
    this._emit({ type: 'end' }); // viewers' responses end; they reconnect to the current hub (review #5)
    this.viewers.clear();
    this.emit('closed');
  }
}

/** Registry: one hub per printer; a hub is replaced when its address/code/protocol changes. */
function createCameraStreams({ log, tlsVerify = true, connectFn, ca } = {}) {
  const hubs = new Map();
  function hubFor(serial, { protocol, host, accessCode, port }) {
    const key = `${protocol}|${host}|${port}|${accessCode}`;
    const h = hubs.get(serial);
    if (h && h.key === key) return h.hub;
    h?.hub.close();
    const hub = new CameraHub({ serial, protocol, host, accessCode, port, tlsVerify, connectFn, ca, log }); // port: tests only
    hubs.set(serial, { key, hub });
    return hub;
  }
  function closeAll() { for (const { hub } of hubs.values()) hub.close(); hubs.clear(); }
  function viewerCount(serial) { return hubs.get(serial)?.hub.viewers.size || 0; }
  return { hubFor, closeAll, viewerCount };
}

module.exports = { createCameraStreams, CameraHub, JpegTlsSource, RtspsSource, H264Depacketizer, parseSdp, avcConfig, rtspAuthHeader, jpegAuthPacket };
