'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractDiagnostics, nozzleTypeName, formatPrintError, ipFromInt } = require('../src/bambu/diagnostics');
const { extractPrinterState, fanToPercent } = require('../src/bambu/message-parser');

const fixture = (name) => require(`./fixtures/push-${name}.json`).print;
const diag = (p) => extractDiagnostics(p, fanToPercent);

test('A1: single nozzle, marker detector only, SD present, AMS lite humidity index', () => {
  const d = diag(fixture('a1'));
  assert.deepEqual(d.nozzles, [{ id: 0, diameter: 0.4, type: 'stainless steel', typeCode: 'stainless_steel' }]);
  assert.equal(d.aiMonitoring.buildplateMarkerDetector, true);
  assert.equal(d.aiMonitoring.spaghettiDetector, null);
  assert.equal(d.sdCard, 'present');
  assert.deepEqual(d.network, { ip: '192.168.0.98' });
  assert.equal(d.firmware.updateAvailable, false);
  assert.equal(d.chamberLight, 'off');
  assert.deepEqual(d.amsHumidity, [{ id: '0', index: 5, percent: null, temp: null }]);
  assert.equal(d.developerMode, null);
});

test('H2D: dual nozzles from device.nozzle.info, full xcam settings, humidity %, dev mode off', () => {
  const d = diag(fixture('h2d'));
  assert.equal(d.nozzles.length, 2);
  assert.equal(d.nozzles[1].type, 'hardened steel');
  assert.equal(d.nozzles[1].typeCode, 'HS01');
  assert.equal(d.aiMonitoring.spaghettiDetector, true);
  assert.equal(d.aiMonitoring.haltSensitivity, 'medium');
  assert.equal(d.camera.recording, true);
  assert.equal(d.camera.rtsp_url, undefined);
  assert.equal(d.amsHumidity[0].percent, 1);
  assert.equal(d.heatbreakFanSpeed, 100);
  assert.equal(d.developerMode, false);
});

test('P1P without AMS: no xcam, empty AMS list', () => {
  const d = diag(fixture('p1p-no-ams'));
  assert.equal(d.aiMonitoring, null);
  assert.deepEqual(d.amsHumidity, []);
  assert.equal(d.firmware.upgradeStatus, 'UPGRADE_SUCCESS');
});

test('firmware update detection: new_ver_list (P1/A1 style) and ota_new_version_number (X1 style)', () => {
  const listStyle = diag({ upgrade_state: { new_version_state: 1, new_ver_list: [{ name: 'ams', new_ver: '1' }, { name: 'ota', new_ver: '01.08.00.00' }] } });
  assert.deepEqual([listStyle.firmware.updateAvailable, listStyle.firmware.newVersion], [true, '01.08.00.00']);
  const otaStyle = diag({ upgrade_state: { new_version_state: 1, ota_new_version_number: '01.08.02.00' } });
  assert.equal(otaStyle.firmware.newVersion, '01.08.02.00');
  assert.equal(diag({ upgrade_state: { new_version_state: 2, ota_new_version_number: '' } }).firmware.updateAvailable, false);
});

test('print_error: user cancel is not an active error; real codes are formatted', () => {
  const cancel = diag({ print_error: 50348044 }).printError;
  assert.deepEqual(cancel, { code: 50348044, hex: '0300_400C', active: false, userCancelled: true });
  const fault = diag({ print_error: 0x0c004001 }).printError;
  assert.equal(fault.active, true);
  assert.equal(fault.hex, '0C00_4001');
  assert.equal(diag({}).printError, null);
});

test('developer mode from print.fun signature bit', () => {
  assert.equal(diag({ fun: '3EC18FFF9CFF' }).developerMode, true);
  assert.equal(diag({ fun: '3EC1AFFF9CFF' }).developerMode, false);
  assert.equal(diag({ fun: 'zz' }).developerMode, null);
});

test('helpers', () => {
  assert.equal(nozzleTypeName('HH01'), 'high-flow hardened steel');
  assert.equal(nozzleTypeName('HU01'), 'TPU high-flow');
  assert.equal(nozzleTypeName('HS05'), 'tungsten carbide');
  assert.equal(nozzleTypeName(null), null);
  assert.equal(formatPrintError(1), '0000_0001');
  assert.equal(ipFromInt(0), null);
  assert.deepEqual(diag({ home_flag: 0x200 | 0x100 }).sdCard, 'abnormal');
  assert.equal(diag({ home_flag: 0 }).sdCard, 'missing');
});

test('extractPrinterState carries diagnostics and tolerates an empty payload', () => {
  assert.equal(extractPrinterState({ print: fixture('h2d') }).diagnostics.nozzles.length, 2);
  const empty = extractPrinterState({}).diagnostics;
  assert.deepEqual(empty.nozzles, []);
  assert.equal(empty.firmware, null);
});

test('hmsErrors is null (not []) until the printer has reported its HMS list — review #2', () => {
  assert.equal(extractPrinterState({ print: { gcode_state: 'RUNNING' } }).hmsErrors, null);
  assert.deepEqual(extractPrinterState({ print: { hms: [] } }).hmsErrors, []);
});
