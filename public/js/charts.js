// ─── Chart Registry & Multi-Chart System ───

const charts = {};           // chartId -> { chart, observer }
const chartVisibility = {};  // chartId -> boolean
let currentSamples = null;   // cached for on-demand render when toggling
let currentEvents = null;
let currentDeviceId = null;
let currentRange = '24h';
let currentFilters = null;
let currentJobData = null;   // { job, layers, anomalies, pauses }

// Live data buffers
let liveBuffer = [];

// Zoom sync state
let zoomCallback = null;
let highlightedEventTs = null;
export function setZoomCallback(cb) { zoomCallback = cb; }
let _syncingZoom = false;

const VISIBILITY_KEY = 'bambuzle_chart_visibility';
const DEFAULT_VIS = { temp: true, fan: true, speed: false, progress: false, wifi: false, layer: false, efficiency: false };

const COLORS = {
  nozzle: '#ff3333',
  nozzleTarget: '#ff333366',
  nozzle2: '#ff6666',
  nozzle2Target: '#ff666666',
  bed: '#ff8800',
  bedTarget: '#ff880066',
  chamber: '#cc66ff',
  progress: '#00cc66',
  layer: '#00ff44',
  partFan: '#00bbff',
  auxFan: '#ff66aa',
  chamberFan: '#ffcc00',
  speedLevel: '#ff9900',
  wifiSignal: '#66ff66',
  remaining: '#ff66ff',
  progressRate: '#00cc66',
  layerDuration: '#00ffcc',
  anomalyDeviation: '#ff0000',
  anomalyRate: '#ff8800',
  pauseRegion: '#cccc0033',
  activeTime: '#00cc66',
  pauseTime: '#cccc00',
};

// Shared axis styling
const AXIS_STYLE = {
  stroke: '#338855',
  grid: { stroke: '#1a4a2a44' },
  font: '10px Courier New',
  ticks: { stroke: '#1a4a2a' },
};

// ─── Anomaly overlay data (mutable, read by plugin closure) ───
let anomalyOverlayData = { anomalies: [], pauses: [] };

// ─── Event overlay plugin (for temp chart) ───
function eventsPlugin(events) {
  return {
    hooks: {
      draw: [(u) => {
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;

        for (const evt of events) {
          const ts = new Date(evt.ts.endsWith('Z') ? evt.ts : evt.ts + 'Z').getTime() / 1000;
          const x = u.valToPos(ts, 'x', true);
          if (x < left || x > left + width) continue;

          const color = evt.severity === 'error' ? '#ff3333'
            : evt.severity === 'warning' ? '#cccc00'
            : '#00cc66';

          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.globalAlpha = 0.6;
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          ctx.restore();

          if (highlightedEventTs != null && Math.abs(ts - highlightedEventTs) < 0.5) {
            ctx.save();
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 1.0;
            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
            ctx.restore();
          }
        }
      }],
    },
  };
}

// ─── Anomaly overlay plugin (for temp chart) ───
function anomalyPlugin() {
  return {
    hooks: {
      draw: [(u) => {
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        const data = anomalyOverlayData;

        // Draw pause bands
        for (const p of data.pauses) {
          const startTs = new Date(p.paused_at.endsWith('Z') ? p.paused_at : p.paused_at + 'Z').getTime() / 1000;
          const endTs = p.resumed_at
            ? new Date(p.resumed_at.endsWith('Z') ? p.resumed_at : p.resumed_at + 'Z').getTime() / 1000
            : u.scales.x.max;

          const x0 = Math.max(u.valToPos(startTs, 'x', true), left);
          const x1 = Math.min(u.valToPos(endTs, 'x', true), left + width);
          if (x1 < left || x0 > left + width) continue;

          ctx.save();
          ctx.fillStyle = COLORS.pauseRegion;
          ctx.fillRect(x0, top, x1 - x0, height);
          ctx.restore();
        }

        // Draw anomaly diamonds
        for (const a of data.anomalies) {
          const ts = new Date(a.ts.endsWith('Z') ? a.ts : a.ts + 'Z').getTime() / 1000;
          const x = u.valToPos(ts, 'x', true);
          if (x < left || x > left + width) continue;

          const y = u.valToPos(a.actual_temp, 'y', true);
          if (y < top || y > top + height) continue;

          const color = a.anomaly_type === 'rate' ? COLORS.anomalyRate : COLORS.anomalyDeviation;
          const sz = 5;

          ctx.save();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x, y - sz);
          ctx.lineTo(x + sz, y);
          ctx.lineTo(x, y + sz);
          ctx.lineTo(x - sz, y);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }],
    },
  };
}

