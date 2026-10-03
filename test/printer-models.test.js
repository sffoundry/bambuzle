'use strict';

const { test, after } = require('node:test');
const { cleanup } = require('./helpers');

after(cleanup);
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { modelKeyFromModules, modelKeyFromCloudCode, firmwareFromModules } = require('../src/utils/printer-models');
const { MqttPrinterClient } = require('../src/bambu/mqtt-client');
const { parseHmsErrors } = require('../src/utils/hms-codes');
const hmsData = require('../src/utils/hms-codes.en.json');

test('model key from get_version modules (product_name, then hw_ver/project_name rules)', () => {
  assert.equal(modelKeyFromModules([{ name: 'ota', sw_ver: '01.01.01.00' }, { product_name: 'Bambu Lab H2D' }]), 'H2D');
  assert.equal(modelKeyFromModules([{ hw_ver: 'AP05', project_name: '' }]), 'X1C');
  assert.equal(modelKeyFromModules([{ hw_ver: 'AP04', project_name: 'C12' }]), 'P1S');
  assert.equal(modelKeyFromModules([{ hw_ver: 'AP02' }]), 'X1E');
  assert.equal(modelKeyFromModules([{ hw_ver: 'AP05', project_name: 'N2S' }]), 'A1');
  assert.equal(modelKeyFromModules([{ product_name: 'Something else' }]), null);
  assert.equal(modelKeyFromModules(null), null);
  assert.equal(firmwareFromModules([{ name: 'ota', sw_ver: '01.08.02.00' }]), '01.08.02.00');
});

test('cloud model code fallback (codes confirmed on real printers)', () => {
  assert.equal(modelKeyFromCloudCode('O1D'), 'H2D');
  assert.equal(modelKeyFromCloudCode('BL-P001'), 'X1C');
  assert.equal(modelKeyFromCloudCode('N1'), 'A1MINI');
  assert.equal(modelKeyFromCloudCode('ZZZ'), null);
});

test('client sends get_version once and emits version without polluting status state', async () => {
  const published = [];
  const fake = Object.assign(new EventEmitter(), { connected: true, subscribe: (t, o, cb) => cb(null), publish: (t, p) => published.push(JSON.parse(p)), end() {} });
  const c = new MqttPrinterClient({ deviceId: 'S1', token: 't', userId: 'u', connectFn: () => fake, logger: require('pino')({ level: 'silent' }) });
  const versions = [];
  c.on('version', (_id, v) => versions.push(v));
  c.connect();
  fake.emit('connect');
  assert.ok(published.some((m) => m.info?.command === 'get_version'));
  fake.emit('message', 'device/S1/report', Buffer.from(JSON.stringify({ info: { command: 'get_version', module: [{ product_name: 'Bambu Lab H2D' }, { name: 'ota', sw_ver: '01.02.03.04' }] } })));
  assert.deepEqual(versions, [{ modelKey: 'H2D', firmwareVersion: '01.02.03.04' }]);
  assert.equal(c.mergedState.info, undefined, 'version reply not merged into status');
  published.length = 0;
  fake.emit('connect'); // reconnect: model already known → no second query
  assert.ok(!published.some((m) => m.info?.command === 'get_version'));
});

test('HMS text uses the model-specific variant when one exists', () => {
  // Find a real dataset entry with per-model text and check the lookup picks it
  const [key, entry] = Object.entries(hmsData.codes).find(([, v]) => v.m && v.m.H2D && v.m.H2D !== v.d);
  const [a1, a2, c1, c2] = key.split('_').map((h) => parseInt(h, 16));
  const attr = ((a1 << 16) | a2) >>> 0;
  const code = ((c1 << 16) | c2) >>> 0;
  assert.equal(parseHmsErrors([{ attr, code }], 'H2D')[0].description, entry.m.H2D);
  assert.equal(parseHmsErrors([{ attr, code }])[0].description, entry.d, 'no model → default text');
});

test('HMS active set: no duplicates across restarts, cleared codes re-arm', () => {
  const { reconcileHms } = require('../src/db/hms-active');
  assert.deepEqual(reconcileHms('H1', ['A', 'B']).added, ['A', 'B']);
  assert.deepEqual(reconcileHms('H1', ['A', 'B']).added, [], 'same report again (e.g. after restart) adds nothing');
  assert.deepEqual(reconcileHms('H1', ['A']), { added: [], cleared: ['B'] });
  assert.deepEqual(reconcileHms('H1', []), { added: [], cleared: ['A'] });
  assert.deepEqual(reconcileHms('H1', ['B']).added, ['B'], 'recurrence after clearing is recorded');
});
