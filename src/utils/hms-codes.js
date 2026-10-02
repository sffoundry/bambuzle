'use strict';

// HMS (Health Management System) error code lookup.
//
// MQTT `print.hms` entries are `{ attr, code }` 32-bit integers. Layout (per Bambu Studio
// src/slic3r/GUI/DeviceCore/DevHMS.cpp):
//   attr = module(8) | module_num / AMS unit (8) | part (8) | reserved (8)
//   code = level(16) | message code (16)
// The lookup key is `AAAA_AAAA_CCCC_CCCC`: attr hex then code hex, upper case.
//
// The dictionary lives in hms-codes.en.json, generated at dev time by
// scripts/update-hms-codes.js (see its `_meta` header for source, license and date).
// It is loaded once at require time; there are no network calls at runtime.

const HMS_DATA = require('./hms-codes.en.json');

const HMS_CODES = HMS_DATA.codes;
const HMS_META = HMS_DATA._meta;

const WIKI_BASE = 'https://wiki.bambulab.com';
const HMS_WIKI_INDEX = `${WIKI_BASE}/en/hms/home`;

// code >> 16 — Bambu Studio HMSMessageLevel.
const SEVERITY_LEVELS = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };

// attr >> 24 — Bambu Studio ModuleID (0x03/0x05/0x07/0x08/0x0C); 0x12/0x18 named from the
// dataset text ("AMS Lite …", "AMS-HT …").
const SUBSYSTEMS = {
  0x03: 'motion-controller',
  0x05: 'mainboard',
  0x07: 'ams',
  0x08: 'toolhead',
  0x0c: 'xcam',
  0x12: 'ams-lite',
  0x18: 'ams-ht',
};
const AMS_MODULES = new Set([0x07, 0x12, 0x18]);

/** Backward-compatible flat map: key -> default description (non-empty only). */
const HMS_DESCRIPTIONS = Object.freeze(Object.fromEntries(
  Object.entries(HMS_CODES).filter(([, v]) => v.d).map(([k, v]) => [k, v.d]),
));

function toHex8(n) {
  return ((Number(n) || 0) >>> 0).toString(16).padStart(8, '0');
}

function formatHmsKey(attr, code) {
  const attrHex = toHex8(attr);
  const codeHex = toHex8(code);
  return `${attrHex.slice(0, 4)}_${attrHex.slice(4, 8)}_${codeHex.slice(0, 4)}_${codeHex.slice(4, 8)}`.toUpperCase();
}

function getSeverity(code) {
  return SEVERITY_LEVELS[((Number(code) || 0) >>> 0) >>> 16] || 'unknown';
}

function getSubsystem(attr) {
  return SUBSYSTEMS[(((Number(attr) || 0) >>> 0) >>> 24) & 0xff] || 'unknown';
}

/** AMS unit letter: unit index 0 -> A; AMS-HT units are reported as 0x80 + index. */
function amsUnitLetter(unit) {
  return String.fromCharCode(65 + (unit & 0x7f));
}

function pickText(entry, model) {
  if (model && entry.m && entry.m[model]) return entry.m[model];
  return entry.d || '';
}

function pickWiki(entry, model) {
  const p = (model && entry.wm && entry.wm[model]) || entry.w;
  return p ? `${WIKI_BASE}${p}` : null;
}

/**
 * Resolve an HMS code to dictionary data.
 * @param {number} attr
 * @param {number} code
 * @param {string} [model] printer model as used by the dataset (e.g. 'X1C', 'P1S', 'H2D')
 * @returns {{ key: string, description: string, severity: string, subsystem: string,
 *   wikiUrl: string, known: boolean, match: 'exact'|'ams-unit-generic'|'none' }}
 */
function lookupHmsCode(attr, code, model) {
  const key = formatHmsKey(attr, code);
  const severity = getSeverity(code);
  const subsystem = getSubsystem(attr);
  const fallback = `HMS error ${key}`;

  const exact = HMS_CODES[key];
  if (exact) {
    return {
      key,
      description: pickText(exact, model) || fallback,
      severity,
      subsystem,
      wikiUrl: pickWiki(exact, model) || HMS_WIKI_INDEX,
      known: true,
      match: 'exact',
    };
  }

  // AMS unit wildcard: the dataset enumerates the standard units, but if a unit index is
  // missing, reuse unit A's entry (0x00, or 0x80 for AMS-HT) and rename the unit in the text.
  const attrU = ((Number(attr) || 0) >>> 0);
  const module = attrU >>> 24;
  const unit = (attrU >>> 16) & 0xff;
  if (AMS_MODULES.has(module) && unit < 0xfe && (unit & 0x7f) !== 0) {
    const baseAttr = ((attrU & 0xff00ffff) | ((unit & 0x80) << 16)) >>> 0;
    const base = HMS_CODES[formatHmsKey(baseAttr, code)];
    if (base && pickText(base, model)) {
      const letter = amsUnitLetter(unit);
      return {
        key,
        description: pickText(base, model).replace(/\b(AMS(?: Lite|-HT)?) A\b/g, `$1 ${letter}`),
        severity,
        subsystem,
        wikiUrl: pickWiki(base, model) || HMS_WIKI_INDEX,
        known: true,
        match: 'ams-unit-generic',
      };
    }
  }

  return {
    key,
    description: fallback,
    severity,
    subsystem,
    wikiUrl: HMS_WIKI_INDEX,
    known: false,
    match: 'none',
  };
}

/**
 * Look up a human-readable description for an HMS code.
 * Unknown codes return `HMS error AAAA_AAAA_CCCC_CCCC`.
 */
function describeHmsCode(attr, code, model) {
  return lookupHmsCode(attr, code, model).description;
}

/**
 * Parse HMS array from printer message.
 * Each entry: { attr: number, code: number }
 * Output keeps the original `{ attr, code, key, description }` shape and adds
 * `severity`, `subsystem`, `wikiUrl` and `known`.
 */
function parseHmsErrors(hmsArray, model) {
  if (!Array.isArray(hmsArray)) return [];
  return hmsArray
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const info = lookupHmsCode(entry.attr, entry.code, model);
      return {
        attr: entry.attr,
        code: entry.code,
        key: info.key,
        description: info.description,
        severity: info.severity,
        subsystem: info.subsystem,
        wikiUrl: info.wikiUrl,
        known: info.known,
      };
    });
}

module.exports = {
  describeHmsCode,
  parseHmsErrors,
  formatHmsKey,
  lookupHmsCode,
  HMS_DESCRIPTIONS,
  HMS_CODES,
  HMS_META,
  HMS_WIKI_INDEX,
};