// ─── Visibility Persistence ───

function loadVisibility() {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...DEFAULT_VIS, ...saved };
    }
  } catch { /* corrupt — reset */ }
  return { ...DEFAULT_VIS };
}

function saveVisibility() {
  localStorage.setItem(VISIBILITY_KEY, JSON.stringify(chartVisibility));
}

function syncToggleUI() {
  const btns = document.querySelectorAll('#chart-toggles .chart-toggle-btn');
  btns.forEach((btn) => {
    const id = btn.dataset.chart;
    btn.classList.toggle('active', !!chartVisibility[id]);
  });

  // Sync container display
  for (const [id, visible] of Object.entries(chartVisibility)) {
    const el = document.getElementById(`${id}-chart`);
    if (el) el.style.display = visible ? '' : 'none';
  }
}

// ─── Chart Toggle Init ───

function initToggles() {
  Object.assign(chartVisibility, loadVisibility());
  syncToggleUI();

  document.querySelectorAll('#chart-toggles .chart-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.chart;
      chartVisibility[id] = !chartVisibility[id];
      saveVisibility();
      syncToggleUI();

      if (chartVisibility[id] && currentSamples) {
        renderChart(id);
      } else if (!chartVisibility[id]) {
        destroyChart(id);
      }
    });
  });
}

// ─── Shared Helpers ───

function tsToSec(ts) {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime() / 1000;
}

function createTimeSeriesChart(chartId, opts, data) {
  destroyChart(chartId);

  const container = document.getElementById(`${chartId}-chart`);
  if (!container) return null;
  container.innerHTML = '';

  const width = container.clientWidth || 800;
  opts.width = width;

  const chart = new uPlot(opts, data, container);
  const observer = new ResizeObserver(() => {
    if (!charts[chartId]) return;
    const newWidth = container.clientWidth;
    if (newWidth > 0 && newWidth !== chart.width) {
      chart.setSize({ width: newWidth, height: chart.height });
    }
  });
  observer.observe(container);

  charts[chartId] = { chart, observer };
  return chart;
}

function destroyChart(chartId) {
  const entry = charts[chartId];
  if (!entry) return;
  entry.observer.disconnect();
  entry.chart.destroy();
  delete charts[chartId];
  const el = document.getElementById(`${chartId}-chart`);
  if (el && chartId !== 'efficiency') el.innerHTML = '';
}

function destroyAllCharts() {
  for (const id of Object.keys(charts)) {
    destroyChart(id);
  }
  // Also clear efficiency since it's HTML-based
  const effEl = document.getElementById('efficiency-chart');
  if (effEl) effEl.innerHTML = '';
  currentDeviceId = null;
  currentSamples = null;
  currentEvents = null;
  currentJobData = null;
  liveBuffer = [];
  anomalyOverlayData = { anomalies: [], pauses: [] };
}

// ─── Zoom Sync ───

const TIME_SERIES_IDS = ['temp', 'fan', 'speed', 'progress', 'wifi'];

function makeZoomHook(sourceId) {
  return (u, key) => {
    if (key !== 'x' || _syncingZoom) return;
    _syncingZoom = true;

    const { min, max } = u.scales.x;

    // Notify app.js zoom callback (for event filtering)
    if (sourceId === 'temp' && zoomCallback) {
      const ts = u.data[0];
      if (ts.length >= 2 && (min > ts[0] + 5 || max < ts[ts.length - 1] - 5)) {
        zoomCallback(min, max);
      }
    }

    // Sync to other time-series charts
    for (const id of TIME_SERIES_IDS) {
      if (id === sourceId) continue;
      const entry = charts[id];
      if (entry) entry.chart.setScale('x', { min, max });
    }

    _syncingZoom = false;
  };
}

