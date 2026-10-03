'use strict';

// Test-only H.264 generator: a real, decodable Baseline-profile bitstream with no encoder involved.
// IDR frames are made of I_PCM macroblocks (raw samples); P frames skip every macroblock (copy the
// previous frame). Used to check parseSps, the fMP4 muxer and browser playback end to end.

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  bit(b) { this.cur = (this.cur << 1) | (b & 1); this.n++; if (this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
  u(v, bits) { for (let i = bits - 1; i >= 0; i--) this.bit((v >> i) & 1); }
  ue(v) { const x = v + 1; const len = Math.floor(Math.log2(x)); this.u(0, len); this.u(x, len + 1); }
  se(v) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); }
  align() { while (this.n) this.bit(0); }
  byte(b) { this.u(b, 8); }
  trailing() { this.bit(1); this.align(); }
  buf() { return Buffer.from(this.bytes); }
}

/** Insert emulation-prevention bytes and prepend the NAL header. */
function nal(header, rbspBuf) {
  const out = [header];
  let zeros = 0;
  for (const b of rbspBuf) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

function makeH264({ widthMbs = 20, heightMbs = 12 } = {}) {
  const sps = (() => {
    const w = new BitWriter();
    w.u(66, 8); w.u(0, 8); w.u(30, 8); w.ue(0); w.ue(0); w.ue(2); w.ue(1); w.u(0, 1);
    w.ue(widthMbs - 1); w.ue(heightMbs - 1); w.u(1, 1); w.u(1, 1); w.u(0, 1); w.u(0, 1); w.trailing();
    return nal(0x67, w.buf());
  })();
  const pps = (() => {
    const w = new BitWriter();
    w.ue(0); w.ue(0); w.u(0, 1); w.u(0, 1); w.ue(0); w.ue(0); w.ue(0); w.u(0, 1); w.u(0, 2);
    w.se(0); w.se(0); w.se(0); w.u(1, 1); w.u(0, 1); w.u(0, 1); w.trailing();
    return nal(0x68, w.buf());
  })();
  const mbs = widthMbs * heightMbs;
  /** IDR picture: every macroblock I_PCM, shaded by `seed` so frames differ visibly. */
  function idr(seed, idrId) {
    const w = new BitWriter();
    w.ue(0); w.ue(7); w.ue(0); w.u(0, 4); w.ue(idrId % 2); w.u(0, 1); w.u(0, 1); w.se(0); w.ue(1);
    for (let m = 0; m < mbs; m++) {
      w.ue(25); // I_PCM
      w.align();
      const x = m % widthMbs; const y = Math.floor(m / widthMbs);
      const luma = 16 + ((x * 9 + y * 5 + seed * 23) % 200);
      for (let i = 0; i < 256; i++) w.byte(luma);
      for (let i = 0; i < 64; i++) w.byte(16 + ((seed * 37 + x * 7) % 220));
      for (let i = 0; i < 64; i++) w.byte(16 + ((seed * 53 + y * 11) % 220));
    }
    w.trailing();
    return nal(0x65, w.buf());
  }
  /** P picture: skip every macroblock. */
  function pSkip(frameNum) {
    const w = new BitWriter();
    w.ue(0); w.ue(5); w.ue(0); w.u(frameNum % 16, 4); w.u(0, 1); w.u(0, 1); w.u(0, 1); w.se(0); w.ue(1); w.ue(mbs); w.trailing();
    return nal(0x41, w.buf());
  }
  return { sps, pps, idr, pSkip, width: widthMbs * 16, height: heightMbs * 16 };
}

module.exports = { makeH264 };
