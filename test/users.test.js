'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { authHeaders, startServer, cleanup } = require('./helpers');
const users = require('../src/db/users');
const { requiredRole, hasRole } = require('../src/server/permissions');
const queries = require('../src/db/queries');

after(cleanup);

const json = { 'Content-Type': 'application/json' };
const PW = 'correct horse battery';

async function login(base, username, password) {
  const r = await fetch(`${base}/api/session`, { method: 'POST', headers: json, body: JSON.stringify({ username, password }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, cookie, body: await r.json() };
}

test('password hashing: scrypt format, verify, wrong password, tamper', async () => {
  const h = await users.hashPassword(PW);
  assert.match(h, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await users.verifyPassword(PW, h), true);
  assert.equal(await users.verifyPassword('wrong password!', h), false);
  assert.equal(await users.verifyPassword(PW, 'garbage'), false);
  assert.notEqual(await users.hashPassword(PW), h, 'salted');
});

test('permission table: roles per route, unlisted writes default to admin, case-insensitive', () => {
  const cases = [
    ['GET', '/api/printers', 'viewer'], ['GET', '/api/stats', 'viewer'], ['GET', '/api/maintenance', 'viewer'],
    ['POST', '/api/printers/S1/command', 'operator'], ['GET', '/api/printers/S1/files', 'operator'],
    ['POST', '/api/maintenance/tasks/1/done', 'operator'],
    ['GET', '/api/alerts', 'admin'], ['GET', '/api/audit', 'admin'], ['GET', '/api/system', 'admin'],
    ['GET', '/api/printers/S1/connection', 'admin'], ['PUT', '/api/printers/S1/connection', 'admin'],
    ['POST', '/api/printers', 'admin'], ['DELETE', '/api/printers/S1', 'admin'],
    ['GET', '/api/users', 'admin'], ['GET', '/API/Users', 'admin'], ['POST', '/api/auth/logout', 'admin'],
    ['GET', '/api/auth/status', 'viewer'], ['GET', '/api/me', 'viewer'], ['POST', '/api/me/password', 'viewer'],
    ['POST', '/api/some/new/route', 'admin'], ['GET', '/api/some/new/route', 'viewer'],
  ];
  for (const [m, p, role] of cases) assert.equal(requiredRole(m, p), role, `${m} ${p}`);
  assert.ok(hasRole('admin', 'operator') && hasRole('operator', 'operator') && !hasRole('viewer', 'operator'));
  assert.equal(hasRole(undefined, 'viewer'), false);
});

test('accounts end to end: sign-in, role enforcement, revocation, last-admin guard, no secrets leaked', async () => {
  queries.upsertPrinter({ deviceId: 'USR000001', name: 'U', model: 'X1C' });
  const srv = await startServer();
  const base = srv.baseUrl;
  const call = (method, url, { cookie, body, headers = {} } = {}) => fetch(base + url, { method, headers: { ...json, ...(cookie ? { cookie } : {}), ...headers }, body: body && JSON.stringify(body) });
  try {
    // Mode flips to 'users' once an account exists; admin token still works (break-glass)
    assert.equal((await (await call('GET', '/api/session')).json()).mode, 'token');
    let r = await call('POST', '/api/users', { headers: authHeaders, body: { username: 'Alice', password: PW, role: 'admin' } });
    assert.equal(r.status, 201);
    const alice = await r.json();
    assert.equal(alice.password_hash, undefined);
    assert.equal((await (await call('GET', '/api/session')).json()).mode, 'users');
    assert.equal((await call('POST', '/api/users', { headers: authHeaders, body: { username: 'alice', password: PW, role: 'viewer' } })).status, 409, 'case-insensitive duplicate');
    assert.equal((await call('POST', '/api/users', { headers: authHeaders, body: { username: 'bob', password: 'short', role: 'viewer' } })).status, 400);
    assert.equal((await call('POST', '/api/users', { headers: authHeaders, body: { username: 'bob', password: PW, role: 'root' } })).status, 400);
    for (const [name, role] of [['vic', 'viewer'], ['olga', 'operator']]) {
      assert.equal((await call('POST', '/api/users', { headers: authHeaders, body: { username: name, password: PW, role } })).status, 201);
    }

    // Sign-in
    assert.equal((await login(base, 'vic', 'wrong password!')).status, 401);
    assert.equal((await login(base, 'nobody', PW)).status, 401);
    const vic = await login(base, 'VIC', PW); // case-insensitive username
    assert.equal(vic.status, 200);
    assert.match(vic.cookie, /^bambuzle_session=u\./);
    assert.deepEqual((await (await call('GET', '/api/session', { cookie: vic.cookie })).json()).user, { name: 'vic', role: 'viewer', kind: 'user' });
    const olga = await login(base, 'olga', PW);
    const ali = await login(base, 'alice', PW);

    // Role matrix through the real guard
    const status = async (who, m, u, body) => (await call(m, u, { cookie: who.cookie, body })).status;
    assert.equal(await status(vic, 'GET', '/api/printers'), 200);
    assert.equal(await status(vic, 'POST', '/api/printers/USR000001/command', { command: 'pause' }), 403);
    assert.equal(await status(vic, 'GET', '/api/alerts'), 403);
    assert.equal(await status(vic, 'GET', '/api/users'), 403);
    assert.notEqual(await status(olga, 'POST', '/api/printers/USR000001/command', { command: 'pause' }), 403, 'operator passes the guard (then printer/cloud checks apply)');
    assert.equal(await status(olga, 'GET', '/api/printers/USR000001/files'), 409, 'operator reaches files (409 = no LAN settings)');
    assert.equal(await status(olga, 'PUT', '/api/printers/USR000001/connection', { mode: 'lan' }), 403);
    assert.equal(await status(olga, 'GET', '/api/audit'), 403);
    assert.equal(await status(ali, 'GET', '/api/audit'), 200);
    assert.equal(await status(ali, 'GET', '/api/users'), 200);

    // WebSocket: any signed-in user
    const wsOk = await new Promise((resolve) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: vic.cookie } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    assert.equal(wsOk, true);

    // Own password change keeps this session, revokes others
    const vic2 = await login(base, 'vic', PW);
    assert.equal((await call('POST', '/api/me/password', { cookie: vic.cookie, body: { currentPassword: 'nope', newPassword: 'another long password' } })).status, 403);
    assert.equal((await call('POST', '/api/me/password', { cookie: vic.cookie, body: { currentPassword: PW, newPassword: 'another long password' } })).status, 200);
    assert.equal(await status(vic, 'GET', '/api/printers'), 200, 'current session kept');
    assert.equal(await status(vic2, 'GET', '/api/printers'), 401, 'other session revoked');
    assert.equal((await login(base, 'vic', PW)).status, 401, 'old password gone');

    // Admin role change / disable revokes the user's sessions immediately
    const vicId = (await (await call('GET', '/api/users', { cookie: ali.cookie })).json()).find((u) => u.username === 'vic').id;
    assert.equal((await call('PATCH', `/api/users/${vicId}`, { cookie: ali.cookie, body: { disabled: true } })).status, 200);
    assert.equal(await status(vic, 'GET', '/api/printers'), 401);
    assert.equal((await login(base, 'vic', 'another long password')).status, 401, 'disabled user cannot sign in');

    // Sign-out revokes server-side (replaying the cookie fails)
    const olgaCookie = olga.cookie;
    await call('DELETE', '/api/session', { cookie: olgaCookie });
    assert.equal((await call('GET', '/api/printers', { cookie: olgaCookie })).status, 401);

    // Last active admin can't be demoted, disabled or deleted
    assert.equal((await call('PATCH', `/api/users/${alice.id}`, { cookie: ali.cookie, body: { role: 'viewer' } })).status, 409);
    assert.equal((await call('PATCH', `/api/users/${alice.id}`, { cookie: ali.cookie, body: { disabled: true } })).status, 409);
    assert.equal((await call('DELETE', `/api/users/${alice.id}`, { cookie: ali.cookie })).status, 409);

    // Admin token still acts as admin with users present
    assert.equal((await call('GET', '/api/audit', { headers: authHeaders })).status, 200);

    // Audit: real usernames as actors; no password or hash anywhere
    const auditBody = await (await call('GET', '/api/audit?limit=500', { cookie: ali.cookie })).json();
    const rows = Array.isArray(auditBody) ? auditBody : (auditBody.entries || auditBody.rows || []);
    const text = JSON.stringify(rows);
    const actors = [...new Set(rows.map((r) => r.actor))];
    assert.ok(actors.includes('user:Alice'), JSON.stringify(actors));
    assert.ok(actors.every((a) => ['anonymous', 'admin-token', 'session'].includes(a) || a.startsWith('user:')), `unprefixed user actor: ${JSON.stringify(actors)}`);
    for (const secret of [PW, 'another long password', 'scrypt$']) assert.ok(!text.includes(secret), `audit leaks ${secret}`);
    const list = JSON.stringify(await (await call('GET', '/api/users', { cookie: ali.cookie })).json());
    assert.ok(!list.includes('scrypt$') && !list.includes('password'), 'user list carries no hashes');
  } finally {
    await srv.close();
  }
});

test('per-username lockout applies across sign-in attempts', async () => {
  await users.createUser({ username: 'lockme', password: PW, role: 'viewer' });
  const srv = await startServer();
  try {
    let last;
    for (let i = 0; i < 11; i++) last = await login(srv.baseUrl, 'lockme', `wrong password ${i}`);
    assert.equal(last.status, 429);
  } finally {
    await srv.close();
  }
});