// ─── Chart zoom helpers ───

function isChartZoomed(chart) {
  const ts = chart.data[0];
  if (ts.length < 2) return false;
  const scaleX = chart.scales.x;
  const dataMin = ts[0];
  const dataMax = ts[ts.length - 1];
  return (scaleX.min > dataMin + 5) || (scaleX.max < dataMax - 5);
}

function updateChartData(chart, data) {
  const zoomed = isChartZoomed(chart);
  if (zoomed) {
    const savedMin = chart.scales.x.min;
    const savedMax = chart.scales.x.max;
    chart.batch(() => {
      chart.setData(data);
      chart.setScale('x', { min: savedMin, max: savedMax });
    });
  } else {
    chart.setData(data);
  }
}

// ─── Push helper for live updates ───

function pushToChart(chartId, nowSec, cutoff, values) {
  const entry = charts[chartId];
  if (!entry) return;
  const chart = entry.chart;

  chart.data[0].push(nowSec);
  for (let i = 0; i < values.length; i++) {
    chart.data[i + 1].push(values[i]);
  }

  if (cutoff > 0) {
    while (chart.data[0].length > 1 && chart.data[0][0] < cutoff) {
      for (const arr of chart.data) arr.shift();
    }
  }

  updateChartData(chart, chart.data);
}

// ─── Chart Render Functions ───

function renderChart(id) {
  if (!currentSamples || currentSamples.length === 0) return;

  switch (id) {
    case 'temp': renderTempChart(currentSamples, currentEvents || []); break;
    case 'fan': renderFanChart(currentSamples); break;
    case 'speed': renderSpeedChart(currentSamples); break;
    case 'progress': renderProgressChart(currentSamples); break;
    case 'wifi': renderWifiChart(currentSamples); break;
    case 'layer': renderLayerChart(); break;
    case 'efficiency': renderEfficiencyBar(); break;
  }
}

function renderAllCharts() {
  for (const id of Object.keys(chartVisibility)) {
    if (chartVisibility[id]) renderChart(id);
  }
}

// ─── 1. Temperature Chart ───

function renderTempChart(samples, events) {
  const container = document.getElementById('temp-chart');
  if (!container || container.style.display === 'none') return;
  container.innerHTML = '';

  const timestamps = samples.map((s) => tsToSec(s.ts));
  const nozzleTemp = samples.map((s) => s.nozzle_temp);
  const nozzleTarget = samples.map((s) => s.nozzle_target);
  const bedTemp = samples.map((s) => s.bed_temp);
  const bedTarget = samples.map((s) => s.bed_target);
  const chamberTemp = samples.map((s) => s.chamber_temp);

  const isDual = samples.some((s) => s.nozzle2_temp != null);
  let data, series;

  if (isDual) {
    const nozzle2Temp = samples.map((s) => s.nozzle2_temp ?? null);
    const nozzle2Target = samples.map((s) => s.nozzle2_target ?? null);
    data = [timestamps, nozzleTemp, nozzleTarget, nozzle2Temp, nozzle2Target, bedTemp, bedTarget, chamberTemp];
    series = [
      {},
      { label: 'Nozzle L', stroke: COLORS.nozzle, width: 2 },
      { label: 'Nzl L Tgt', stroke: COLORS.nozzleTarget, width: 1, dash: [4, 3] },
      { label: 'Nozzle R', stroke: COLORS.nozzle2, width: 2 },
      { label: 'Nzl R Tgt', stroke: COLORS.nozzle2Target, width: 1, dash: [4, 3] },
      { label: 'Bed', stroke: COLORS.bed, width: 2 },
      { label: 'Bed Tgt', stroke: COLORS.bedTarget, width: 1, dash: [4, 3] },
      { label: 'Chamber', stroke: COLORS.chamber, width: 2 },
    ];
  } else {
    data = [timestamps, nozzleTemp, nozzleTarget, bedTemp, bedTarget, chamberTemp];
    series = [
      {},
      { label: 'Nozzle', stroke: COLORS.nozzle, width: 2 },
      { label: 'Nzl Tgt', stroke: COLORS.nozzleTarget, width: 1, dash: [4, 3] },
      { label: 'Bed', stroke: COLORS.bed, width: 2 },
      { label: 'Bed Tgt', stroke: COLORS.bedTarget, width: 1, dash: [4, 3] },
      { label: 'Chamber', stroke: COLORS.chamber, width: 2 },
    ];
  }

  const opts = {
    title: 'TEMPERATURE',
    height: 380,
    plugins: [eventsPlugin(events), anomalyPlugin()],
    hooks: {
      setScale: [makeZoomHook('temp')],
    },
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { ...AXIS_STYLE },
      { ...AXIS_STYLE, label: 'DEG C', labelFont: '10px Courier New' },
    ],
    series,
  };

  const chart = createTimeSeriesChart('temp', opts, data);
  if (chart) chart._isDual = isDual;
}

