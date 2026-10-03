'use strict';

// BAM-41 operator audit trail.

// Stub the BambuLab Cloud client BEFORE the app loads (routes destructure it at require time) so the
// cloud login tests never touch the network.
const path = require('path');
// Routes destructure the exports once, so the exports delegate to this mutable stub.
const cloudStub = {
  status: 'needs_login',
  login: async () => ({ needsVerification: true }),
  verifyLogin: async () => ({ token: 'x' }),
};
const cloudAuthPath = path.resolve(__dirname, '..', 'src', 'bambu', 'auth.js');
require.cache[cloudAuthPath] = {
  id: cloudAuthPath,
  filename: cloudAuthPath,
  loaded: true,
  exports: {
    login: (...a) => cloudStub.login(...a),
    verifyLogin: (...a) => cloudStub.verifyLogin(...a),
    getAuthStatus: () => cloudStub.status,
    clearAuth: () => { cloudStub.status = 'needs_login'; },
  },
};

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TEST_TOKEN, authHeaders, fakePrinterManager, startServer, cleanup } = require('./helpers');
const auditDb = require('../src/db/audit');
const { auditThrottled, resetAuditThrottle, DENIAL_THROTTLE_MS } = require('../src/server/audit');
const { getDb } = require('../src/db/database');
const queries = require('../src/db/queries');
const config = require('../src/config');

after(cleanup);
beforeEach(() => resetAuditThrottle());

// Known secret values used below — none may ever appear in an audit row (see the last test).
const SECRETS = {
  accessCode: 'Zq9Xw8Vu',
  accessCode2: 'Kp7Lm6Nb',
  manualAccessCode: 'Rt5Yh4Gf',
  cloudPassword: 'hunter2-cloud-pw',
  verifyCode: '482913',
  webhookUrl: 'https://hooks.example.invalid/secret-path-abc123',
  botToken: '123456:SECRET-bot-token-xyz',
  pushoverKey: 'po-user-key-SECRET-9f8e',
  adminToken: TEST_TOKEN,
  wrongToken: 'guessed-wrong-token-77',
};

const J = { 'Content-Type': 'application/json' };
const H = { ...J, ...authHeaders };

function rows(action) {
  return auditDb.queryAudit({ action, limit: 2000 });
}
function last(action) {
  return rows(action)[0];
}
function clearAudit() {
  auditDb.queryAudit({ limit: 1 }); // ensures the self-creating table exists
  getDb().prepare('DELETE FROM audit_log').run();
}

async function withServer(opts, fn) {
  const srv = await startServer(opts);
  const call = (method, url, body, headers = H) => fetch(srv.baseUrl + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    return await fn({ ...srv, call });
  } finally {
    await srv.close();
  }
}

test('db module is append-only: no update/delete exports except retention pruning', () => {
  const fns = Object.keys(auditDb).filter((k) => typeof auditDb[k] === 'function');
  assert.deepEqual(fns.sort(), ['deleteOldAudit', 'insertAudit', 'queryAudit']);
  assert.throws(() => auditDb.insertAudit({ action: 'x', result: 'maybe' }), /result/);
});

