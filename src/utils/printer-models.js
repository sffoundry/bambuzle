'use strict';

// Printer model keys as used by the HMS dataset (src/utils/hms-codes.en.json `m` / `wm`): X1C, H2D, A1MINI…
// BAM-50. Preferred source: the printer's own get_version reply (`product_name`, e.g. "Bambu Lab H2D"),
// mapped as in ha-bambulab pybambu utils.get_printer_type (MIT). Fallback: the cloud device list's model
// code — only codes we're confident about (O1D/BL-P001/N1 confirmed against real printers 2026-10-03).

const PRODUCT_NAME_TO_KEY = {
  'Bambu Lab A1': 'A1',
  'Bambu Lab A1 mini': 'A1MINI',
  'Bambu Lab A2L': 'A2L',
  'Bambu Lab P1P': 'P1P',
  'Bambu Lab P1S': 'P1S',
  'Bambu Lab P2S': 'P2S',
  'Bambu Lab H2C': 'H2C',
  'Bambu Lab H2D': 'H2D',
  'Bambu Lab H2D Pro': 'H2DPRO',
  'Bambu Lab H2S': 'H2S',
  'Bambu Lab X2D': 'X2D',
  // X1 series is detected from hw_ver/project_name below (pybambu does the same)
};

const CLOUD_CODE_TO_KEY = {
  'BL-P001': 'X1C',
  'BL-P002': 'X1',
  C13: 'X1E',
  C11: 'P1P',
  C12: 'P1S',
  N1: 'A1MINI',
  N2S: 'A1',
  O1D: 'H2D',
};

/** From a get_version module list: { product_name, hw_ver, project_name, … }[] (same rules as pybambu). */
function modelKeyFromModules(modules) {
  if (!Array.isArray(modules)) return null;
  for (const m of modules) {
    if (m && PRODUCT_NAME_TO_KEY[m.product_name]) return PRODUCT_NAME_TO_KEY[m.product_name];
  }
  const ap = modules.find((m) => typeof m?.hw_ver === 'string' && m.hw_ver.startsWith('AP0'));
  if (!ap) return null;
  if (ap.hw_ver === 'AP02') return 'X1E';
  if (ap.project_name === 'N1') return 'A1MINI';
  if (ap.hw_ver === 'AP04') return ap.project_name === 'C11' ? 'P1P' : ap.project_name === 'C12' ? 'P1S' : null;
  if (ap.hw_ver === 'AP05') return ap.project_name === 'N2S' ? 'A1' : !ap.project_name ? 'X1C' : null;
  return null;
}

function modelKeyFromCloudCode(code) {
  return CLOUD_CODE_TO_KEY[String(code || '').trim()] || null;
}

/** Firmware version from get_version (the "ota" module). */
function firmwareFromModules(modules) {
  return Array.isArray(modules) ? modules.find((m) => m?.name === 'ota')?.sw_ver || null : null;
}

module.exports = { modelKeyFromModules, modelKeyFromCloudCode, firmwareFromModules, PRODUCT_NAME_TO_KEY };
