'use strict';

// BAM-42: read-only Home Assistant bridge over MQTT discovery.
// Publishes each printer's normalized state to a broker YOU run (e.g. Mosquitto add-on), with
// homeassistant/... discovery configs so entities appear in HA automatically.
// Strictly one-way: the bridge never subscribes, so nothing on that broker can command a printer.
//
// Topics (prefix configurable, default 'bambuzle'):
//   <prefix>/bridge/availability          online/offline (LWT)
//   <prefix>/<serial>/availability        online/offline (printer connected to Bambuzle)
//   <prefix>/<serial>/state               retained JSON, throttled
//   homeassistant/<component>/bambuzle_<serial>/<key>/config   retained discovery

const mqtt = require('mqtt');

const SENSORS = [
  { key: 'state', name: 'Print state', value: 'gcodeState', icon: 'mdi:printer-3d' },
  { key: 'progress', name: 'Progress', value: 'progress', unit: '%', stateClass: 'measurement', icon: 'mdi:progress-clock' },
  { key: 'remaining', name: 'Time remaining', value: 'remainingMin', unit: 'min', deviceClass: 'duration' },
  { key: 'layer', name: 'Layer', value: 'layerNum', stateClass: 'measurement', icon: 'mdi:layers' },
  { key: 'nozzle_temp', name: 'Nozzle temperature', value: 'nozzleTemp', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement' },
  { key: 'bed_temp', name: 'Bed temperature', value: 'bedTemp', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement' },
  { key: 'chamber_temp', name: 'Chamber temperature', value: 'chamberTemp', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement' },
  { key: 'job', name: 'Current job', value: 'job', icon: 'mdi:file-cad' },
  { key: 'hms_active', name: 'Active HMS errors', value: 'hmsActive', stateClass: 'measurement', icon: 'mdi:alert-circle-outline' },
];
const BINARY = [
  { key: 'print_error', name: 'Print error', value: 'printError', deviceClass: 'problem' },
];

/** Broker host for logs — never the full URL (it may embed user:password). */
function safeHost(url) {
  try { return new URL(url).host; } catch { return '(invalid url)'; }
}

/** The JSON published to <prefix>/<serial>/state (exported for tests). */
function statePayload(state) {
  const s = state || {};
  return {
    gcodeState: s.gcodeState || 'UNKNOWN',
    progress: s.progress ?? null,
    remainingMin: s.remainingMin ?? null,
    layerNum: s.layerNum ?? null,
    nozzleTemp: s.nozzleTemp ?? null,
    bedTemp: s.bedTemp ?? null,
    chamberTemp: s.chamberTemp ?? null,
    job: s.subtaskName || s.gcodeFile || '',
    hmsActive: Array.isArray(s.hmsErrors) ? s.hmsErrors.length : 0,
    printError: s.diagnostics?.printError?.active ? 'ON' : 'OFF',
  };
}

/** Discovery messages for one printer (exported for tests). */
function discoveryMessages(prefix, printer) {
  const serial = printer.device_id;
  const device = { identifiers: [`bambuzle_${serial}`], name: printer.name || serial, manufacturer: 'Bambu Lab', model: printer.model || undefined, via_device: 'bambuzle' };
  const base = {
    availability: [{ topic: `${prefix}/bridge/availability` }, { topic: `${prefix}/${serial}/availability` }],
    availability_mode: 'all',
    state_topic: `${prefix}/${serial}/state`,
    device,
  };
  const msgs = [];
  for (const s of SENSORS) {
    msgs.push({
      topic: `homeassistant/sensor/bambuzle_${serial}/${s.key}/config`,
      payload: {
        ...base,
        name: s.name,
        unique_id: `bambuzle_${serial}_${s.key}`,
        value_template: `{{ value_json.${s.value} }}`,
        ...(s.unit ? { unit_of_measurement: s.unit } : {}),
        ...(s.deviceClass ? { device_class: s.deviceClass } : {}),
        ...(s.stateClass ? { state_class: s.stateClass } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
      },
    });
  }
  for (const b of BINARY) {
    msgs.push({
      topic: `homeassistant/binary_sensor/bambuzle_${serial}/${b.key}/config`,
      payload: { ...base, name: b.name, unique_id: `bambuzle_${serial}_${b.key}`, value_template: `{{ value_json.${b.value} }}`, device_class: b.deviceClass },
    });
  }
  return msgs;
}

/**
 * @param {object} opts
 * @param {object} opts.config — { url, username, password, prefix, throttleSec }
 * @param {function} opts.listPrinters — () => printer rows (device_id, name, model)
 * @param {object} opts.log
 * @param {function} [opts.connectFn] — injectable (tests)
 */
function createHaBridge({ config, listPrinters, log, connectFn = mqtt.connect }) {
  const prefix = config.prefix || 'bambuzle';
  const t = Number(config.throttleSec);
  const throttleMs = (Number.isFinite(t) && t >= 1 ? t : 10) * 1000; // NaN/garbage → default, never "no throttle"
  const announced = new Set();
  const lastSent = {};
  const pending = {};
  let client = null;

  function publish(topic, payload, retain = true) {
    if (!client?.connected) return;
    client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 0, retain });
  }

  function announce(printer) {
    if (announced.has(printer.device_id)) return;
    for (const m of discoveryMessages(prefix, printer)) publish(m.topic, m.payload);
    announced.add(printer.device_id);
  }

  function start() {
    client = connectFn(config.url, {
      username: config.username || undefined,
      password: config.password || undefined,
      clientId: `bambuzle_bridge_${Date.now()}`,
      will: { topic: `${prefix}/bridge/availability`, payload: 'offline', retain: true, qos: 0 },
      reconnectPeriod: 10000,
    });
    client.on('connect', () => {
      log.info({ broker: safeHost(config.url) }, 'Home Assistant bridge connected');
      announced.clear();
      publish(`${prefix}/bridge/availability`, 'online');
      for (const p of listPrinters()) announce(p);
    });
    client.on('error', (err) => log.warn({ err: err.message }, 'Home Assistant bridge MQTT error'));
    return api;
  }

  /** Called on every printer state update; throttled per printer (latest state wins). */
  function onState(deviceId, state, connected = true) {
    const printer = listPrinters().find((p) => p.device_id === deviceId);
    if (!printer || !client?.connected) return;
    announce(printer);
    publish(`${prefix}/${deviceId}/availability`, connected ? 'online' : 'offline');
    const now = Date.now();
    const send = () => {
      lastSent[deviceId] = Date.now();
      pending[deviceId] = null;
      publish(`${prefix}/${deviceId}/state`, statePayload(state));
    };
    if (!lastSent[deviceId] || now - lastSent[deviceId] >= throttleMs) return send();
    if (!pending[deviceId]) pending[deviceId] = setTimeout(send, throttleMs - (now - lastSent[deviceId]));
    else { clearTimeout(pending[deviceId]); pending[deviceId] = setTimeout(send, throttleMs - (now - lastSent[deviceId])); }
  }

  function stop() {
    for (const t of Object.values(pending)) if (t) clearTimeout(t);
    if (client) {
      publish(`${prefix}/bridge/availability`, 'offline');
      client.end(true);
      client = null;
    }
  }

  const api = { start, stop, onState };
  return api;
}

module.exports = { createHaBridge, statePayload, discoveryMessages, safeHost };
