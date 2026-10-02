'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const pino = require('pino');
const { cleanup } = require('./helpers');
const { createNtfyNotifier, createPushoverNotifier, createTelegramNotifier } = require('../src/alerts/notifiers/push');
const { AlertEngine } = require('../src/alerts/engine');
const queries = require('../src/db/queries');

const log = pino({ level: 'silent' });
const alert = { ruleName: 'Print Failed', deviceId: 'dev1', printerName: 'Alpha', severity: 'error', message: 'Print state changed to FAILED' };

let server;
let base;
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = req.url.includes('fail') ? 500 : 200;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  cleanup();
});

const last = () => received[received.length - 1];

test('ntfy JSON-publishes to the server root (UTF-8 safe) with optional bearer token', async () => {
  const ok = await createNtfyNotifier(log).notify({ ...alert, printerName: 'Drucker Ä' }, { server: `${base}/`, topic: 'my-printers', token: 'tk' });
  assert.equal(ok, true);
  const r = last();
  assert.equal(r.url, '/');
  assert.equal(r.headers.authorization, 'Bearer tk');
  assert.deepEqual(JSON.parse(r.body), {
    topic: 'my-printers',
    title: 'Bambuzle — Drucker Ä',
    message: '[Print Failed] Print state changed to FAILED',
    priority: 5,
    tags: ['rotating_light'],
  });
});

test('pushover sends JSON with token, user and mapped priority', async () => {
  const ok = await createPushoverNotifier(log, { apiBase: base }).notify({ ...alert, severity: 'info' }, { appToken: 'a', userKey: 'u' });
  assert.equal(ok, true);
  const r = last();
  assert.equal(r.url, '/1/messages.json');
  assert.deepEqual(JSON.parse(r.body), { token: 'a', user: 'u', title: 'Bambuzle — Alpha', message: '[Print Failed] Print state changed to FAILED', priority: -1 });
});

test('telegram sends to bot<token>/sendMessage', async () => {
  const ok = await createTelegramNotifier(log, { apiBase: base }).notify(alert, { botToken: '123:abc', chatId: '42' });
  assert.equal(ok, true);
  const r = last();
  assert.equal(r.url, '/bot123%3Aabc/sendMessage');
  const body = JSON.parse(r.body);
  assert.equal(body.chat_id, '42');
  assert.match(body.text, /Alpha\n\[Print Failed\]/);
});

test('missing config and HTTP failures return false instead of throwing', async () => {
  assert.equal(await createNtfyNotifier(log).notify(alert, {}), false);
  assert.equal(await createPushoverNotifier(log, { apiBase: base }).notify(alert, { appToken: 'a' }), false);
  assert.equal(await createTelegramNotifier(log, { apiBase: base }).notify(alert, {}), false);
  assert.equal(await createNtfyNotifier(log).notify(alert, { server: `${base}/fail`, topic: 'x' }), false);
  assert.equal(await createNtfyNotifier(log).notify(alert, { server: 'http://127.0.0.1:1', topic: 'x' }), false);
});

test('engine fires print_error rules once per new code through the configured channel', async () => {
  const sent = [];
  const engine = new AlertEngine(log, { notifiers: { ntfy: { notify: async (a, c) => { sent.push({ a, c }); return true; } } } });
  queries.upsertPrinter({ deviceId: 'dev1', name: 'Alpha', model: 'X1C' });
  queries.createAlertRule({ name: 'Printer error', conditionType: 'print_error', conditionConfig: {}, notifyVia: 'ntfy', notifyConfig: { topic: 't' }, cooldownSec: 0 });

  const st = (code) => ({ gcodeState: 'PAUSE', diagnostics: { printError: code == null ? null : { code, hex: '0C00_4001', active: code !== 0 && code !== 50348044 } } });
  engine.evaluate('dev1', st(0), 'Alpha');
  engine.evaluate('dev1', st(0x0c004001), 'Alpha');
  engine.evaluate('dev1', st(0x0c004001), 'Alpha'); // same code → no repeat
  engine.evaluate('dev1', st(50348044), 'Alpha'); // user cancel → ignored
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].a.message, 'Printer reported error 0C00_4001');
  assert.deepEqual(sent[0].c, { topic: 't' });
});