// ─── 2. Fan Chart ───

function renderFanChart(samples) {
  const container = document.getElementById('fan-chart');
  if (!container || container.style.display === 'none') return;

  const timestamps = samples.map((s) => tsToSec(s.ts));
  const partFan = samples.map((s) => s.part_fan_speed ?? null);
  const auxFan = samples.map((s) => s.aux_fan_speed ?? null);
  const chamberFan = samples.map((s) => s.chamber_fan_speed ?? null);

  const data = [timestamps, partFan, auxFan, chamberFan];
  const series = [
    {},
    { label: 'Part Fan', stroke: COLORS.partFan, width: 2 },
    { label: 'Aux Fan', stroke: COLORS.auxFan, width: 2 },
    { label: 'Chamber Fan', stroke: COLORS.chamberFan, width: 2 },
  ];

  const opts = {
    title: 'FAN SPEEDS',
    height: 180,
    hooks: { setScale: [makeZoomHook('fan')] },
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { min: 0, max: 100 } },
    axes: [
      { ...AXIS_STYLE },
      { ...AXIS_STYLE, label: '%', labelFont: '10px Courier New' },
    ],
    series,
  };

  createTimeSeriesChart('fan', opts, data);
}

// ─── 3. Speed Chart ───

function renderSpeedChart(samples) {
  const container = document.getElementById('speed-chart');
  if (!container || container.style.display === 'none') return;

  const timestamps = samples.map((s) => tsToSec(s.ts));
  const speedLevel = samples.map((s) => s.speed_level ?? null);

  const data = [timestamps, speedLevel];
  const SPEED_LABELS = { 1: 'SIL', 2: 'STD', 3: 'SPT', 4: 'LUD' };

  const series = [
    {},
    {
      label: 'Speed',
      stroke: COLORS.speedLevel,
      width: 2,
      paths: uPlot.paths.stepped({ align: 1 }),
    },
  ];

  const opts = {
    title: 'SPEED LEVEL',
    height: 180,
    hooks: { setScale: [makeZoomHook('speed')] },
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { min: 0.5, max: 4.5 } },
    axes: [
      { ...AXIS_STYLE },
      {
        ...AXIS_STYLE,
        label: 'LEVEL',
        labelFont: '10px Courier New',
        values: (u, vals) => vals.map((v) => SPEED_LABELS[Math.round(v)] || ''),
        incrs: [1],
      },
    ],
    series,
  };

  createTimeSeriesChart('speed', opts, data);
}

// ─── 4. Progress Chart (Dual Y-Axis) ───