test('dashboard sign-in: failure, success, sign-out — with actor attribution', async () => {
  clearAudit();
  await withServer({}, async ({ call }) => {
    assert.equal((await call('POST', '/api/session', { token: SECRETS.wrongToken }, J)).status, 401);
    let r = last('session.login');
    assert.equal(r.result, 'denied');
    assert.equal(r.actor, 'anonymous');
    assert.deepEqual(r.detail, { reason: 'invalid_token' });
    assert.equal(r.source_ip, '127.0.0.1');
    assert.ok(r.request_id);

    const ok = await call('POST', '/api/session', { token: TEST_TOKEN }, J);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-request-id'), last('session.login').request_id, 'request id echoed to the client');
    r = last('session.login');
    assert.deepEqual([r.result, r.actor], ['ok', 'admin-token']);

    const cookie = ok.headers.get('set-cookie').split(';')[0];
    SECRETS.sessionCookie = cookie.split('=')[1];
    // An authenticated cookie client's write is attributed to 'session'
    assert.equal((await call('POST', '/api/alerts', { name: 'via cookie', conditionType: 'state_change' }, { ...J, cookie })).status, 201);
    assert.equal(last('alert.create').actor, 'session');
    // …and a bearer client's to 'admin-token'
    assert.equal((await call('POST', '/api/alerts', { name: 'via bearer', conditionType: 'state_change' })).status, 201);
    assert.equal(last('alert.create').actor, 'admin-token');
    // A stale/invalid bearer next to a valid cookie: the cookie authorised it
    await call('POST', '/api/alerts', { name: 'mixed', conditionType: 'state_change' }, { ...J, cookie, Authorization: 'Bearer nope' });
    assert.equal(last('alert.create').actor, 'session');

    assert.equal((await call('DELETE', '/api/session', undefined, { cookie })).status, 200);
    r = last('session.logout');
    assert.deepEqual([r.result, r.actor], ['ok', 'session']);
    // Anonymous sign-out (route is unguarded) is not recorded
    await call('DELETE', '/api/session', undefined, {});
    assert.equal(rows('session.logout').length, 1);
  });
});

test('source IP honours trust proxy; user agent truncated to 200 chars', async () => {
  clearAudit();
  const ua = 'X'.repeat(300);
  await withServer({ auth: { mode: 'on', adminToken: TEST_TOKEN, trustProxy: 'loopback' } }, async ({ call }) => {
    await call('POST', '/api/alerts', { name: 'proxied', conditionType: 'state_change' }, { ...H, 'X-Forwarded-For': '203.0.113.7', 'User-Agent': ua });
    const r = last('alert.create');
    assert.equal(r.source_ip, '203.0.113.7');
    assert.equal(r.user_agent.length, 200);
  });
  await withServer({}, async ({ call }) => {
    await call('POST', '/api/alerts', { name: 'direct', conditionType: 'state_change' }, { ...H, 'X-Forwarded-For': '203.0.113.7' });
    assert.equal(last('alert.create').source_ip, '127.0.0.1', 'X-Forwarded-For ignored without trust proxy');
  });
});

