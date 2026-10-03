'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { startFtpsServer } = require('./ftps-server');
const files = require('../src/printers/printer-files');
const conns = require('../src/db/printer-connections');
const queries = require('../src/db/queries');

after(cleanup);

const SERIAL = '01S00TEST000001'; // matches the test printer certificate CN
const CODE = 'Ab12Cd34';
const video = Buffer.from('fake-mp4-bytes-'.repeat(100));
const tree = {
  '/timelapse': [{ name: 'video_2026-10-01_12-00-00.mp4', data: video }, { name: 'notes.txt', data: Buffer.from('x') }],
  '/cache': [{ name: 'plate_1.gcode.3mf', data: Buffer.from('3mf') }],
};

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  w.data = () => Buffer.concat(chunks);
  return w;
}

test('safeRemotePath allows only known dirs + extensions, no traversal', () => {
  assert.equal(files.safeRemotePath('timelapse', '/timelapse/a.mp4'), '/timelapse/a.mp4');
  assert.equal(files.safeRemotePath('prints', '/cache/p.gcode.3mf'), '/cache/p.gcode.3mf');
  assert.equal(files.safeRemotePath('prints', '/p.3mf'), '/p.3mf');
  for (const bad of ['/timelapse/../etc/passwd.mp4', '/etc/a.mp4', '/timelapse/a.sh', '/timelapse/', '/timelapse/a\\b.mp4', null, '/timelapse/x\n.mp4']) {
    assert.equal(files.safeRemotePath('timelapse', bad), null, String(bad));
  }
  assert.equal(files.safeRemotePath('nope', '/timelapse/a.mp4'), null);
});

test('real FTPS round trip: list + download with CA + serial-pinned TLS; wrong code and wrong serial refused', async () => {
  const ftp = await startFtpsServer({ password: CODE, tree });
  const conn = { lanHost: '127.0.0.1', accessCode: CODE };
  const opts = { ca: ftp.ca, port: ftp.port };
  try {
    const list = await files.listFiles(SERIAL, conn, 'timelapse', opts);
    assert.deepEqual(list.map((f) => f.path), ['/timelapse/video_2026-10-01_12-00-00.mp4'], 'non-video filtered out');
    assert.equal(files.getFilesStatus(SERIAL).ok, true);

    const out = sink();
    let size;
    await files.downloadFile(SERIAL, conn, 'timelapse', '/timelapse/video_2026-10-01_12-00-00.mp4', out, { ...opts, onSize: (s) => { size = s; } });
    assert.deepEqual(out.data(), video);
    assert.equal(size, video.length);

    await assert.rejects(files.listFiles(SERIAL, { ...conn, accessCode: 'WRONG000' }, 'timelapse', opts), (e) => e.stage === 'auth');
    assert.equal(files.getFilesStatus(SERIAL).ok, false);
    await assert.rejects(files.listFiles('01S00OTHER0002', conn, 'timelapse', opts), (e) => e.stage === 'identity', 'cert CN ≠ expected serial');
    await assert.rejects(files.listFiles(SERIAL, conn, 'timelapse', { port: ftp.port }), (e) => e.stage !== 'ok', 'Bambu CA bundle does not trust the test CA');
  } finally {
    await ftp.close();
  }
});

test('the access code is never sent to a server that fails TLS verification', async () => {
  const ftp = await startFtpsServer({ password: CODE, tree });
  try {
    const before = ftp.logins.length;
    await assert.rejects(files.listFiles('01S00OTHER0002', { lanHost: '127.0.0.1', accessCode: CODE }, 'timelapse', { ca: ftp.ca, port: ftp.port }));
    await assert.rejects(files.listFiles(SERIAL, { lanHost: '127.0.0.1', accessCode: CODE }, 'timelapse', { port: ftp.port }));
    assert.equal(ftp.logins.length, before, 'no PASS reached the server');
  } finally {
    await ftp.close();
  }
});

test('one FTPS session per printer at a time', async () => {
  let active = 0;
  let maxActive = 0;
  const slowFactory = () => ({
    access: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 30)); },
    list: async () => [],
    close: () => { active--; },
  });
  await Promise.all([1, 2, 3].map(() => files.listFiles('SERIALIZE01', { lanHost: 'h', accessCode: 'x' }, 'timelapse', { clientFactory: slowFactory })));
  assert.equal(maxActive, 1);
});

