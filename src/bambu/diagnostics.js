'use strict';

// BAM-32: normalize push_status fields that were received but never parsed.
// Field semantics follow ha-bambulab's pybambu (MIT) models.py/const.py and its mock payloads
// (A1, P1P, H2D). Every field is optional — models and firmware differ — so absent data is null,
// never a guessed default.

// home_flag bits (pybambu const.Home_Flag_Values)
const HOME_FLAG = {
  SD_CARD_PRESENT: 0x00000100,
  SD_CARD_ABNORMAL: 0x00000200,
};

// print.fun bit: set = MQTT commands must be signed (Developer Mode OFF)
const FUN_MQTT_SIGNATURE_REQUIRED = 0x20000000n;

// print_error value Bambu sends when the user cancels a print — not a fault
const PRINT_ERROR_USER_CANCELLED = 50348044;

const NOZZLE_MATERIALS = { '00': 'stainless steel', '01': 'hardened steel', '05': 'tungsten carbide' };

function toInt(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** "HS01" → "hardened steel", "HH01" → "high-flow hardened steel"; long-form strings are de-underscored. */
function nozzleTypeName(type) {
  if (!type || typeof type !== 'string') return null;
  if (/^[A-Z]{2}\d{2}$/.test(type)) {
    if (type[1] === 'U') return 'TPU high-flow';
    const material = NOZZLE_MATERIALS[type.slice(2, 4)] || type;
    return type[1] === 'H' || type[1] === 'E' ? `high-flow ${material}` : material;
  }
  return type.replace(/_/g, ' ');
}

function extractNozzles(p) {
  const info = p.device?.nozzle?.info;
  if (Array.isArray(info) && info.length > 0) {
    return info
      .filter((n) => n && (n.id === 0 || n.id === 1))
      .map((n) => ({ id: n.id, diameter: toFloat(n.diameter), type: nozzleTypeName(n.type), typeCode: n.type ?? null }));
  }
  if (p.nozzle_diameter == null && p.nozzle_type == null) return [];
  return [{ id: 0, diameter: toFloat(p.nozzle_diameter), type: nozzleTypeName(p.nozzle_type), typeCode: p.nozzle_type ?? null }];
}

/** Bambu-style "0300_400C" for a print_error integer. */
function formatPrintError(code) {
  const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${hex.slice(0, 4)}_${hex.slice(4)}`;
}

function extractPrintError(p) {
  const code = toInt(p.print_error);
  if (code == null) return null;
  return {
    code,
    hex: code === 0 ? null : formatPrintError(code),
    active: code !== 0 && code !== PRINT_ERROR_USER_CANCELLED,
    userCancelled: code === PRINT_ERROR_USER_CANCELLED,
  };
}

function extractFirmware(p) {
  const u = p.upgrade_state;
  if (!u || typeof u !== 'object') return null;
  let newVersion = null;
  if (u.new_version_state === 1) {
    const ota = Array.isArray(u.new_ver_list) ? u.new_ver_list.find((m) => m?.name === 'ota') : null;
    newVersion = ota?.new_ver || u.ota_new_version_number || null;
  }
  return {
    updateAvailable: u.new_version_state === 1,
    newVersion,
    upgradeStatus: u.status ?? null,
    upgradeProgress: toInt(u.progress),
  };
}

/** xcam: printer-side AI monitoring SETTINGS (which detectors are enabled) — not detection events. */
function extractAiMonitoring(p) {
  const x = p.xcam;
  if (!x || typeof x !== 'object') return null;
  const flag = (k) => (typeof x[k] === 'boolean' ? x[k] : null);
  return {
    spaghettiDetector: flag('spaghetti_detector'),
    firstLayerInspector: flag('first_layer_inspector'),
    buildplateMarkerDetector: flag('buildplate_marker_detector'),
    printingMonitor: flag('printing_monitor'),
    pauseOnDetection: flag('print_halt'),
    haltSensitivity: typeof x.halt_print_sensitivity === 'string' ? x.halt_print_sensitivity : null,
  };
}

function extractSdCard(p) {
  const hf = toInt(p.home_flag);
  if (hf != null) {
    if (hf & HOME_FLAG.SD_CARD_ABNORMAL) return 'abnormal';
    return hf & HOME_FLAG.SD_CARD_PRESENT ? 'present' : 'missing';
  }
  if (typeof p.sdcard === 'boolean') return p.sdcard ? 'present' : 'missing';
  return null;
}

/** net.info[].ip is a little-endian uint32. */
function ipFromInt(n) {
  const v = toInt(n);
  if (!v) return null;
  const u = v >>> 0;
  return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff].join('.');
}

// home_flag 0x40000 is labelled "wired network" upstream, but the Wi-Fi-only A1 mock sets it,
// so its meaning is unverified and it is deliberately not exposed.
function extractNetwork(p) {
  const ip = Array.isArray(p.net?.info) ? ipFromInt(p.net.info[0]?.ip) : null;
  return ip == null ? null : { ip };
}

function extractCamera(p) {
  const c = p.ipcam;
  if (!c || typeof c !== 'object') return null;
  // rtsp_url itself is deliberately not exposed (it embeds the printer's address); only whether
  // LAN liveview is switched on ('disable' = off; absent on models that don't report it)
  const rtsp = typeof c.rtsp_url === 'string' ? c.rtsp_url : null;
  return {
    present: c.ipcam_dev != null ? String(c.ipcam_dev) !== '0' : null,
    lanLiveview: rtsp == null ? null : rtsp !== 'disable' && rtsp !== '',
    recording: c.ipcam_record != null ? c.ipcam_record === 'enable' : null,
    timelapse: c.timelapse != null ? c.timelapse === 'enable' : null,
    resolution: c.resolution || null,
  };
}

function extractChamberLight(p) {
  if (!Array.isArray(p.lights_report)) return null;
  return p.lights_report.find((l) => l?.node === 'chamber_light')?.mode ?? null;
}

/** AMS humidity: `humidity` is a 1–5 index (5 = driest); `humidity_raw` is % RH on newer units. */
function extractAmsHumidity(p) {
  const units = p.ams?.ams;
  if (!Array.isArray(units)) return [];
  return units.map((u) => {
    const index = toInt(u.humidity);
    const raw = toInt(u.humidity_raw);
    return {
      id: u.id ?? null,
      index: index != null && index >= 1 && index <= 5 ? index : null,
      percent: raw != null && raw >= 1 && raw <= 100 ? raw : null,
      temp: toFloat(u.temp) || null,
    };
  });
}

/** print.fun hex string → Developer Mode on/off (null when not reported). */
function extractDeveloperMode(p) {
  if (typeof p.fun !== 'string' || !/^[0-9A-Fa-f]+$/.test(p.fun)) return null;
  return (BigInt('0x' + p.fun) & FUN_MQTT_SIGNATURE_REQUIRED) === 0n;
}

/**
 * @param {object} p — merged `print` object from push_status
 * @param {function} fanToPercent — shared fan scaler from message-parser
 */
function extractDiagnostics(p, fanToPercent) {
  return {
    nozzles: extractNozzles(p),
    printError: extractPrintError(p),
    firmware: extractFirmware(p),
    aiMonitoring: extractAiMonitoring(p),
    sdCard: extractSdCard(p),
    network: extractNetwork(p),
    camera: extractCamera(p),
    chamberLight: extractChamberLight(p),
    amsHumidity: extractAmsHumidity(p),
    heatbreakFanSpeed: p.heatbreak_fan_speed != null ? fanToPercent(p.heatbreak_fan_speed) : null,
    developerMode: extractDeveloperMode(p),
  };
}

module.exports = { extractDiagnostics, nozzleTypeName, formatPrintError, ipFromInt, PRINT_ERROR_USER_CANCELLED };