function renderProgressChart(samples) {
  const container = document.getElementById('progress-chart');
  if (!container || container.style.display === 'none') return;

  const timestamps = samples.map((s) => tsToSec(s.ts));
  const progressData = samples.map((s) => s.progress ?? null);
  const remainingData = samples.map((s) => s.remaining_min ?? null);

  const data = [timestamps, progressData, remainingData];
  const series = [
    {},
    { label: 'Progress', stroke: COLORS.progressRate, width: 2, scale: 'pct' },
    { label: 'Remaining', stroke: COLORS.remaining, width: 2, scale: 'min', dash: [4, 3] },
  ];

  const opts = {
    title: 'PROGRESS & ETA',
    height: 180,
    hooks: { setScale: [makeZoomHook('progress')] },
    cursor: { show: true, drag: { x: true, y: false } },
    scales: {
      x: { time: true },
      pct: { min: 0, max: 100 },
      min: { auto: true },
    },
    axes: [
      { ...AXIS_STYLE },
      { ...AXIS_STYLE, label: '%', labelFont: '10px Courier New', scale: 'pct' },
      {
        ...AXIS_STYLE,
        label: 'MIN',
        labelFont: '10px Courier New',
        scale: 'min',
        side: 1,
        grid: { show: false },
      },
    ],
    series,
  };

  createTimeSeriesChart('progress', opts, data);
}

// ─── 5. WiFi Chart (Area Fill) ───

function renderWifiChart(samples) {
  const container = document.getElementById('wifi-chart');
  if (!container || container.style.display === 'none') return;

  const timestamps = samples.map((s) => tsToSec(s.ts));
  const wifi = samples.map((s) => s.wifi_signal ?? null);

  const data = [timestamps, wifi];
  const series = [
    {},
    {
      label: 'WiFi',
      stroke: COLORS.wifiSignal,
      width: 2,
      fill: COLORS.wifiSignal + '22',
    },
  ];

  const opts = {
    title: 'WIFI SIGNAL',
    height: 180,
    hooks: { setScale: [makeZoomHook('wifi')] },
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { ...AXIS_STYLE },
      { ...AXIS_STYLE, label: 'dBm', labelFont: '10px Courier New' },
    ],
    series,
  };

  createTimeSeriesChart('wifi', opts, data);
}

// ─── 6. Layer Duration Chart (Bars) ───

function renderLayerChart() {
  const container = document.getElementById('layer-chart');
  if (!container || container.style.display === 'none') return;

  const layers = currentJobData?.layers;
  if (!layers || layers.length === 0) {
    container.innerHTML = '<p style="color: var(--text-dim); text-align: center; padding: 20px; text-transform: uppercase; font-size: 10px;">NO LAYER DATA</p>';
    return;
  }

  container.innerHTML = '';

  const layerNums = layers.map((l) => l.layer_num);
  const durations = layers.map((l) => l.duration_sec ?? null);

  const data = [layerNums, durations];
  const series = [
    {},
    {
      label: 'Duration',
      stroke: COLORS.layerDuration,
      width: 0,
      fill: COLORS.layerDuration + '88',
      paths: uPlot.paths.bars({ size: [0.6, 100] }),
    },
  ];

  const width = container.clientWidth || 800;
  const opts = {
    title: 'LAYER DURATION',
    width,
    height: 180,
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: false }, y: { auto: true, min: 0 } },
    axes: [
      { ...AXIS_STYLE, label: 'LAYER', labelFont: '10px Courier New' },
      { ...AXIS_STYLE, label: 'SEC', labelFont: '10px Courier New' },
    ],
    series,
  };

  // Layer chart doesn't participate in zoom sync (non-time x-axis)
  // Use manual uPlot construction since x-axis is layer_num not time
  destroyChart('layer');
  const chart = new uPlot(opts, data, container);
  const observer = new ResizeObserver(() => {
    if (!charts.layer) return;
    const newWidth = container.clientWidth;
    if (newWidth > 0 && newWidth !== chart.width) {
      chart.setSize({ width: newWidth, height: chart.height });
    }
  });
  observer.observe(container);
  charts.layer = { chart, observer };
}

// ─── 7. Efficiency Bar (HTML/CSS) ───

