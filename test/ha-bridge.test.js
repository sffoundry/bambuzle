'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const pino = require('pino');
const { createHaBridge, statePayload, discoveryMessages, safeHost } = require('../src/integrations/ha-bridge');

const printers = [{ device_id: '01S00TEST000001', name: 'Test Printer A', model: 'H2D' }];

function fakeBroker() {
  const pubs = [];
  let opts;
  const c = Object.assign(new EventEmitter(), { connected: false, publish: (t, p, o) => pubs.push({ t, p, retain: o.retain }), end() {}, subscribe: () => { throw new Error('bridge must never subscribe'); } });
  return { connectFn: (url, o) => { opts = o; return c; }, client: c, pubs, opts: () => opts };
}

test('discovery: sensors + binary sensor with availability and device info', () => {
  const msgs = discoveryMessages('bambuzle', printers[0]);
  const progress = msgs.find((m) => m.topic === 'homeassistant/sensor/bambuzle_01S00TEST000001/progress/config');
  assert.equal(progress.payload.unit_of_measurement, '%');
  assert.equal(progress.payload.state_topic, 'bambuzle/01S00TEST000001/state');
  assert.equal(progress.payload.device.name, 'Test Printer A');
  assert.equal(progress.payload.availability_mode, 'all');
  assert.ok(msgs.some((m) => m.topic.startsWith('homeassistant/binary_sensor/') && m.payload.device_class === 'problem'));
  assert.ok(msgs.every((m) => !JSON.stringify(m.payload).includes('command_topic')), 'no command topics — read-only');
});

test('state payload', () => {
  const p = statePayload({ gcodeState: 'RUNNING', progress: 42, nozzleTemp: 220, subtaskName: 'part', hmsErrors: [{}, {}], diagnostics: { printError: { active: true } } });
  assert.deepEqual([p.gcodeState, p.progress, p.nozzleTemp, p.job, p.hmsActive, p.printError], ['RUNNING', 42, 220, 'part', 2, 'ON']);
  assert.equal(statePayload(null).gcodeState, 'UNKNOWN');
});

test('bridge: LWT, announce on connect, throttled retained state, never subscribes', async () => {
  const b = fakeBroker();
  const bridge = createHaBridge({ config: { url: 'mqtt://u:secret@broker.local:1883', throttleSec: 1 }, listPrinters: () => printers, log: pino({ level: 'silent' }), connectFn: b.connectFn }).start();
  assert.equal(b.opts().will.topic, 'bambuzle/bridge/availability');
  b.client.connected = true;
  b.client.emit('connect');
  assert.ok(b.pubs.some((p) => p.t === 'bambuzle/bridge/availability' && p.p === 'online' && p.retain));
  const discovery = b.pubs.filter((p) => p.t.startsWith('homeassistant/'));
  assert.ok(discovery.length >= 10);

  bridge.onState('01S00TEST000001', { gcodeState: 'RUNNING', progress: 1 });
  bridge.onState('01S00TEST000001', { gcodeState: 'RUNNING', progress: 2 }); // throttled
  bridge.onState('01S00TEST000001', { gcodeState: 'RUNNING', progress: 3 }); // replaces the pending one
  let states = b.pubs.filter((p) => p.t === 'bambuzle/01S00TEST000001/state');
  assert.equal(states.length, 1);
  await new Promise((r) => setTimeout(r, 1100));
  states = b.pubs.filter((p) => p.t === 'bambuzle/01S00TEST000001/state');
  assert.equal(states.length, 2);
  assert.equal(JSON.parse(states[1].p).progress, 3, 'latest state wins');
  bridge.onState('UNKNOWN000001', {}); // printers not in Bambuzle are ignored
  bridge.stop();
  assert.equal(b.pubs.at(-1).p, 'offline');
});

test('logs never include broker credentials', () => {
  assert.equal(safeHost('mqtt://user:secret@broker.local:1883'), 'broker.local:1883');
  assert.equal(safeHost('not a url'), '(invalid url)');
});
