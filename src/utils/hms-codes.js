'use strict';

// HMS (Health Management System) error code lookup
// Format: ATTR_MODULE_CODE where each is a hex value
// This is a subset of common codes — full list at https://wiki.bambulab.com/en/x1/troubleshooting/hmscode
const HMS_DESCRIPTIONS = {
  // AMS errors
  '0700_0100_0001_0001': 'AMS1 Slot1: filament runout',
  '0700_0100_0001_0002': 'AMS1 Slot2: filament runout',
  '0700_0100_0001_0003': 'AMS1 Slot3: filament runout',
  '0700_0100_0001_0004': 'AMS1 Slot4: filament runout',
  '0700_0200_0002_0001': 'AMS1: filament may be tangled or stuck',
  '0700_0400_0002_0001': 'AMS1: RFID read failure',
  '0700_0100_0003_0001': 'AMS1: retraction motor overloaded',
  '0700_0100_0003_0002': 'AMS1: filament cutter failure',

  // Print head
  '0300_0100_0001_0001': 'Nozzle temperature malfunction',
  '0300_0100_0001_0002': 'Nozzle temperature abnormal',
  '0300_0200_0001_0001': 'Nozzle heater short circuit',
  '0300_0300_0001_0001': 'Nozzle heater open circuit',
  '0300_0100_0002_0001': 'Nozzle clog detected',
  '0300_0100_0003_0001': 'Filament broken or missing in extruder',

  // Bed
  '0500_0100_0001_0001': 'Bed temperature malfunction',
  '0500_0200_0001_0001': 'Bed heater short circuit',
  '0500_0300_0001_0001': 'Bed heater open circuit',

  // Chamber
  '0500_0100_0002_0001': 'Chamber temperature anomaly',

  // System
  '0100_0100_0001_0001': 'System error: firmware update recommended',
  '0100_0300_0001_0001': 'Motor driver overheat',
  '0100_0100_0002_0001': 'WiFi connection lost',
  '0100_0100_0003_0001': 'SD card error',

  // First layer
  '0C00_0100_0001_0001': 'First layer inspection failed',
  '0C00_0100_0002_0001': 'Spaghetti detected',

  // Generic
  '0000_0000_0000_0000': 'Unknown error',
};

/**
 * Look up a human-readable description for an HMS code.
 * HMS codes from the printer come as an array of objects with
 * `attr`, `code` fields (each 32-bit hex).
 */
function describeHmsCode(attr, code) {
  // Format: attr is 0x0700XXYY, code is 0xZZZZWWWW
  // Normalize to the lookup key format
  const attrHex = (attr >>> 0).toString(16).padStart(8, '0');
  const codeHex = (code >>> 0).toString(16).padStart(8, '0');
  const key = `${attrHex.slice(0, 4)}_${attrHex.slice(4, 8)}_${codeHex.slice(0, 4)}_${codeHex.slice(4, 8)}`.toUpperCase();

  return HMS_DESCRIPTIONS[key] || `HMS error ${key}`;
}

/**
 * Parse HMS array from printer message.
 * Each entry: { attr: number, code: number }
 */
function parseHmsErrors(hmsArray) {
  if (!Array.isArray(hmsArray)) return [];
  return hmsArray.map((entry) => ({
    attr: entry.attr,
    code: entry.code,
    key: formatHmsKey(entry.attr, entry.code),
    description: describeHmsCode(entry.attr, entry.code),
  }));
}

function formatHmsKey(attr, code) {
  const attrHex = (attr >>> 0).toString(16).padStart(8, '0');
  const codeHex = (code >>> 0).toString(16).padStart(8, '0');
  return `${attrHex.slice(0, 4)}_${attrHex.slice(4, 8)}_${codeHex.slice(0, 4)}_${codeHex.slice(4, 8)}`.toUpperCase();
}

module.exports = { describeHmsCode, parseHmsErrors, formatHmsKey, HMS_DESCRIPTIONS };
