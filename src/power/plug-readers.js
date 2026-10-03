'use strict';

// BAM-18: read-only smart-plug readers. Each turns one HTTP GET into { watts, totalWh? }.
// Nothing here can switch a plug: only status/read endpoints are ever requested.
//
// Supported (local APIs, no cloud):
//   shelly-gen2    Shelly Plus / Pro / Gen3 / Gen4 plugs:  GET <url>/rpc/Switch.GetStatus?id=<channel>
//   shelly-gen1    Shelly Plug / Plug S / 1PM (Gen1):      GET <url>/status   (meters[<channel>])
//   tasmota        Tasmota with an energy sensor:          GET <url>/cm?cmnd=Status%2010
//   homeassistant  any HA power sensor (W or kW):          GET <url>/api/states/<entity>  (Bearer token)
//   http-json      anything returning JSON:                GET <url>, value at <jsonPath>, in watts
//
// Safety: http(s) only, no redirects followed, 3 s timeout, 64 KB response cap. Errors never echo the
// URL or response body (URLs can embed a password; bodies can hold anything).

const KINDS = ['shelly-gen2', 'shelly-gen1', 'tasmota', 'homeassistant', 'http-json'];
const TIMEOUT_MS = 3000;
const MAX_BYTES = 64 * 1024;

class PlugError extends Error {}

function baseUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new PlugError('Plug URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PlugError('Plug URL must start with http:// or https://');
  return u;
}

/** Validate a plug config; returns a list of problems (empty = OK). Exported for the API. */
function validatePlug(p) {
  const errors = [];
  if (!KINDS.includes(p.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  try { baseUrl(p.url); } catch (e) { errors.push(e.message); }
  if (String(p.url || '').length > 300) errors.push('Plug URL is too long');
  if (p.channel != null && !(Number.isInteger(p.channel) && p.channel >= 0 && p.channel <= 16)) errors.push('channel must be 0–16');
  if (p.kind === 'homeassistant' && !/^sensor\.[a-z0-9_]{1,100}$/.test(p.entity || '')) errors.push('entity must be a Home Assistant sensor id like sensor.printer_plug_power');
  if (p.kind === 'http-json' && !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/.test(p.jsonPath || '')) errors.push('jsonPath must look like a.b.c (letters, digits, _; array indexes as numbers)');
  return errors;
}

function requestFor(p) {
  const u = baseUrl(p.url);
  const root = u.href.replace(/\/+$/, '');
  const ch = p.channel ?? 0;
  const headers = { Accept: 'application/json' };
  switch (p.kind) {
    case 'shelly-gen2': return { url: `${root}/rpc/Switch.GetStatus?id=${ch}`, headers };
    case 'shelly-gen1': return { url: `${root}/status`, headers };
    case 'tasmota': return { url: `${root}/cm?cmnd=Status%2010`, headers };
    case 'homeassistant': return { url: `${root}/api/states/${encodeURIComponent(p.entity)}`, headers: { ...headers, ...(p.secret ? { Authorization: `Bearer ${p.secret}` } : {}) } };
    case 'http-json': return { url: u.href, headers: { ...headers, ...(p.secret ? { Authorization: `Bearer ${p.secret}` } : {}) } };
    default: throw new PlugError('Unknown plug kind');
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

/** Parse a plug's JSON reply into { watts, totalWh }. Exported for tests. */
function parseReading(p, body) {
  const ch = p.channel ?? 0;
  let watts = null;
  let totalWh = null;
  switch (p.kind) {
    case 'shelly-gen2':
      watts = num(body?.apower);
      totalWh = num(body?.aenergy?.total); // Wh
      break;
    case 'shelly-gen1': {
      const m = body?.meters?.[ch] ?? body?.emeters?.[ch];
      watts = num(m?.power);
      const t = num(m?.total); // watt-minutes on Gen1 meters
      totalWh = t == null ? null : t / 60;
      break;
    }
    case 'tasmota': {
      const e = body?.StatusSNS?.ENERGY;
      const pw = Array.isArray(e?.Power) ? e.Power[ch] : e?.Power;
      watts = num(pw);
      const t = num(e?.Total); // kWh
      totalWh = t == null ? null : t * 1000;
      break;
    }
    case 'homeassistant': {
      const v = num(body?.state);
      const unit = String(body?.attributes?.unit_of_measurement || 'W');
      watts = v == null ? null : unit === 'kW' ? v * 1000 : unit === 'W' ? v : null;
      if (v != null && watts == null) throw new PlugError(`Sensor unit is ${unit.slice(0, 10)} — pick a power sensor in W or kW`);
      break;
    }
    case 'http-json': {
      let v = body;
      for (const k of String(p.jsonPath).split('.')) v = v == null ? undefined : v[/^\d+$/.test(k) ? Number(k) : k];
      watts = num(v);
      break;
    }
    default: break;
  }
  if (watts == null) throw new PlugError('Plug answered, but without a power reading — check the plug type / channel');
  if (watts < 0 || watts > 100000) throw new PlugError('Plug reported an implausible power value');
  return { watts: Math.round(watts * 10) / 10, totalWh };
}

/** One reading. Rejects with PlugError (safe message). `fetchFn` injectable for tests. */
async function readPlug(p, { fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const { url, headers } = requestFor(p);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchFn(url, { headers, redirect: 'manual', signal: ac.signal });
    } catch (err) {
      throw new PlugError(err.name === 'AbortError' ? `No answer within ${timeoutMs / 1000}s` : `Can't reach the plug (${err.cause?.code || err.code || 'network error'})`);
    }
    if (res.status >= 300 && res.status < 400) throw new PlugError('Plug answered with a redirect — use its direct address');
    if (res.status === 401 || res.status === 403) throw new PlugError('Plug refused the request — check the token / password');
    if (!res.ok) throw new PlugError(`Plug answered HTTP ${res.status}`);
    const text = await readCapped(res);
    let body;
    try { body = JSON.parse(text); } catch { throw new PlugError('Plug did not answer with JSON — check the plug type'); }
    return parseReading(p, body);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new PlugError('Plug response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

module.exports = { KINDS, PlugError, validatePlug, parseReading, readPlug, requestFor };