test('files API: needs LAN settings, validates input, private under public-read, streams downloads', async () => {
  queries.upsertPrinter({ deviceId: 'FILES0001', name: 'F', model: 'X1C' });
  const fileOps = {
    listFiles: async () => [{ path: '/timelapse/a.mp4', name: 'a.mp4', size: 3, modifiedAt: null }],
    downloadFile: async (id, conn, kind, p, res, { onSize }) => { onSize(3); res.write('abc'); },
  };
  const srv = await startServer({ deps: { fileOps } });
  const get = (u, h = authHeaders) => fetch(srv.baseUrl + u, { headers: h });
  try {
    assert.equal((await get('/api/printers/FILES0001/files')).status, 409, 'no LAN settings yet');
    conns.setConnection('FILES0001', { lanHost: '10.0.0.30', accessCode: 'Ab12Cd34' });
    assert.equal((await get('/api/printers/FILES0001/files?kind=bogus')).status, 400);
    const list = await (await get('/api/printers/FILES0001/files')).json();
    assert.equal(list.files[0].name, 'a.mp4');
    assert.equal((await get('/api/printers/FILES0001/files/download?kind=timelapse&path=/etc/passwd')).status, 400);
    const dl = await get('/api/printers/FILES0001/files/download?kind=timelapse&path=/timelapse/a.mp4');
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'video/mp4');
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="a.mp4"/);
    assert.equal(await dl.text(), 'abc');
    const { queryAudit } = require('../src/db/audit');
    const rows = queryAudit({ action: 'printer.files', limit: 10 });
    assert.ok(rows.some((r) => r.action === 'printer.files.download' && r.result === 'ok'), 'download audited');
    assert.equal((await get('/api/printers/FILES0001/files', {})).status, 401);
  } finally {
    await srv.close();
  }
  const pub = await startServer({ auth: { mode: 'on', adminToken: 'test-admin-token', publicRead: true }, deps: { fileOps } });
  try {
    assert.equal((await fetch(`${pub.baseUrl}/api/printers/FILES0001/files`)).status, 401, 'private even with public read');
  } finally {
    await pub.close();
  }
});

// ─── v0.8 review fixes ───

test('a stalled download is aborted and releases the printer for the next request — review #1', async () => {
  const ftp = await startFtpsServer({ password: CODE, tree });
  const conn = { lanHost: '127.0.0.1', accessCode: CODE };
  const opts = { ca: ftp.ca, port: ftp.port };
  try {
    const stuck = new Writable({ highWaterMark: 1, write() { /* never calls back: a paused browser download */ } });
    await assert.rejects(
      files.downloadFile(SERIAL, conn, 'timelapse', '/timelapse/video_2026-10-01_12-00-00.mp4', stuck, { ...opts, stallMs: 300 }),
      (e) => /stalled|closed|aborted/i.test(e.message),
    );
    const list = await files.listFiles(SERIAL, conn, 'timelapse', opts);
    assert.equal(list.length, 1, 'lock released — later requests work');
  } finally {
    await ftp.close();
  }
});

test('waiting behind a busy transfer gives up with 503 instead of hanging', async () => {
  let release;
  const blocker = new Promise((r) => { release = r; });
  const slow = () => ({ access: async () => {}, list: async () => { await blocker; return []; }, close() {} });
  const first = files.listFiles('BUSY000001', { lanHost: 'h', accessCode: 'x' }, 'timelapse', { clientFactory: slow });
  await assert.rejects(
    files.downloadFile('BUSY000001', { lanHost: 'h', accessCode: 'x' }, 'timelapse', '/timelapse/a.mp4', sink(), { clientFactory: slow, lockWaitMs: 100 }),
    (e) => e.status === 503,
  );
  release();
  await first;
});

test('a download that fails before any data returns a JSON error, not an "a.mp4" attachment — review #8', async () => {
  queries.upsertPrinter({ deviceId: 'FILES0002', name: 'F2', model: 'X1C' });
  conns.setConnection('FILES0002', { lanHost: '10.0.0.31', accessCode: 'Ab12Cd34' });
  const fileOps = {
    listFiles: async () => [],
    downloadFile: async (id, conn, kind, p, res, { onSize }) => { onSize(100); throw Object.assign(new Error('Printer refused the file operation (550)'), { status: 404 }); },
  };
  const srv = await startServer({ deps: { fileOps } });
  try {
    const r = await fetch(`${srv.baseUrl}/api/printers/FILES0002/files/download?kind=timelapse&path=/timelapse/a.mp4`, { headers: authHeaders });
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.headers.get('content-disposition'), null);
  } finally {
    await srv.close();
  }
});