test('admin-guard denials on mutating requests are recorded and throttled; reads are not', async () => {
  clearAudit();
  await withServer({}, async ({ call }) => {
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/alerts', { name: 'x' }, J)).status, 401);
    await call('GET', '/api/alerts', undefined, {});
    await call('GET', '/api/printers', undefined, {});
    const denied = rows('access.denied');
    assert.equal(denied.length, 1, 'one row per ip+action per minute');
    assert.deepEqual([denied[0].result, denied[0].actor, denied[0].target], ['denied', 'anonymous', '/api/alerts']);
    assert.deepEqual(denied[0].detail, { status: 401, method: 'POST', credential: 'none' });

    // Cross-origin cookie write → 403, separate action, separately throttled
    const r = await call('POST', '/api/alerts', { name: 'csrf' }, { ...J, cookie: 'bambuzle_session=abc', Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    const xo = last('access.cross_origin');
    assert.equal(xo.result, 'denied');
    assert.equal(xo.detail.credential, 'cookie');
  });

  // Throttle window + suppressed count, driven with a synthetic clock
  clearAudit();
  const req = { ip: '198.51.100.9', headers: {}, socket: {} };
  const t0 = 1_000_000;
  assert.equal(auditThrottled(req, { action: 'access.denied', result: 'denied' }, t0), true);
  assert.equal(auditThrottled(req, { action: 'access.denied', result: 'denied' }, t0 + 1000), false);
  assert.equal(auditThrottled(req, { action: 'access.denied', result: 'denied' }, t0 + 2000), false);
  assert.equal(auditThrottled({ ...req, ip: '198.51.100.10' }, { action: 'access.denied', result: 'denied' }, t0 + 2000), true, 'other IP not throttled');
  assert.equal(auditThrottled(req, { action: 'access.denied', result: 'denied', detail: {} }, t0 + DENIAL_THROTTLE_MS + 1), true);
  const mine = rows('access.denied').filter((r) => r.source_ip === '198.51.100.9');
  assert.equal(mine.length, 2);
  assert.deepEqual(mine[0].detail, { suppressed: 2 });
});

test('BambuLab Cloud login / verify / logout — never the password or code', async () => {
  clearAudit();
  await withServer({}, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/login', { email: 'op@example.com' })).status, 400);
    assert.deepEqual([last('cloud.login').result, last('cloud.login').detail.reason], ['rejected', 'missing_fields']);

    let r = await call('POST', '/api/auth/login', { email: 'op@example.com', password: SECRETS.cloudPassword });
    assert.equal((await r.json()).status, 'needs_verification');
    let a = last('cloud.login');
    assert.deepEqual([a.result, a.actor, a.detail], ['ok', 'admin-token', { email: 'op@example.com', stage: 'needs_verification' }]);

    r = await call('POST', '/api/auth/verify', { code: SECRETS.verifyCode });
    assert.equal(r.status, 200);
    assert.equal(last('cloud.verify').result, 'ok');

    // Upstream error text can echo input — it must not reach the trail
    cloudStub.login = async (email, pw) => { throw new Error(`BambuLab login failed (400): bad password ${pw}`); };
    r = await call('POST', '/api/auth/login', { email: 'op@example.com', password: SECRETS.cloudPassword });
    assert.equal(r.status, 401);
    a = last('cloud.login');
    assert.deepEqual([a.result, a.detail.reason], ['error', 'login_failed']);

    cloudStub.verifyLogin = async () => { throw new Error(`Verification failed: ${SECRETS.verifyCode}`); };
    await call('POST', '/api/auth/verify', { code: SECRETS.verifyCode });
    assert.equal(last('cloud.verify').result, 'error');

    assert.equal((await call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal(last('cloud.logout').result, 'ok');
  });
});

test('connection settings, LAN printer add/remove and connection tests — access code never recorded', async () => {
  clearAudit();
  queries.upsertPrinter({ deviceId: 'AUDITCLOUD01', name: 'Cloudy', model: 'X1C' });
  const pm = { ...fakePrinterManager(), reconnect() {}, getCapabilities: () => ({ control: 'offline' }) };
  const probe = async ({ host }) => (host === '10.0.0.66' ? { ok: false, stage: 'auth', message: 'Not authorized' } : { ok: true, stage: 'connected' });
  await withServer({ printerManager: pm, deps: { lanProbe: probe } }, async ({ call }) => {
    assert.equal((await call('PUT', '/api/printers/AUDITCLOUD01/connection', { mode: 'lan', lanHost: '10.0.0.50', accessCode: SECRETS.accessCode })).status, 200);
    let r = last('printer.connection.update');
    assert.equal(r.result, 'ok');
    assert.equal(r.target, 'printer:AUDITCLOUD01');
    assert.deepEqual(r.detail, { mode: { from: 'auto', to: 'lan' }, lanHost: { from: null, to: '10.0.0.50' }, accessCodeChanged: true });

    await call('PUT', '/api/printers/AUDITCLOUD01/connection', { accessCode: SECRETS.accessCode2 });
    assert.deepEqual(last('printer.connection.update').detail, { accessCodeChanged: true });
    await call('PUT', '/api/printers/AUDITCLOUD01/connection', { mode: 'lan' });
    assert.deepEqual(last('printer.connection.update').detail, { unchanged: true });
    await call('PUT', '/api/printers/AUDITCLOUD01/connection', { accessCode: 'short' });
    r = last('printer.connection.update');
    assert.deepEqual([r.result, r.detail], ['rejected', { status: 400, field: 'accessCode' }]);

    await call('POST', '/api/printers/AUDITCLOUD01/connection/test', {});
    r = last('printer.connection.test');
    assert.deepEqual([r.result, r.detail.stage, r.detail.ok, r.detail.accessCodeSupplied], ['ok', 'connected', true, false]);
    await call('POST', '/api/printers/AUDITCLOUD01/connection/test', { lanHost: '10.0.0.66', accessCode: SECRETS.accessCode });
    r = last('printer.connection.test');
    assert.deepEqual([r.result, r.detail.stage, r.detail.hostChanged, r.detail.accessCodeSupplied], ['error', 'auth', true, true]);

    assert.equal((await call('POST', '/api/printers', { serial: 'auditlan01', name: 'Garage', lanHost: '10.0.0.9', accessCode: SECRETS.manualAccessCode })).status, 201);
    r = last('printer.add');
    assert.deepEqual([r.result, r.target, r.detail.name, r.detail.lanHost], ['ok', 'printer:AUDITLAN01', 'Garage', '10.0.0.9']);
    await call('POST', '/api/printers', { serial: 'AUDITLAN01', name: 'dup', lanHost: '10.0.0.9', accessCode: SECRETS.manualAccessCode });
    assert.deepEqual([last('printer.add').result, last('printer.add').detail.reason], ['rejected', 'duplicate']);

    assert.equal((await call('DELETE', '/api/printers/AUDITLAN01')).status, 200);
    assert.deepEqual([last('printer.remove').result, last('printer.remove').target], ['ok', 'printer:AUDITLAN01']);
    await call('DELETE', '/api/printers/AUDITCLOUD01');
    assert.equal(last('printer.remove').result, 'rejected');

    // category filter: everything printer.*
    assert.ok(auditDb.queryAudit({ action: 'printer' }).every((x) => x.action.startsWith('printer.')));
  });
});

test('printer commands: confirmed / rejected / unconfirmed / refused, command events kept', async () => {
  clearAudit();
  queries.upsertPrinter({ deviceId: 'AUDITCMD01', name: 'Cmd', model: 'X1C' });
  let reply = { sent: true, acknowledged: true, result: 'success' };
  const client = { connected: true, sendCommandAwaitReply: async () => reply };
  const live = { AUDITCMD01: { gcodeState: 'RUNNING' } };
  const pm = { ...fakePrinterManager({ liveStates: live, clients: { AUDITCMD01: client } }), getTransportKind: () => 'lan' };
  await withServer({ printerManager: pm }, async ({ call }) => {
    const send = (body) => call('POST', '/api/printers/AUDITCMD01/command', body);
    const expectLast = (result, outcome) => {
      const r = last('printer.command');
      assert.deepEqual([r.result, r.detail.outcome, r.target], [result, outcome, 'printer:AUDITCMD01']);
      return r;
    };

    assert.equal((await send({ command: 'pause' })).status, 200);
    expectLast('ok', 'confirmed');

    reply = { sent: true, acknowledged: true, result: 'fail', reason: 'nope' };
    await send({ command: 'set_speed', param: 3 });
    assert.equal(expectLast('rejected', 'rejected').detail.param, '3');

    reply = { sent: true, acknowledged: false };
    await send({ command: 'pause' });
    expectLast('error', 'unconfirmed');

    reply = { sent: false, acknowledged: false };
    await send({ command: 'pause' });
    expectLast('error', 'not_sent');

    live.AUDITCMD01.gcodeState = 'IDLE';
    assert.equal((await send({ command: 'stop' })).status, 409);
    assert.match(expectLast('rejected', 'refused').detail.reason, /Cannot stop/);

    const events = queries.getEvents('AUDITCMD01', { limit: 50 }).filter((e) => e.event_type === 'command');
    assert.equal(events.length, 5, 'existing command events still recorded');
  });
});

test('alert rules: name / condition / channel only — never notify_config', async () => {
  clearAudit();
  await withServer({}, async ({ call }) => {
    let r = await call('POST', '/api/alerts', {
      name: 'Hook', conditionType: 'hms_error', notifyVia: 'webhook', notifyConfig: { url: SECRETS.webhookUrl },
    });
    const { id } = await r.json();
    let a = last('alert.create');
    assert.deepEqual([a.result, a.target, a.detail], ['ok', `alert:${id}`, { name: 'Hook', conditionType: 'hms_error', notifyVia: 'webhook' }]);

    r = await call('PUT', `/api/alerts/${id}`, { notifyVia: 'telegram', notifyConfig: { botToken: SECRETS.botToken, chatId: '42' } });
    a = last('alert.update');
    assert.deepEqual(a.detail, { name: 'Hook', conditionType: 'hms_error', notifyVia: 'telegram', fields: ['notifyVia', 'notifyConfig'] });

    await call('PUT', `/api/alerts/${id}`, { notifyVia: 'pushover', notifyConfig: { userKey: SECRETS.pushoverKey } });
    assert.equal((await call('DELETE', `/api/alerts/${id}`)).status, 200);
    a = last('alert.delete');
    assert.deepEqual([a.result, a.detail.notifyVia], ['ok', 'pushover']);
    await call('DELETE', `/api/alerts/${id}`);
    assert.equal(last('alert.delete').result, 'rejected');
    await call('POST', '/api/alerts', { name: 'no type' });
    assert.equal(last('alert.create').result, 'rejected');
  });
});

test('maintenance tasks: create / update / done / delete / templates', async () => {
  clearAudit();
  queries.upsertPrinter({ deviceId: 'AUDITMNT01', name: 'Maint', model: 'P1S' });
  await withServer({}, async ({ call }) => {
    let r = await call('POST', '/api/maintenance/AUDITMNT01/tasks', { name: 'Lube rods', intervalHours: 200 });
    const { id } = await r.json();
    let a = last('maintenance.task.create');
    assert.deepEqual([a.result, a.target, a.detail], ['ok', `maintenance_task:${id}`, { deviceId: 'AUDITMNT01', name: 'Lube rods' }]);
    await call('POST', '/api/maintenance/AUDITMNT01/tasks', { name: 'No interval' });
    assert.equal(last('maintenance.task.create').result, 'rejected');

    await call('PUT', `/api/maintenance/tasks/${id}`, { intervalDays: 30, notes: 'x' });
    a = last('maintenance.task.update');
    assert.deepEqual([a.result, a.detail.fields], ['ok', ['intervalDays', 'notes']]);

    await call('POST', `/api/maintenance/tasks/${id}/done`, { note: 'done it' });
    a = last('maintenance.task.done');
    assert.deepEqual([a.result, a.detail.hasNote, a.detail.name], ['ok', true, 'Lube rods']);

    await call('POST', '/api/maintenance/AUDITMNT01/templates', {});
    assert.equal(last('maintenance.templates').result, 'ok');

    assert.equal((await call('DELETE', `/api/maintenance/tasks/${id}`)).status, 200);
    assert.deepEqual([last('maintenance.task.delete').result, last('maintenance.task.delete').detail.name], ['ok', 'Lube rods']);
    await call('DELETE', `/api/maintenance/tasks/${id}`);
    assert.equal(last('maintenance.task.delete').result, 'rejected');
  });
});

test('manual backup is recorded (ok / error / not configured)', async () => {
  clearAudit();
  let result = { ok: true, path: '/data/backups/bambuzle-2026-10-03.db', size: 1234 };
  const backupService = { runBackup: async () => result, getSchedule: () => ({ enabled: false }), getLastResult: () => null };
  await withServer({ deps: { backupService } }, async ({ call }) => {
    await call('POST', '/api/system/backup', {});
    assert.deepEqual([last('system.backup').result, last('system.backup').detail], ['ok', { file: 'bambuzle-2026-10-03.db', size: 1234 }]);
    result = { ok: false, error: 'disk full' };
    await call('POST', '/api/system/backup', {});
    assert.equal(last('system.backup').result, 'error');
  });
  await withServer({}, async ({ call }) => {
    await call('POST', '/api/system/backup', {});
    assert.equal(last('system.backup').result, 'rejected');
  });
});

test('GET /api/audit: guarded, private under public-read, filters, default window, limit', async () => {
  clearAudit();
  const day = 86400e3;
  auditDb.insertAudit({ action: 'alert.create', result: 'ok', actor: 'admin-token', ts: new Date(Date.now() - 40 * day) });
  auditDb.insertAudit({ action: 'alert.delete', result: 'ok', actor: 'admin-token', ts: new Date(Date.now() - 2 * day) });
  auditDb.insertAudit({ action: 'printer.command', result: 'rejected', actor: 'session' });
  auditDb.insertAudit({ action: 'printerx.thing', result: 'ok' });

  await withServer({ auth: { mode: 'on', adminToken: TEST_TOKEN, publicRead: true } }, async ({ call }) => {
    for (const url of ['/api/audit', '/API/Audit', '/api/audit/export?format=csv']) {
      assert.equal((await call('GET', url, undefined, {})).status, 401, `${url} private under public-read`);
    }
    assert.equal((await call('GET', '/api/printers', undefined, {})).status, 200, 'other reads still public');

    let body = await (await call('GET', '/api/audit', undefined, authHeaders)).json();
    assert.deepEqual(body.entries.map((e) => e.action), ['printerx.thing', 'printer.command', 'alert.delete'], 'last 30 days, newest first');

    body = await (await call('GET', '/api/audit?from=2000-01-01', undefined, authHeaders)).json();
    assert.equal(body.entries.length, 4);
    body = await (await call('GET', '/api/audit?action=printer', undefined, authHeaders)).json();
    assert.deepEqual(body.entries.map((e) => e.action), ['printer.command'], 'category prefix, not printerx');
    body = await (await call('GET', '/api/audit?result=rejected', undefined, authHeaders)).json();
    assert.deepEqual(body.entries.map((e) => e.action), ['printer.command']);
    body = await (await call('GET', '/api/audit?from=2000-01-01&limit=1', undefined, authHeaders)).json();
    assert.deepEqual([body.entries.length, body.truncated], [1, true]);
    body = await (await call('GET', '/api/audit?limit=999999', undefined, authHeaders)).json();
    assert.equal(body.limit, 2000);

    for (const q of ['action=%25', 'action=A.B', 'result=maybe', 'from=yesterday', 'from=2026-02-01&to=2026-01-01']) {
      assert.equal((await call('GET', `/api/audit?${q}`, undefined, authHeaders)).status, 400, q);
    }
  });
});

test('CSV export is formula-injection guarded', async () => {
  clearAudit();
  auditDb.insertAudit({ action: 'printer.add', result: 'ok', target: '=HYPERLINK("http://x","y")', userAgent: '+cmd|calc', detail: { name: '@SUM(1)' } });
  await withServer({}, async ({ call }) => {
    const r = await call('GET', '/api/audit/export?format=csv', undefined, authHeaders);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="bambuzle-audit-.*\.csv"/);
    const text = await r.text();
    const [header, line] = text.replace(/^﻿/, '').split('\r\n');
    assert.equal(header, 'id,ts,actor,source_ip,user_agent,action,target,result,detail,request_id');
    assert.ok(line.includes(`"'=HYPERLINK(""http://x"",""y"")"`), line);
    assert.ok(line.includes(`'+cmd|calc`), line);
    assert.ok(!/,=|,\+|,@/.test(line), 'no cell starts with a formula character');
    assert.equal((await call('GET', '/api/audit/export?format=json', undefined, authHeaders)).status, 400);
  });
});

test('retention pruning removes only rows older than the audit retention (default 365 days)', () => {
  clearAudit();
  if (!process.env.BAMBUZLE_AUDIT_RETENTION_DAYS) assert.equal(config.audit.retentionDays, 365);
  const day = 86400e3;
  auditDb.insertAudit({ action: 'old.one', result: 'ok', ts: new Date(Date.now() - 400 * day) });
  auditDb.insertAudit({ action: 'recent.one', result: 'ok', ts: new Date(Date.now() - 100 * day) });
  assert.equal(auditDb.deleteOldAudit(0).changes, 0, '0 = keep forever');
  assert.equal(auditDb.deleteOldAudit(365).changes, 1);
  assert.deepEqual(auditDb.queryAudit({ from: '2000-01-01' }).map((r) => r.action), ['recent.one']);
});

test('no secret value appears in any audit row produced by these tests', () => {
  // Re-run a full pass of every secret-bearing action into a clean table, then grep everything.
  // (Earlier tests clear the table between them, so this one re-checks the whole surface at once.)
  return (async () => {
    clearAudit();
    queries.upsertPrinter({ deviceId: 'AUDITSEC01', name: 'Sec', model: 'X1C' });
    const pm = { ...fakePrinterManager(), reconnect() {}, getCapabilities: () => ({ control: 'offline' }) };
    cloudStub.login = async (e, pw) => { throw new Error(`bad ${pw}`); };
    cloudStub.verifyLogin = async (code) => { throw new Error(`bad ${code}`); };
    await withServer({ printerManager: pm, deps: { lanProbe: async (a) => ({ ok: false, stage: 'auth', message: `rejected ${a.accessCode}` }) } }, async ({ call }) => {
      await call('POST', '/api/session', { token: SECRETS.wrongToken }, J);
      await call('POST', '/api/session', { token: TEST_TOKEN }, J);
      await call('POST', '/api/alerts', { name: 'x' }, { ...J, Authorization: `Bearer ${SECRETS.wrongToken}` });
      await call('POST', '/api/auth/login', { email: 'op@example.com', password: SECRETS.cloudPassword });
      await call('POST', '/api/auth/verify', { code: SECRETS.verifyCode });
      await call('PUT', '/api/printers/AUDITSEC01/connection', { mode: 'lan', lanHost: '10.0.0.51', accessCode: SECRETS.accessCode });
      await call('PUT', '/api/printers/AUDITSEC01/connection', { accessCode: SECRETS.accessCode2 });
      await call('POST', '/api/printers/AUDITSEC01/connection/test', { lanHost: '10.0.0.52', accessCode: SECRETS.accessCode });
      await call('POST', '/api/printers', { serial: 'AUDITSEC02', name: 'Sec2', lanHost: '10.0.0.53', accessCode: SECRETS.manualAccessCode });
      const r = await call('POST', '/api/alerts', { name: 'Hook', conditionType: 'hms_error', notifyVia: 'webhook', notifyConfig: { url: SECRETS.webhookUrl } });
      const { id } = await r.json();
      await call('PUT', `/api/alerts/${id}`, { notifyVia: 'telegram', notifyConfig: { botToken: SECRETS.botToken } });
      await call('PUT', `/api/alerts/${id}`, { notifyVia: 'pushover', notifyConfig: { userKey: SECRETS.pushoverKey } });
      await call('DELETE', `/api/alerts/${id}`);
    });
    const all = getDb().prepare('SELECT * FROM audit_log').all();
    assert.ok(all.length >= 12, `expected the pass to write rows, got ${all.length}`);
    for (const row of all) {
      const text = JSON.stringify(row);
      for (const [name, value] of Object.entries(SECRETS)) {
        if (!value) continue;
        assert.ok(!text.includes(value), `${name} leaked into audit row ${row.action}: ${row.detail}`);
      }
    }
  })();
});

test('rate-limited sign-in attempts are recorded once per minute', async () => {
  clearAudit();
  await withServer({}, async ({ call }) => {
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const r = await call('POST', '/api/session', { token: 'wrong' }, J);
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 2, 'limiter kicked in');
    const rl = rows('session.rate_limited');
    assert.equal(rl.length, 1);
    assert.deepEqual([rl[0].result, rl[0].actor], ['rejected', 'anonymous']);
  });
});
