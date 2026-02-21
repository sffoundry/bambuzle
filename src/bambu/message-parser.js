'use strict';

const { GCODE_STATE_MAP, GCODE_STATE } = require('../utils/constants');

/**
 * Deep-merge source into target. Arrays are replaced, not merged.
 * This handles the partial-update pattern from P1P/A1 printers.
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (Array.isArray(srcVal)) {
      result[key] = srcVal;
    } else if (srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Parse an MQTT message payload into a structured update.
 * The printer sends JSON with a `print` key containing status fields.
 */
function parseMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return data;
}

/**
 * Extract the normalized printer state from a merged state object.
 * This picks out the fields we care about for storage and display.
 */
function extractPrinterState(merged) {
  const p = merged.print || {};

  // Decode dual-nozzle temps from extruder.info (H2D and similar)
  // Top-level nozzle temps are the freshest source when present
  let nozzleTemp = p.nozzle_temper ?? null;
  let nozzleTarget = p.nozzle_target_temper ?? null;
  let nozzle2Temp = null;
  let nozzle2Target = null;
  let extruderCount = 1;

  // Multi-path lookup: extruder.info lives at different paths depending on printer/firmware
  const extruderInfo =
    p.extruder?.info ||                  // merged.print.extruder.info (original path)
    p.device?.extruder?.info ||          // merged.print.device.extruder.info
    merged.device?.extruder?.info ||     // merged.device.extruder.info (top-level)
    null;

  // Extruder count from extruder.state bitmask (bits 0-3 = count)
  const extruderState =
    p.extruder?.state ?? p.device?.extruder?.state ?? merged.device?.extruder?.state ?? null;
  if (extruderState != null) {
    const count = extruderState & 0xF;
    if (count > 0) extruderCount = count;
  }

  if (Array.isArray(extruderInfo) && extruderInfo.length > 0) {
    if (extruderInfo.length > extruderCount) extruderCount = extruderInfo.length;
    const isDualNozzle = extruderInfo.length > 1;

    // Nozzle 1: on dual-nozzle printers (H2D), always use packed extruder value —
    // top-level nozzle_temper reports the idle nozzle, not necessarily extruder 0.
    // On single-nozzle printers, top-level is fresher and preferred.
    const e0 = extruderInfo[0];
    if (e0 && e0.temp != null) {
      if (isDualNozzle) {
        nozzleTemp = e0.temp & 0xFFFF;
        nozzleTarget = (e0.temp >> 16) & 0xFFFF;
      } else {
        if (nozzleTemp == null) nozzleTemp = e0.temp & 0xFFFF;
        if (nozzleTarget == null) nozzleTarget = (e0.temp >> 16) & 0xFFFF;
      }
    }

    // Nozzle 2: always from packed (no top-level field exists for nozzle 2)
    if (isDualNozzle) {
      const e1 = extruderInfo[1];
      if (e1 && e1.temp != null) {
        nozzle2Temp = e1.temp & 0xFFFF;
        nozzle2Target = (e1.temp >> 16) & 0xFFFF;
      }
    }
  }

  return {
    gcodeState: GCODE_STATE_MAP[p.gcode_state] || GCODE_STATE.UNKNOWN,
    gcodeFile: p.gcode_file || p.subtask_name || '',
    subtaskName: p.subtask_name || '',
    taskId: p.task_id || '',
    progress: p.mc_percent ?? null,
    remainingMin: p.mc_remaining_time ?? null,
    layerNum: p.layer_num ?? null,
    totalLayers: p.total_layer_num ?? null,

    // Temperatures
    nozzleTemp,
    nozzleTarget,
    nozzle2Temp,
    nozzle2Target,
    extruderCount,
    bedTemp: p.bed_temper ?? null,
    bedTarget: p.bed_target_temper ?? null,
    chamberTemp: p.chamber_temper ?? null,

    // Fan speeds (0-15 → percentage)
    partFanSpeed: p.cooling_fan_speed != null ? fanToPercent(p.cooling_fan_speed) : null,
    auxFanSpeed: p.big_fan1_speed != null ? fanToPercent(p.big_fan1_speed) : null,
    chamberFanSpeed: p.big_fan2_speed != null ? fanToPercent(p.big_fan2_speed) : null,

    // Speed
    speedLevel: p.spd_lvl ?? null,
    speedMagnitude: p.spd_mag ?? null,

    // WiFi
    wifiSignal: p.wifi_signal != null ? parseInt(p.wifi_signal, 10) : null,

    // HMS errors
    hmsErrors: p.hms || [],

    // AMS
    ams: p.ams || null,

    // Misc
    sdcard: p.sdcard ?? null,
    online: p.online ?? null,
    printType: p.print_type || '',
    bigFan1Speed: p.big_fan1_speed ?? null,
    bigFan2Speed: p.big_fan2_speed ?? null,
  };
}

/**
 * Convert BambuLab fan speed value to percentage.
 * Values are reported as a string like "15" (max) or number 0-15.
 */
function fanToPercent(val) {
  const num = typeof val === 'string' ? parseInt(val, 10) : val;
  if (isNaN(num)) return null;
  // Some printers report 0-100, others 0-15
  if (num > 15) return Math.round(num);
  return Math.round((num / 15) * 100);
}

module.exports = { deepMerge, parseMessage, extractPrinterState, fanToPercent };
