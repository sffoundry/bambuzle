'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { authHeaders, startServer, cleanup } = require('./helpers');
const { jobEndState } = require('../src/utils/job-state');
const queries = require('../src/db/queries');

after(cleanup);

test('user cancel (FAILED + 50348044) is stored as CANCELLED and counted as cancelled — finding 3', () => {
  const cancel = { diagnostics: { printError: { code: 50348044, userCancelled: true } } };
  assert.equal(jobEndState('FAILED', cancel), 'CANCELLED');
  assert.equal(jobEndState('FAILED', { diagnostics: { printError: { code: 1, userCancelled: false } } }), 'FAILED');
  assert.equal(jobEndState('FINISH', cancel), 'FINISH');

  queries.upsertPrinter({ deviceId: 'd1', name: 'A', model: 'X1C' });
  for (const end of ['FINISH', 'CANCELLED', 'FAILED']) {
    const id = queries.startJob({ deviceId: 'd1', taskId: 't', subtaskName: 's', gcodeFile: 'g' });
    queries.endJob(id, end, 50);
  }
  const { overall } = queries.getJobStats({ deviceId: 'd1' });
  assert.deepEqual([overall.finished, overall.failed, overall.cancelled], [1, 1, 1]);
});

test('setJobMaterial fills a missing material once and never overwrites — finding 11', () => {
  const id = queries.startJob({ deviceId: 'd1', taskId: 't2', subtaskName: 's', gcodeFile: 'g' });
  queries.setJobMaterial(id, 'PETG', 'FF0000FF');
  queries.setJobMaterial(id, 'PLA', '000000FF');
  assert.equal(queries.getActiveJob('d1').material, 'PETG');
});

test('closeWebSocket terminates open clients so server.close() resolves — finding 4', async () => {
  const srv = await startServer();
  const ws = new WebSocket(srv.baseUrl.replace('http', 'ws') + '/ws', { headers: authHeaders });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const closed = srv.close().then(() => 'closed');
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 2000));
  assert.equal(await Promise.race([closed, timeout]), 'closed');
});
