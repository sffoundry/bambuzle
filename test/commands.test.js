'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { authHeaders, fakePrinterManager, startServer, cleanup } = require('./helpers');
const { planCommand } = require('../src/server/printer-commands');
const { MqttPrinterClient } = require('../src/bambu/mqtt-client');
const queries = require('../src/db/queries');
const pino = require('pino');

after(cleanup);

const json = { 'Content-Type': 'application/json', ...authHeaders };

test('planCommand gates by state and validates speed', () => {
  assert.equal(planCommand('stop', null, { gcodeState: 'IDLE' }).status, 409);
  assert.equal(planCommand('resume', null, { gcodeState: 'RUNNING' }).status, 409);
  assert.equal(planCommand('pause', null, undefined).status, 409);
  assert.equal(planCommand('reboot', null, { gcodeState: 'RUNNING' }).status, 400);
  assert.equal(planCommand('set_speed', '7', { gcodeState: 'RUNNING' }).status, 400);
  assert.equal(planCommand('set_speed', 'abc', { gcodeState: 'RUNNING' }).status, 400);
  const ok = planCommand('set_speed', 3, { gcodeState: 'RUNNING' });
  assert.equal(ok.cmd.print.command, 'print_speed');
  assert.equal(ok.cmd.print.param, '3');
  assert.equal(ok.label, 'set speed Sport');
  const a = planCommand('pause', null, { gcodeState: 'RUNNING' }).cmd.print.sequence_id;
  const b = planCommand('pause', null, { gcodeState: 'RUNNING' }).cmd.print.sequence_id;
  assert.notEqual(a, b, 'unique sequence ids');
});

/** MqttPrinterClient with a fake broker connection; `reply` decides how the "printer" answers. */
function fakeClient(reply) {
  const c = new MqttPrinterClient({ deviceId: 'dev1', token: 't', userId: 'u', logger: pino({ level: 'silent' }) });
  c.published = [];
  c.client = Object.assign(new EventEmitter(), {
    connected: true,
    publish: (topic, payload) => {
      const cmd = JSON.parse(payload);
      c.published.push(cmd);
      const r = reply(cmd);
      if (r) setImmediate(() => c.emit('raw', 'dev1', r));
    },
  });
  return c;
}


test('confirmed, rejected and unconfirmed replies are reported and audited', async () => {
  const { createApp } = require('../src/server/app');
  const { createAdminAuth } = require('../src/server/admin-auth');
  const http = require('http');
  const { dataDir, TEST_TOKEN } = require('./helpers');
  queries.upsertPrinter({ deviceId: 'dev1', name: 'Alpha', model: 'X1C' });

  async function call(client, state, body, cloud = 'authenticated') {
    const log = pino({ level: 'silent' });
    const adminAuth = createAdminAuth({ auth: { mode: 'on', adminToken: TEST_TOKEN }, dataDir, log });
    const pm = fakePrinterManager({ liveStates: { dev1: { gcodeState: state } }, clients: { dev1: client } });
    const app = createApp(pm, { onAuthenticated() {} }, adminAuth, { getCloudAuthStatus: () => cloud, dataDir });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/printers/dev1/command`, { method: 'POST', headers: json, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  const echo = (result, reason) => (cmd) => ({ print: { command: cmd.print.command, sequence_id: cmd.print.sequence_id, result, reason } });

  let r = await call(fakeClient(echo('success')), 'RUNNING', { command: 'pause' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.acknowledged, r.body.outcome], [true, true, 'confirmed by printer']);

  r = await call(fakeClient(echo('fail', 'authorization required')), 'RUNNING', { command: 'stop' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.outcome, /rejected it: authorization required/);

  // A reply for a different sequence id must not count as confirmation
  r = await call(fakeClient((cmd) => ({ print: { command: cmd.print.command, sequence_id: 'other', result: 'success' } })), 'PAUSE', { command: 'resume' });
  assert.deepEqual([r.body.ok, r.body.acknowledged], [true, false]);
  assert.equal(r.body.outcome, 'sent, no confirmation from printer');

  r = await call(fakeClient(() => null), 'IDLE', { command: 'stop' });
  assert.equal(r.status, 409);

  r = await call(fakeClient(() => null), 'RUNNING', { command: 'pause' }, 'needs_login');
  assert.equal(r.status, 503);

  const audit = queries.getEvents('dev1', { limit: 50 }).filter((e) => e.event_type === 'command').map((e) => e.message);
  assert.ok(audit.some((m) => /pause: confirmed/.test(m)));
  assert.ok(audit.some((m) => /stop: printer rejected/.test(m)));
  assert.ok(audit.some((m) => /Rejected command "stop"/.test(m)));
});

// ─── Review 2 fixes ───

test('inherited names and non-string commands are rejected without throwing — review 2 #1', () => {
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', ['pause'], ['stop'], { a: 1 }, 42, null]) {
    const r = planCommand(bad, null, { gcodeState: 'RUNNING' });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('stale UI: expected state / task must match the printer — review 2 #2', () => {
  const live = { gcodeState: 'PAUSE', taskId: 'B' };
  assert.equal(planCommand('resume', null, live, { state: 'RUNNING' }).status, 409, 'clicked Pause, printer had paused itself');
  assert.equal(planCommand('stop', null, live, { state: 'PAUSE', taskId: 'A' }).status, 409, 'dialog was for job A');
  assert.ok(planCommand('stop', null, live, { state: 'PAUSE', taskId: 'B' }).cmd);
  assert.ok(planCommand('resume', null, live).cmd, 'API clients may omit expectations');
});

test('crafted commands over HTTP get 400 and the server keeps running; concurrent commands get 429', async () => {
  const { createApp } = require('../src/server/app');
  const { createAdminAuth } = require('../src/server/admin-auth');
  const http = require('http');
  const { dataDir, TEST_TOKEN } = require('./helpers');
  queries.upsertPrinter({ deviceId: 'dev1', name: 'Alpha', model: 'X1C' });
  const slow = fakeClient(() => null); // never replies → 4 s timeout keeps the first command in flight
  const log = pino({ level: 'silent' });
  const adminAuth = createAdminAuth({ auth: { mode: 'on', adminToken: TEST_TOKEN }, dataDir, log });
  const pm = fakePrinterManager({ liveStates: { dev1: { gcodeState: 'RUNNING' } }, clients: { dev1: slow } });
  const app = createApp(pm, { onAuthenticated() {} }, adminAuth, { getCloudAuthStatus: () => 'authenticated', dataDir });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/printers/dev1/command`;
  const post = (body) => fetch(url, { method: 'POST', headers: json, body: JSON.stringify(body) });
  try {
    for (const command of ['toString', '__proto__', ['pause']]) assert.equal((await post({ command })).status, 400);
    const first = post({ command: 'pause' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post({ command: 'pause' })).status, 429);
    assert.equal((await first).status, 200);
    assert.equal((await post({ command: 'pause' })).status, 200, 'lock released after reply/timeout');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