function renderEfficiencyBar() {
  const container = document.getElementById('efficiency-chart');
  if (!container || container.style.display === 'none') return;

  const job = currentJobData?.job;
  if (!job || !job.started_at) {
    container.innerHTML = '<p style="color: var(--text-dim); text-align: center; padding: 20px; text-transform: uppercase; font-size: 10px;">NO JOB DATA</p>';
    return;
  }

  const startMs = new Date(job.started_at.endsWith('Z') ? job.started_at : job.started_at + 'Z').getTime();
  const endMs = job.ended_at
    ? new Date(job.ended_at.endsWith('Z') ? job.ended_at : job.ended_at + 'Z').getTime()
    : Date.now();

  const totalSec = (endMs - startMs) / 1000;
  const pauseSec = job.total_pause_sec || 0;
  const activeSec = Math.max(0, totalSec - pauseSec);

  const activePct = totalSec > 0 ? (activeSec / totalSec) * 100 : 100;
  const pausePct = totalSec > 0 ? (pauseSec / totalSec) * 100 : 0;

  function formatDur(sec) {
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  container.innerHTML = `
    <div class="efficiency-bar">
      <div class="efficiency-label">Print Efficiency</div>
      <div class="efficiency-track">
        <div class="efficiency-fill-active" style="width:${activePct.toFixed(1)}%"></div>
        <div class="efficiency-fill-pause" style="width:${pausePct.toFixed(1)}%"></div>
      </div>
      <div class="efficiency-legend">
        <span style="color:${COLORS.activeTime}">&#9632; Active ${formatDur(activeSec)} (${activePct.toFixed(0)}%)</span>
        <span style="color:${COLORS.pauseTime}">&#9632; Paused ${formatDur(pauseSec)} (${pausePct.toFixed(0)}%)</span>
      </div>
    </div>
  `;
}

// ─── Init & Destroy ───

export function initCharts() {
  destroyAllCharts();
  initToggles();
}

export function destroyCharts() {
  destroyAllCharts();
}

// ─── Data Loading ───

export async function loadChartData(deviceId, range, filters) {
  currentDeviceId = deviceId;
  currentRange = range;
  currentFilters = filters;
  liveBuffer = [];

  let from;
  if (range === 'custom' && filters?.from) {
    from = filters.from;
  } else {
    from = rangeToIso(range);
  }

  try {
    const toParam = (range === 'custom' && filters?.to) ? `&to=${encodeURIComponent(filters.to)}` : '';
    const fromParam = encodeURIComponent(from);
    const [samplesRes, eventsRes] = await Promise.all([
      fetch(`/api/printers/${deviceId}/history?from=${fromParam}&limit=10000${toParam}`),
      fetch(`/api/printers/${deviceId}/events?from=${fromParam}&limit=500${toParam}`),
    ]);

    const samples = await samplesRes.json();
    let events = await eventsRes.json();

    if (filters) {
      if (filters.type) events = events.filter((e) => e.event_type === filters.type);
      if (filters.severity) events = events.filter((e) => e.severity === filters.severity);
    }

    currentSamples = samples;
    currentEvents = events;

    if (samples.length === 0) {
      document.getElementById('temp-chart').innerHTML =
        '<p style="color: var(--text-dim); text-align: center; padding: 40px; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">NO DATA FOR THIS RANGE</p>';
      return;
    }

    renderAllCharts();

    // Fetch job-related data for layer/efficiency/anomaly overlays
    fetchJobData(deviceId);
  } catch {
    document.getElementById('temp-chart').innerHTML =
      '<p style="color: var(--text-dim); text-align: center; padding: 40px; text-transform: uppercase; font-size: 11px;">FAILED TO LOAD DATA</p>';
  }
}

async function fetchJobData(deviceId) {
  try {
    const jobsRes = await fetch(`/api/printers/${deviceId}/jobs?limit=1`);
    const jobs = await jobsRes.json();
    if (!jobs.length) {
      currentJobData = null;
      return;
    }

    const job = jobs[0];
    const jobId = job.id;

    const [layersRes, anomaliesRes, pausesRes] = await Promise.all([
      fetch(`/api/printers/${deviceId}/jobs/${jobId}/layers`),
      fetch(`/api/printers/${deviceId}/jobs/${jobId}/anomalies`),
      fetch(`/api/printers/${deviceId}/jobs/${jobId}/pauses`),
    ]);

    const layers = await layersRes.json();
    const anomalies = await anomaliesRes.json();
    const pauses = await pausesRes.json();

    currentJobData = { job, layers, anomalies, pauses };
    anomalyOverlayData = { anomalies, pauses };

    // Re-render anomaly-dependent charts
    if (chartVisibility.layer) renderLayerChart();
    if (chartVisibility.efficiency) renderEfficiencyBar();
    // Redraw temp chart to show anomaly overlays
    if (charts.temp) charts.temp.chart.redraw(false, false);
  } catch { /* ignore — overlays just won't show */ }
}

// ─── Live Push ───

export function pushLivePoint(deviceId, state) {
  if (deviceId !== currentDeviceId) return;

  const nowSec = Date.now() / 1000;
  const cutoff = currentRange === 'custom' ? 0 : nowSec - rangeSec(currentRange);

  // Update cached samples with a pseudo-sample for toggle rendering
  if (currentSamples) {
    currentSamples.push({
      ts: new Date().toISOString(),
      nozzle_temp: state.nozzleTemp,
      nozzle_target: state.nozzleTarget,
      nozzle2_temp: state.nozzle2Temp ?? null,
      nozzle2_target: state.nozzle2Target ?? null,
      bed_temp: state.bedTemp,
      bed_target: state.bedTarget,
      chamber_temp: state.chamberTemp,
      part_fan_speed: state.partFanSpeed,
      aux_fan_speed: state.auxFanSpeed,
      chamber_fan_speed: state.chamberFanSpeed,
      speed_level: state.speedLevel,
      progress: state.progress,
      remaining_min: state.remainingMin,
      wifi_signal: state.wifiSignal,
    });
  }

  // Temp chart
  if (charts.temp) {
    const chart = charts.temp.chart;
    const isDual = chart._isDual;

    chart.data[0].push(nowSec);
    if (isDual) {
      chart.data[1].push(state.nozzleTemp);
      chart.data[2].push(state.nozzleTarget);
      chart.data[3].push(state.nozzle2Temp ?? null);
      chart.data[4].push(state.nozzle2Target ?? null);
      chart.data[5].push(state.bedTemp);
      chart.data[6].push(state.bedTarget);
      chart.data[7].push(state.chamberTemp);
    } else {
      chart.data[1].push(state.nozzleTemp);
      chart.data[2].push(state.nozzleTarget);
      chart.data[3].push(state.bedTemp);
      chart.data[4].push(state.bedTarget);
      chart.data[5].push(state.chamberTemp);
    }

    if (cutoff > 0) {
      while (chart.data[0].length > 1 && chart.data[0][0] < cutoff) {
        for (const arr of chart.data) arr.shift();
      }
    }
    updateChartData(chart, chart.data);
  }

  // Fan chart
  if (charts.fan) {
    pushToChart('fan', nowSec, cutoff, [
      state.partFanSpeed ?? null,
      state.auxFanSpeed ?? null,
      state.chamberFanSpeed ?? null,
    ]);
  }

  // Speed chart
  if (charts.speed) {
    pushToChart('speed', nowSec, cutoff, [state.speedLevel ?? null]);
  }

  // Progress chart
  if (charts.progress) {
    pushToChart('progress', nowSec, cutoff, [
      state.progress ?? null,
      state.remainingMin ?? null,
    ]);
  }

  // WiFi chart
  if (charts.wifi) {
    pushToChart('wifi', nowSec, cutoff, [state.wifiSignal ?? null]);
  }
}

// ─── Utilities ───

function rangeToIso(range) {
  const now = new Date();
  return new Date(now.getTime() - rangeSec(range) * 1000).toISOString();
}

export function highlightEvent(ts) {
  highlightedEventTs = ts;
  if (charts.temp) charts.temp.chart.redraw(false, false);
}

function rangeSec(range) {
  const map = {
    '5m': 300,
    '10m': 600,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '6h': 6 * 3600,
    '24h': 24 * 3600,
    '7d': 7 * 24 * 3600,
  };
  return map[range] || map['24h'];
}
