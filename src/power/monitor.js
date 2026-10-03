'use strict';

// BAM-18: polls each configured plug, keeps the latest reading, and writes one row per printer per
// minute (average, peak, energy). Energy is integrated from the readings (W × elapsed time); gaps
// longer than MAX_GAP_MS are not counted, so an outage doesn't invent energy. Read-only: never
// switches a plug.

const power = require('../db/power');
const { readPlug } = require('./plug-readers');

const POLL_MS = 15 * 1000;
const MAX_GAP_MS = 60 * 1000;

const minuteKey = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ':00';

/**
 * @param {object} opts
 * @param {object} opts.log
 * @param {function} [opts.read] — injectable plug reader (tests)
 * @param {function} [opts.now]
 * @param {function} [opts.onReading] — (deviceId, reading) after each poll (UI push)
 */
function createPowerMonitor({ log, read = readPlug, now = Date.now, onReading = () => {} }) {
  const live = new Map(); // deviceId -> { watts, at, ok, error, circuit }
  const buckets = new Map(); // deviceId -> { minute, sumW, n, maxW, wh, lastAt, lastW }
  let timer = null;
  let polling = false;
  let again = false; // a poll was requested while one was running (e.g. right after a plug was saved)

  function account(deviceId, watts, t) {
    let b = buckets.get(deviceId);
    const minute = minuteKey(t);
    if (b && b.minute !== minute) { flush(deviceId, b); b = { ...b, minute, sumW: 0, n: 0, maxW: 0, wh: 0 }; }
    if (!b) b = { minute, sumW: 0, n: 0, maxW: 0, wh: 0, lastAt: null, lastW: null };
    if (b.lastAt != null && t - b.lastAt <= MAX_GAP_MS) b.wh += ((b.lastW + watts) / 2) * ((t - b.lastAt) / 3600e3); // trapezoid
    b.sumW += watts;
    b.n += 1;
    b.maxW = Math.max(b.maxW, watts);
    b.lastAt = t;
    b.lastW = watts;
    buckets.set(deviceId, b);
    flush(deviceId, b); // keep the open minute current in the DB too (cheap upsert; survives a restart)
  }

  function flush(deviceId, b) {
    if (!b.n) return;
    power.upsertMinute(deviceId, b.minute, { avgW: Math.round((b.sumW / b.n) * 10) / 10, maxW: b.maxW, wh: Math.round(b.wh * 1000) / 1000 });
  }

  async function pollOnce() {
    if (polling) { again = true; return; }
    polling = true;
    try {
      const plugs = power.listPlugs().filter((p) => p.enabled);
      const seen = new Set(plugs.map((p) => p.deviceId));
      for (const id of live.keys()) if (!seen.has(id)) { live.delete(id); buckets.delete(id); }
      await Promise.all(plugs.map(async (p) => {
        const t = now();
        try {
          const r = await read(p);
          live.set(p.deviceId, { watts: r.watts, at: new Date(t).toISOString(), ok: true, error: null, circuit: p.circuit || '' });
          account(p.deviceId, r.watts, t);
        } catch (err) {
          const prev = live.get(p.deviceId);
          if (!prev || prev.ok) log.warn({ deviceId: p.deviceId, err: err.message }, 'Power plug read failed');
          live.set(p.deviceId, { watts: null, at: new Date(t).toISOString(), ok: false, error: err.message, circuit: p.circuit || '' });
          const b = buckets.get(p.deviceId);
          if (b) b.lastAt = null; // don't integrate across a failed read
        }
        onReading(p.deviceId, live.get(p.deviceId));
      }));
    } finally {
      polling = false;
    }
    if (again) { again = false; await pollOnce(); }
  }

  /** Latest reading for one printer + its circuit's total and limit (for cards and alert rules). */
  function snapshot(deviceId) {
    const r = live.get(deviceId);
    if (!r) return null;
    const c = r.circuit ? circuitStatus().find((x) => x.name === r.circuit) : null;
    return { ...r, circuitWatts: c?.watts ?? null, circuitLimitW: c?.limitW ?? null };
  }

  /** Per circuit: summed live watts of its plugs, the configured limit, and whether it's over. */
  function circuitStatus() {
    const { circuits } = power.getSettings();
    const totals = {};
    for (const r of live.values()) if (r.circuit && r.ok) totals[r.circuit] = (totals[r.circuit] || 0) + r.watts;
    const names = new Set([...circuits.map((c) => c.name), ...Object.keys(totals)]);
    return [...names].map((name) => {
      const limitW = circuits.find((c) => c.name === name)?.limitW ?? null;
      const watts = Math.round((totals[name] || 0) * 10) / 10;
      return { name, watts, limitW, over: limitW != null && watts > limitW };
    });
  }

  function start() {
    pollOnce().catch((err) => log.error({ err }, 'Power poll failed'));
    timer = setInterval(() => pollOnce().catch((err) => log.error({ err }, 'Power poll failed')), POLL_MS);
    timer.unref?.();
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const api = { start, stop, pollOnce, snapshot, circuitStatus, liveReadings: () => Object.fromEntries(live) };
  return api;
}

module.exports = { createPowerMonitor, minuteKey, POLL_MS, MAX_GAP_MS };
