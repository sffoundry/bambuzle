'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { authHeaders, startServer, cleanup, TEST_TOKEN } = require('./helpers');
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

// ─── Review findings (BAM-16 review) ───
const { _resetForTests } = require('../src/server/routes/session');

test('review #1: a parallel burst of wrong passwords cannot exceed the lockout', async () => {
  _resetForTests();
  await users.createUser({ username: 'burst', password: PW, role: 'viewer' });
  const srv = await startServer();
  try {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => login(srv.baseUrl, 'burst', `wrong pw ${i}xx`)));
    const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    assert.equal(counts[401], 10, JSON.stringify(counts));
    assert.equal(counts[429], 15);
  } finally {
    await srv.close();
    _resetForTests();
  }
});

test('review #4: a user who signed in from this IP is not locked out by guesses against their name', async () => {
  _resetForTests();
  await users.createUser({ username: 'victim', password: PW, role: 'admin' });
  const srv = await startServer({ auth: { mode: 'on', adminToken: TEST_TOKEN, trustProxy: 'loopback' } });
  const viaIp = (ip, password) => fetch(`${srv.baseUrl}/api/session`, { method: 'POST', headers: { ...json, 'X-Forwarded-For': ip }, body: JSON.stringify({ username: 'victim', password }) });
  try {
    assert.equal((await viaIp('10.0.0.5', PW)).status, 200);
    for (let i = 0; i < 10; i++) await viaIp(`10.0.1.${i + 1}`, `attacker guess ${i}`);
    assert.equal((await viaIp('10.0.2.1', PW)).status, 429, 'unknown IPs still hit the per-account lock');
    assert.equal((await viaIp('10.0.0.5', PW)).status, 200, 'the known-good IP still gets in');
  } finally {
    await srv.close();
    _resetForTests();
  }
});

test('review #2: concurrent demotions cannot remove the last active admin', async () => {
  const a = await users.createUser({ username: 'raceA', password: PW, role: 'admin' });
  const b = await users.createUser({ username: 'raceB', password: PW, role: 'admin' });
  // Demote every other active admin first so raceA/raceB are the only two
  for (const u of users.listUsers()) if (u.role === 'admin' && !u.disabled && u.id !== a.id && u.id !== b.id) await users.updateUser(u.id, { role: 'viewer' });
  const results = await Promise.allSettled([
    users.updateUser(a.id, { role: 'viewer', password: 'new password one' }),
    users.updateUser(b.id, { role: 'viewer', password: 'new password two' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(users.listUsers().filter((u) => u.role === 'admin' && !u.disabled).length, 1);
});

test('review #5/#8/#10: strict disabled flag, duplicate-create race → 409, strict ids', async () => {
  const u = await users.createUser({ username: 'strict1', password: PW, role: 'viewer' });
  await assert.rejects(users.updateUser(u.id, { disabled: 'false' }), (e) => e.status === 400);
  assert.equal(users.getUser(u.id).disabled, false);
  const dup = await Promise.allSettled([1, 2, 3].map(() => users.createUser({ username: 'dupe', password: PW, role: 'viewer' })));
  assert.equal(dup.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(dup.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
  const srv = await startServer();
  try {
    for (const id of [' 1 ', '0x1', '1e0', '-1', '0']) {
      const r = await fetch(`${srv.baseUrl}/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...json, ...authHeaders }, body: JSON.stringify({ role: 'viewer' }) });
      assert.equal(r.status, 400, id);
    }
  } finally {
    await srv.close();
  }
});

test('review #6/#7: login CSRF refused; mistyped usernames are not written to the audit trail', async () => {
  _resetForTests();
  const srv = await startServer();
  try {
    const r = await fetch(`${srv.baseUrl}/api/session`, { method: 'POST', headers: { ...json, Origin: 'http://127.0.0.1:1' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${srv.baseUrl}/api/session`, { method: 'DELETE', headers: { Origin: 'http://evil.example' } })).status, 403);
    await login(srv.baseUrl, 'Sup3rSecretPw!', 'whatever-password');
    const rows = await (await fetch(`${srv.baseUrl}/api/audit?limit=50`, { headers: authHeaders })).json();
    assert.ok(!JSON.stringify(rows).includes('Sup3rSecretPw!'));
  } finally {
    await srv.close();
    _resetForTests();
  }
});

test('review #3/#9: disabling a user drops their live WebSocket; own-password guesses are limited', async () => {
  _resetForTests();
  const u = await users.createUser({ username: 'wsuser', password: PW, role: 'operator' });
  const srv = await startServer();
  try {
    const { cookie } = await login(srv.baseUrl, 'wsuser', PW);
    const ws = new WebSocket(`${srv.baseUrl.replace('http', 'ws')}/ws`, { headers: { cookie } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const closed = new Promise((res) => ws.once('close', res));
    // Own-password guesses: 5 wrong → then 429
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${srv.baseUrl}/api/me/password`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ currentPassword: `nope nope ${i}`, newPassword: 'another long password' }) });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
    const r = await fetch(`${srv.baseUrl}/api/users/${u.id}`, { method: 'PATCH', headers: { ...json, ...authHeaders }, body: JSON.stringify({ disabled: true }) });
    assert.equal(r.status, 200);
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    await srv.close();
    _resetForTests();
  }
});
