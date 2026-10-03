'use strict';

// BAM-9: minimal fragmented-MP4 (ISO BMFF) muxer for one H.264 video track, so a browser can play the
// printer's RTSP stream through Media Source Extensions — which, unlike WebCodecs, also works when
// Bambuzle is opened over plain http://<LAN IP> (not a secure context). No transcoding.
// Layout: init = ftyp + moov(mvhd, trak(tkhd, mdia(mdhd, hdlr, minf(vmhd, dinf, stbl(stsd(avc1(avcC)),
// empty stts/stsc/stsz/stco)))), mvex(trex)); then one moof + mdat per frame.

const TIMESCALE = 90000; // RTP H.264 clock

function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(n)))); return b; };
const full = (type, version, flags, ...payload) => box(type, u8(version), Buffer.from([(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** Remove emulation-prevention bytes (00 00 03 → 00 00). */
function rbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

/** Width/height from an H.264 SPS (incl. high-profile fields and frame cropping). Exported for tests. */
function parseSps(sps) {
  const b = rbsp(sps);
  let bit = 8; // skip the NAL header byte
  const total = b.length * 8;
  // Bounds-checked: a corrupt SPS throws instead of reading zeros forever (review #4)
  const read = (n) => {
    if (bit + n > total) throw new Error('Truncated SPS');
    let v = 0;
    for (let i = 0; i < n; i++) { v = (v * 2) + ((b[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
    return v;
  };
  const ue = () => { let z = 0; while (read(1) === 0) { if (++z > 31) throw new Error('Corrupt SPS'); } return (2 ** z - 1) + read(z); };
  const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
  const profile = read(8); read(8); read(8); ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma === 3) read(1);
    ue(); ue(); read(1);
    if (read(1)) { // scaling matrices
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (read(1)) { let last = 8; let next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next !== 0) next = (last + se() + 256) % 256; last = next === 0 ? last : next; } }
      }
    }
  }
  ue(); // log2_max_frame_num
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) { read(1); se(); se(); const n = ue(); if (n > 255) throw new Error('Corrupt SPS'); for (let i = 0; i < n; i++) se(); }
  else if (pocType !== 2) throw new Error('Corrupt SPS');
  ue(); read(1);
  const wMbs = ue() + 1;
  const hMapUnits = ue() + 1;
  const frameMbsOnly = read(1);
  if (!frameMbsOnly) read(1);
  read(1);
  let [cl, cr, ct, cb] = [0, 0, 0, 0];
  if (read(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  const cropX = chroma === 0 ? 1 : subW;
  const cropY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
  const width = wMbs * 16 - (cl + cr) * cropX;
  const height = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * cropY;
  if (!(width > 0 && width <= 8192 && height > 0 && height <= 8192)) throw new Error('Implausible SPS dimensions');
  return { width, height };
}

function initSegment({ avcc, width, height }) {
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomiso2avc1iso6mp41'));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('Bambuzle camera\0'));
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), box('avcC', avcc));
  const stbl = box('stbl', full('stsd', 0, 0, u32(1), avc1), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const minf = box('minf', full('vmhd', 0, 1, Buffer.alloc(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/** One fragment holding one frame. `data` is AVCC (length-prefixed NAL units). */
function mediaSegment({ seq, baseTime, duration, data, key }) {
  // sample flags: keyframe = depends on nothing; others = depend on others + non-sync
  const flags = key ? 0x02000000 : 0x01010000;
  const tfhd = full('tfhd', 0, 0x020000, u32(1)); // default-base-is-moof
  const tfdt = full('tfdt', 1, 0, u64(baseTime));
  const trunSize = 12 + 4 + 4 + 12; // header + count + data offset + 1 sample × (duration, size, flags)
  const moofSize = 8 + (8 + 8) + 8 + (tfhd.length + tfdt.length + trunSize);
  const trun = full('trun', 0, 0x000701, u32(1), u32(moofSize + 8), u32(duration), u32(data.length), u32(flags));
  const moof = box('moof', full('mfhd', 0, 0, u32(seq)), box('traf', tfhd, tfdt, trun));
  return Buffer.concat([moof, box('mdat', data)]);
}

/**
 * Per-viewer muxer: feed config + access units (with 90 kHz RTP timestamps), get fMP4 bytes.
 * Each frame is written when the next one arrives, so its duration is exact (one-frame latency).
 */
class Fmp4Writer {
  constructor(write) {
    this.write = write;
    this.reset();
  }

  reset() {
    this.started = false;
    this.pending = null;
    this.seq = 1;
    this.time = 0;
    this.lastTs = null;
  }

  /**
   * (Re)start with a decoder config. Throws on a corrupt SPS. Decode time and sequence keep counting
   * across re-inits (reconnects, resolution changes), so the browser's timeline never jumps back (review #6).
   */
  config({ avcc, sps }) {
    const { width, height } = parseSps(sps);
    this.pending = null;
    this.lastTs = null;
    this.write(initSegment({ avcc, width, height }));
    this.started = true;
  }

  frame({ data, key, ts90k }) {
    if (!this.started) return;
    if (this.pending && this.lastTs !== null) {
      let d = (ts90k - this.lastTs) >>> 0; // RTP timestamps wrap at 2^32
      if (d === 0 || d > TIMESCALE * 2) d = 6000; // missing/odd timing → assume 15 fps
      this.write(mediaSegment({ seq: this.seq++, baseTime: this.time, duration: d, data: this.pending.data, key: this.pending.key }));
      this.time += d;
    }
    this.pending = { data, key };
    this.lastTs = ts90k;
  }
}

module.exports = { Fmp4Writer, initSegment, mediaSegment, parseSps, TIMESCALE };
