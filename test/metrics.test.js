'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders, TEST_TOKEN, fakePrinterManager, startServer, cleanup } = require('./helpers');
const queries = require('../src/db/queries');
const { extractPrinterState } = require('../src/bambu/message-parser');

after(cleanup);

/** Minimal Prometheus text-format check: every sample line belongs to a declared family. */
function parseExposition(text) {
  const types = new Map();
  const samples = [];
  for (const line of text.trim().split('\n')) {
    const t = /^# TYPE (\S+) (gauge|counter)$/.exec(line);
    if (t) { types.set(t[1], t[2]); continue; }
    if (line.startsWith('# HELP ')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?[0-9.e+-]+)$/.exec(line);
    assert.ok(m, `bad line: ${line}`);
    assert.ok(types.has(m[1]), `no TYPE for ${m[1]}`);
    samples.push({ name: m[1], labels: m[2] || '', value: Number(m[3]) });
  }
  return samples;
}

test('/metrics requires the admin token and emits valid exposition with printer series', async () => {
  queries.upsertPrinter({ deviceId: 'dev1', name: 'Alpha "A"', model: 'H2D' });
  const state = extractPrinterState({ print: { ...require('./fixtures/push-h2d.json').print, gcode_state: 'RUNNING', mc_percent: 42, print_error: 0x0c004001 } });
  const pm = { ...fakePrinterManager({ liveStates: { dev1: state }, clients: { dev1: {} } }), getLastMessageAt: () => Date.now() - 5000 };
  const srv = await startServer({ printerManager: pm });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/metrics`)).status, 401);

    const res = await fetch(`${srv.baseUrl}/metrics`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain;.*version=0\.0\.4/);
    const samples = parseExposition(await res.text());
    const get = (name, labelPart = '') => samples.find((s) => s.name === name && s.labels.includes(labelPart));

    assert.equal(get('bambuzle_printer_connected', 'printer="dev1"').value, 1);
    assert.ok(get('bambuzle_printer_connected').labels.includes('name="Alpha \\"A\\""'), 'label quotes escaped');
    assert.equal(get('bambuzle_printer_state', 'state="RUNNING"').value, 1);
    assert.equal(get('bambuzle_printer_state', 'state="IDLE"').value, 0);
    assert.equal(get('bambuzle_printer_progress_percent').value, 42);
    assert.equal(get('bambuzle_printer_print_error_active').value, 1);
    assert.equal(get('bambuzle_printer_fan_percent', 'fan="heatbreak"').value, 100);
    assert.ok(get('bambuzle_printer_last_message_age_seconds').value >= 5);
    assert.equal(get('bambuzle_mqtt_connections').value, 1);
    assert.equal(get('bambuzle_printers_configured').value, 1);
    assert.ok(get('bambuzle_db_size_bytes').value > 0);
    assert.ok(!samples.some((s) => /task|file/.test(s.labels)), 'no high-cardinality labels');
  } finally {
    await srv.close();
  }
});

test('/metrics is open with publicRead', async () => {
  const srv = await startServer({ auth: { mode: 'on', adminToken: TEST_TOKEN, publicRead: true } });
  try {
    assert.equal((await fetch(`${srv.baseUrl}/metrics`)).status, 200);
  } finally {
    await srv.close();
  }
});
