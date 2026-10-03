'use strict';

// Test-only fake printer camera: RTSPS (TLS with the throwaway test certificate, CN 01S00TEST000001),
// Digest auth for user bblp, DESCRIBE/SETUP/PLAY, then H.264 over interleaved RTP like an X1/H2.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const FIX = path.join(__dirname, '..', 'fixtures', 'tls');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function packetize(nalUnit, ts, last, seqRef) {
  const out = [];
  const rtp = (payload, marker) => {
    const h = Buffer.alloc(12);
    h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | 96;
    h.writeUInt16BE(seqRef.seq++ & 0xffff, 2); h.writeUInt32BE(ts >>> 0, 4); h.writeUInt32BE(0x1234, 8);
    return Buffer.concat([h, payload]);
  };
  if (nalUnit.length <= 1400) { out.push(rtp(nalUnit, last)); return out; }
  const hdr = nalUnit[0];
  const body = nalUnit.subarray(1);
  for (let i = 0; i < body.length; i += 1400) {
    const start = i === 0; const end = i + 1400 >= body.length;
    out.push(rtp(Buffer.concat([Buffer.from([(hdr & 0xe0) | 28, (start ? 0x80 : 0) | (end ? 0x40 : 0) | (hdr & 0x1f)]), body.subarray(i, i + 1400)]), last && end));
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.accessCode
 * @param {function} opts.nextFrame — (i) => { nals: Buffer[] } for frame i
 * @param {number} [opts.fps]
 * @param {number} [opts.maxFrames] — stop after this many frames (default: run until the client leaves)
 */
function startFakeRtsps({ accessCode, nextFrame, fps = 10, maxFrames = Infinity }) {
  const log = { methods: [], conns: 0 };
  const server = tls.createServer({ cert: fs.readFileSync(path.join(FIX, 'printer.pem')), key: fs.readFileSync(path.join(FIX, 'printer.key')) }, (s) => {
    log.conns++;
    let buf = '';
    let timer = null;
    s.on('close', () => clearInterval(timer));
    s.on('error', () => clearInterval(timer));
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
        if (method !== 'OPTIONS') {
          const expect = md5(`${md5(`bblp:Bambu:${accessCode}`)}:n0nce:${md5(`${method}:${uri}`)}`);
          if (!(h.authorization || '').includes(`response="${expect}"`)) { reply(401, { 'WWW-Authenticate': 'Digest realm="Bambu", nonce="n0nce"' }); continue; }
        }
        if (method === 'OPTIONS') reply(200, { Public: 'DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
        else if (method === 'DESCRIBE') reply(200, { 'Content-Type': 'application/sdp', 'Content-Base': `${uri}/` }, ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', 'a=control:trackID=1'].join('\r\n'));
        else if (method === 'SETUP') reply(200, { Session: 'S1;timeout=60', Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
        else if (method === 'PLAY') {
          reply(200, { Session: 'S1' });
          let n = 0;
          const seqRef = { seq: 0 };
          const send = () => {
            if (n >= maxFrames || s.destroyed) { clearInterval(timer); return; }
            const { nals } = nextFrame(n);
            const ts = n * Math.round(90000 / fps);
            nals.forEach((u, k) => {
              for (const p of packetize(u, ts, k === nals.length - 1, seqRef)) s.write(Buffer.concat([Buffer.from([0x24, 0, p.length >> 8, p.length & 0xff]), p]));
            });
            n++;
          };
          send();
          timer = setInterval(send, 1000 / fps);
        } else reply(200);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port })));
}

module.exports = { startFakeRtsps };
