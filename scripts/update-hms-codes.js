#!/usr/bin/env node
'use strict';

/**
 * Dev-time generator for src/utils/hms-codes.en.json.
 *
 * Source: the English HMS text + wiki link tables shipped in the MIT-licensed
 * greghesp/ha-bambulab Home Assistant integration
 * (custom_components/bambu_lab/pybambu/hms_error_text/). Those tables are built by
 * ha-bambulab's scripts/update_error_text.py from Bambu Lab's public HMS endpoint
 * (https://e.bambulab.com/query.php?lang=en&d=<serial prefix>, queried per printer model)
 * and the Bambu Lab HMS wiki index (https://wiki.bambulab.com/en/hms/home).
 *
 * Usage:  node scripts/update-hms-codes.js [git-ref]   (default ref: main)
 * Requires network access (Node 20+ built-in fetch). Never run at app runtime.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = 'greghesp/ha-bambulab';
const DATA_DIR = 'custom_components/bambu_lab/pybambu/hms_error_text';
const OUT_FILE = path.join(__dirname, '..', 'src', 'utils', 'hms-codes.en.json');

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bambuzle-hms-update' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveCommit(ref) {
  const url = `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`;
  const json = JSON.parse((await fetchBuffer(url)).toString('utf8'));
  return json.sha;
}

async function fetchGzJson(sha, name) {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${DATA_DIR}/${name}`;
  return JSON.parse(zlib.gunzipSync(await fetchBuffer(url)).toString('utf8'));
}

/** Upstream packs { message: [models...] }; the empty model list marks the default. */
function unpack(entry) {
  let def = null;
  const byModel = {};
  for (const [value, models] of Object.entries(entry)) {
    if (!models || models.length === 0) def = value;
    else for (const m of models) byModel[m] = value;
  }
  if (def === null) {
    // No default variant: promote the first one.
    const first = Object.keys(entry)[0];
    def = first;
  }
  return { def, byModel };
}

/** '0300010000010001' -> '0300_0100_0001_0001' */
function toKey(hex) {
  const h = hex.toUpperCase();
  return `${h.slice(0, 4)}_${h.slice(4, 8)}_${h.slice(8, 12)}_${h.slice(12, 16)}`;
}

async function main() {
  const ref = process.argv[2] || 'main';
  const sha = await resolveCommit(ref);
  const hms = await fetchGzJson(sha, 'hms_en.json.gz');
  const wiki = await fetchGzJson(sha, 'wiki_links.json.gz');

  const codes = {};
  const allHex = new Set([...Object.keys(hms.device_hms || {}), ...Object.keys(wiki)]);
  for (const hex of [...allHex].sort()) {
    if (!/^[0-9A-Fa-f]{16}$/.test(hex)) continue;
    const out = {};
    const text = hms.device_hms?.[hex];
    if (text) {
      const { def, byModel } = unpack(text);
      out.d = def || '';
      const variants = Object.fromEntries(Object.entries(byModel).filter(([, v]) => v && v !== def));
      if (Object.keys(variants).length) out.m = variants;
    } else {
      out.d = '';
    }
    const links = wiki[hex];
    if (links) {
      const { def, byModel } = unpack(links);
      out.w = def;
      const variants = Object.fromEntries(Object.entries(byModel).filter(([, v]) => v !== def));
      if (Object.keys(variants).length) out.wm = variants;
    }
    codes[toKey(hex)] = out;
  }

  const doc = {
    _meta: {
      description: 'Bambu Lab HMS (Health Management System) codes, English. Keys are AAAA_AAAA_CCCC_CCCC (attr hex + code hex). d = default text, m = per-model text overrides, w = wiki path (relative to https://wiki.bambulab.com), wm = per-model wiki paths.',
      source: `https://github.com/${REPO}/tree/${sha}/${DATA_DIR}`,
      sourceFiles: ['hms_en.json.gz', 'wiki_links.json.gz'],
      sourceCommit: sha,
      sourceLicense: 'MIT (https://github.com/greghesp/ha-bambulab/blob/main/LICENSE)',
      upstreamOrigin: 'Text originates from Bambu Lab\'s public HMS endpoint https://e.bambulab.com/query.php?lang=en (per-model); wiki paths scraped from https://wiki.bambulab.com/en/hms/home. Bambu Lab publishes no explicit license for this text; it is redistributed here as in ha-bambulab.',
      retrieved: new Date().toISOString().slice(0, 10),
      generator: 'scripts/update-hms-codes.js',
      entryCount: Object.keys(codes).length,
    },
    codes,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(doc, null, 0).replace(/,"(?=[0-9A-F]{4}_)/g, ',\n"') + '\n');
  console.log(`Wrote ${doc._meta.entryCount} codes from ${REPO}@${sha.slice(0, 7)} to ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
