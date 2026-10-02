'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { dataDir, authHeaders, startServer, cleanup } = require('./helpers');

after(cleanup);

test('database is created in BAMBUZLE_DATA_DIR', async () => {
  const srv = await startServer();
  try {
    assert.ok(fs.existsSync(path.join(dataDir, 'bambuzle.db')));
  } finally {
    await srv.close();
  }
});

test('GET /api/printers returns a list', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/printers`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
  } finally {
    await srv.close();
  }
});
