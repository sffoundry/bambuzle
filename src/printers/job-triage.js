'use strict';

// BAM-40: print-failure triage. Turns what Bambuzle already records for a job (HMS + print_error events,
// temperature anomalies, pauses, layer timings, state changes) into one explainable verdict:
//   intervene — something that typically ruins the print or needs hands on the printer now
//   inspect   — worth a look when it finishes
//   clean     — nothing notable
// Deliberately rule-based and transparent (every verdict lists its reasons and thresholds) — no
// camera/AI claims; xcam fields are detector *settings*, not detections (see src/bambu/diagnostics.js).

const RULES = {
  stallFactor: 4, // a layer taking ≥ 4× the job's median layer time counts as a stall
  stallMinSec: 300, // …and at least 5 minutes, so tiny first layers don't trip it
  anomalyBurst: 3, // ≥ 3 temperature anomalies on one sensor within …
  anomalyWindowSec: 600, // … 10 minutes
  clusterGapSec: 180, // timeline items within 3 minutes are clustered
};

const HMS_LEVELS = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };

/** HMS level from a stored key AAAA_AAAA_CCCC_CCCC (level = top 16 bits of the code). */
function hmsLevel(key) {
  const parts = String(key || '').split('_');
  return parts.length === 4 ? HMS_LEVELS[parseInt(parts[2], 16)] || 'unknown' : 'unknown';
}

const toMs = (ts) => (ts ? Date.parse(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z')) : NaN);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {object} data — { job, events, anomalies, pauses, layers } as stored rows
 * @returns {{ verdict, reasons: string[], timeline: object[], clusters: object[], rules }}
 */
function triageJob({ job, events = [], anomalies = [], pauses = [], layers = [] }) {
  const timeline = [];
  const intervene = [];
  const inspect = [];

  for (const e of events) {
    if (e.event_type === 'hms_error') {
      const level = hmsLevel(e.code);
      const severity = level === 'fatal' || level === 'serious' ? 'intervene' : 'inspect';
      timeline.push({ ts: e.ts, kind: 'hms', severity, title: `HMS ${e.code} (${level})`, detail: e.message || '' });
      (severity === 'intervene' ? intervene : inspect).push(`${level} HMS error ${e.code}: ${e.message || ''}`.trim());
    } else if (e.event_type === 'print_error') {
      timeline.push({ ts: e.ts, kind: 'print_error', severity: 'intervene', title: `Printer error ${e.code || ''}`.trim(), detail: e.message || '' });
      intervene.push(`printer reported error ${e.code || ''}`.trim());
    } else if (e.event_type === 'state_change' && /→ FAILED/.test(e.message || '') && !/cancelled by user/i.test(e.message || '')) {
      timeline.push({ ts: e.ts, kind: 'state', severity: 'intervene', title: 'Print failed', detail: e.message });
      intervene.push('print ended FAILED');
    } else if (e.event_type === 'command') {
      timeline.push({ ts: e.ts, kind: 'command', severity: 'info', title: 'Operator command', detail: e.message || '' });
    }
  }

  for (const p of pauses) {
    const byError = p.pause_source && p.pause_source !== 'user';
    const resumedAfterSec = p.resumed_at ? Math.round((toMs(p.resumed_at) - toMs(p.paused_at)) / 1000) : null;
    timeline.push({
      ts: p.paused_at,
      kind: 'pause',
      severity: byError ? 'intervene' : 'inspect',
      title: byError ? 'Paused by the printer' : 'Paused by user',
      detail: [p.layer_num != null ? `layer ${p.layer_num}` : null, p.hms_codes ? `HMS ${p.hms_codes}` : null,
        resumedAfterSec != null ? `resumed after ${Math.round(resumedAfterSec / 60)} min` : 'not resumed'].filter(Boolean).join(' · '),
    });
    if (byError) intervene.push(`printer paused itself${p.layer_num != null ? ` at layer ${p.layer_num}` : ''}${p.hms_codes ? ` (HMS ${p.hms_codes})` : ''}`);
    else inspect.push(`paused by user${p.layer_num != null ? ` at layer ${p.layer_num}` : ''}`);
  }

  // Temperature anomalies: each is "inspect"; a burst on one sensor escalates to "intervene"
  const bySensor = {};
  for (const a of anomalies) {
    timeline.push({
      ts: a.ts, kind: 'temp', severity: 'inspect',
      title: `${a.sensor} ${a.anomaly_type}`,
      detail: `${a.actual_temp}°C${a.target_temp != null ? ` vs ${a.target_temp}°C` : ''}${a.layer_num != null ? ` · layer ${a.layer_num}` : ''}`,
    });
    (bySensor[a.sensor] ||= []).push(toMs(a.ts));
  }
  for (const [sensor, times] of Object.entries(bySensor)) {
    times.sort((x, y) => x - y);
    let burst = false;
    for (let i = 0; i + RULES.anomalyBurst - 1 < times.length; i++) {
      if (times[i + RULES.anomalyBurst - 1] - times[i] <= RULES.anomalyWindowSec * 1000) { burst = true; break; }
    }
    if (burst) intervene.push(`${RULES.anomalyBurst}+ ${sensor} temperature anomalies within ${RULES.anomalyWindowSec / 60} min`);
    else inspect.push(`${times.length} ${sensor} temperature anomal${times.length === 1 ? 'y' : 'ies'}`);
  }

  // Layer stalls relative to this job's own median layer time
  const durations = layers.map((l) => l.duration_sec).filter((d) => Number.isFinite(d) && d > 0);
  const med = median(durations);
  if (med) {
    for (const l of layers) {
      if (Number.isFinite(l.duration_sec) && l.duration_sec >= Math.max(med * RULES.stallFactor, RULES.stallMinSec)) {
        timeline.push({ ts: l.ts, kind: 'stall', severity: 'inspect', title: `Slow layer ${l.layer_num}`, detail: `${Math.round(l.duration_sec / 60)} min vs median ${Math.round(med)} s` });
        inspect.push(`layer ${l.layer_num} took ${Math.round(l.duration_sec / 60)} min (≥ ${RULES.stallFactor}× median)`);
      }
    }
  }

  timeline.sort((a, b) => toMs(a.ts) - toMs(b.ts));

  // Cluster items that happen close together — usually one incident
  const clusters = [];
  for (const item of timeline) {
    const last = clusters[clusters.length - 1];
    if (last && toMs(item.ts) - toMs(last.end) <= RULES.clusterGapSec * 1000) {
      last.items.push(item);
      last.end = item.ts;
      if (rank(item.severity) > rank(last.severity)) last.severity = item.severity;
    } else {
      clusters.push({ start: item.ts, end: item.ts, severity: item.severity, items: [item] });
    }
  }

  const verdict = intervene.length ? 'intervene' : inspect.length ? 'inspect' : 'clean';
  const reasons = [...new Set(verdict === 'intervene' ? intervene : inspect)];
  return { job: job || null, verdict, reasons, timeline, clusters, rules: RULES };
}

function rank(s) {
  return { info: 0, inspect: 1, intervene: 2 }[s] ?? 0;
}

module.exports = { triageJob, hmsLevel, RULES };
