'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  describeHmsCode,
  parseHmsErrors,
  formatHmsKey,
  lookupHmsCode,
  HMS_DESCRIPTIONS,
  HMS_CODES,
  HMS_META,
  HMS_WIKI_INDEX,
} = require('../src/utils/hms-codes');

test('dataset is loaded with provenance metadata', () => {
  assert.ok(Object.keys(HMS_CODES).length > 1000);
  assert.equal(HMS_META.entryCount, Object.keys(HMS_CODES).length);
  assert.match(HMS_META.source, /github\.com\/greghesp\/ha-bambulab/);
  assert.match(HMS_META.sourceLicense, /MIT/);
  assert.match(HMS_META.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  for (const key of Object.keys(HMS_CODES)) assert.match(key, /^[0-9A-F]{4}(_[0-9A-F]{4}){3}$/);
});

test('formatHmsKey formats attr/code as AAAA_AAAA_CCCC_CCCC', () => {
  assert.equal(formatHmsKey(0x07002000, 0x00020001), '0700_2000_0002_0001');
  assert.equal(formatHmsKey(0x0c000100, 0x0001000a), '0C00_0100_0001_000A');
  // Negative (signed) ints from JSON are treated as unsigned 32-bit.
  assert.equal(formatHmsKey(-1, 0), 'FFFF_FFFF_0000_0000');
});

test('known AMS code: slot runout with per-code wiki link', () => {
  const info = lookupHmsCode(0x07002000, 0x00020001);
  assert.equal(info.key, '0700_2000_0002_0001');
  assert.match(info.description, /AMS A Slot 1 filament has run out/);
  assert.equal(info.subsystem, 'ams');
  assert.equal(info.severity, 'serious');
  assert.equal(info.known, true);
  assert.equal(info.match, 'exact');
  assert.equal(info.wikiUrl, 'https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0700_2000_0002_0001');
});

test('known non-AMS code: heatbed heater fault', () => {
  const info = lookupHmsCode(0x03000100, 0x00010003);
  assert.match(info.description, /heatbed temperature is abnormal/i);
  assert.equal(info.subsystem, 'motion-controller');
  assert.equal(info.severity, 'fatal');
  assert.equal(info.known, true);
  assert.equal(info.wikiUrl, 'https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0300_0100_0001_0003');
  assert.equal(describeHmsCode(0x03000100, 0x00010003), info.description);
});

test('known code without a wiki page links the HMS index', () => {
  const info = lookupHmsCode(0x03000100, 0x00010001);
  assert.equal(info.known, true);
  assert.equal(info.wikiUrl, HMS_WIKI_INDEX);
});

test('model-specific text variants are honoured when a model is given', () => {
  const generic = describeHmsCode(0x03000200, 0x00010001);
  const h2d = describeHmsCode(0x03000200, 0x00010001, 'H2D');
  assert.match(generic, /^The nozzle temperature/);
  assert.match(h2d, /right nozzle/);
});

test('AMS unit not enumerated in the dataset falls back to unit A text, renamed', () => {
  // AMS unit index 0x09 (J) does not exist in the dataset; unit A's entry does.
  assert.equal(HMS_CODES['0709_2000_0002_0001'], undefined);
  const info = lookupHmsCode(0x07092000, 0x00020001);
  assert.equal(info.match, 'ams-unit-generic');
  assert.equal(info.known, true);
  assert.match(info.description, /AMS J Slot 1 filament has run out/);
  assert.equal(info.key, '0709_2000_0002_0001');
});

test('unknown code falls back to the hex key and the HMS wiki index', () => {
  const info = lookupHmsCode(0x0f0f0f0f, 0x00049999);
  assert.equal(info.known, false);
  assert.equal(info.match, 'none');
  assert.equal(info.description, 'HMS error 0F0F_0F0F_0004_9999');
  assert.equal(info.wikiUrl, 'https://wiki.bambulab.com/en/hms/home');
  assert.equal(info.severity, 'info');
  assert.equal(info.subsystem, 'unknown');
});

test('parseHmsErrors keeps the shape src/index.js relies on', () => {
  const parsed = parseHmsErrors([
    { attr: 0x07002000, code: 0x00020001 },
    { attr: 0x0f0f0f0f, code: 0x00049999 },
  ]);
  assert.equal(parsed.length, 2);
  for (const e of parsed) {
    assert.equal(typeof e.key, 'string');
    assert.equal(typeof e.description, 'string');
    assert.ok(e.description.length > 0);
    assert.equal(typeof e.wikiUrl, 'string');
    assert.ok(e.wikiUrl.startsWith('https://wiki.bambulab.com/'));
    assert.ok(['fatal', 'serious', 'common', 'info', 'unknown'].includes(e.severity));
    assert.equal(typeof e.subsystem, 'string');
    assert.equal(typeof e.known, 'boolean');
  }
  assert.deepEqual(
    { attr: parsed[0].attr, code: parsed[0].code, key: parsed[0].key },
    { attr: 0x07002000, code: 0x00020001, key: '0700_2000_0002_0001' },
  );
  assert.equal(parsed[1].description, 'HMS error 0F0F_0F0F_0004_9999');
});

test('parseHmsErrors tolerates non-array and junk input', () => {
  assert.deepEqual(parseHmsErrors(undefined), []);
  assert.deepEqual(parseHmsErrors({}), []);
  assert.deepEqual(parseHmsErrors([null, 3]), []);
});

test('HMS_DESCRIPTIONS remains a key -> description map', () => {
  assert.match(HMS_DESCRIPTIONS['0700_2000_0002_0001'], /run out/);
  assert.ok(Object.values(HMS_DESCRIPTIONS).every((d) => typeof d === 'string' && d.length > 0));
});
