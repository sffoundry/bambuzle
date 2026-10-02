'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const pino = require('pino');
const { dataDir, TEST_TOKEN, authHeaders, fakePrinterManager, startServer, cleanup } = require('./helpers');
const { createAdminAuth } = require('../src/server/admin-auth');

after(cleanup);

const commandBody = JSON.stringify({ action: 'stop' });
const json = { 'Content-Type': 'application/json' };

function wsOpens(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
}

test('unauthenticated requests are rejected on every guarded surface', async () => {
  const srv = await startServer();
  try {
    const cases = [
      ['GET', '/api/printers'],
      ['POST', '/api/printers/dev1/command', commandBody],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/login', JSON.stringify({ email: 'a@b.c', password: 'x' })],
      ['POST', '/api/alerts', JSON.stringify({ name: 'exfil' })],
      ['GET', '/api/printers/dev1/debug/mqtt'],
    ];
    for (const [method, url, body] of cases) {
      const res = await fetch(srv.baseUrl + url, { method, headers: json, body });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    assert.equal(await wsOpens(srv.baseUrl.replace('http', 'ws') + '/ws'), false);
  } finally {
    await srv.close();
  }
});

test('bearer token and session cookie both authorize', async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/printers`, { headers: authHeaders })).status, 200);

    const bad = await fetch(`${srv.baseUrl}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ token: 'nope' }) });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${srv.baseUrl}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ token: TEST_TOKEN }) });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    assert.equal((await fetch(`${srv.baseUrl}/api/printers`, { headers: { cookie } })).status, 200);
    const status = await (await fetch(`${srv.baseUrl}/api/session`, { headers: { cookie } })).json();
    assert.deepEqual(status, { required: true, authenticated: true, publicRead: false });
    assert.equal(await wsOpens(srv.baseUrl.replace('http', 'ws') + '/ws', { cookie }), true);
  } finally {
    await srv.close();
  }
});

test('authorized command passes the admin guard', async () => {
  const sent = [];
  const client = { connected: true, publish: (msg) => sent.push(msg), sendCommand: (msg) => sent.push(msg) };
  const srv = await startServer({ printerManager: fakePrinterManager({ clients: { dev1: client } }) });
  try {
    const res = await fetch(`${srv.baseUrl}/api/printers/dev1/command`, { method: 'POST', headers: { ...json, ...authHeaders }, body: commandBody });
    // The route still requires the server's own Bambu Cloud login; without it we get its 401 message, not admin_auth_required.
    const body = await res.json();
    assert.notEqual(body.error, 'admin_auth_required');
  } finally {
    await srv.close();
  }
});

test('publicRead allows GETs and the WebSocket but not writes', async () => {
  const srv = await startServer({ auth: { mode: 'on', adminToken: TEST_TOKEN, publicRead: true } });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/printers`)).status, 200);
    assert.equal(await wsOpens(srv.baseUrl.replace('http', 'ws') + '/ws'), true);
    const res = await fetch(`${srv.baseUrl}/api/printers/dev1/command`, { method: 'POST', headers: json, body: commandBody });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('auth off leaves the API open', async () => {
  const srv = await startServer({ auth: { mode: 'off' } });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/api/printers`)).status, 200);
    const status = await (await fetch(`${srv.baseUrl}/api/session`)).json();
    assert.equal(status.required, false);
  } finally {
    await srv.close();
  }
});

test('token is generated once into the data dir with 0600 perms, then reused', () => {
  const log = pino({ level: 'silent' });
  const tokenPath = path.join(dataDir, 'admin-token');
  fs.rmSync(tokenPath, { force: true });
  const a = createAdminAuth({ auth: { mode: 'on' }, dataDir, log });
  const first = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.ok(first.length >= 20);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.ok(a.checkToken(first));
  const b = createAdminAuth({ auth: { mode: 'on' }, dataDir, log });
  assert.ok(b.checkToken(first));
});

test('limit query params are clamped', async () => {
  const { clampLimit } = require('../src/server/routes/api');
  assert.equal(clampLimit(undefined, 200, 2000), 200);
  assert.equal(clampLimit('abc', 200, 2000), 200);
  assert.equal(clampLimit('-5', 200, 2000), 200);
  assert.equal(clampLimit('100000000', 200, 2000), 2000);
  assert.equal(clampLimit('10000', 5000, 20000), 10000);
});
