let tempChart = null;
let progressChart = null;
let currentDeviceId = null;
let currentRange = '24h';

// Live data buffers — appended from WebSocket, merged with DB data on load
let liveBuffer = []; // { ts, nozzle_temp, nozzle_target, bed_temp, bed_target, chamber_temp, progress, layer_num }

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
};

// Event overlay plugin
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
        }
      }],
    },
  };
}

export function initCharts() {
  destroyCharts();
}

export function destroyCharts() {
  if (tempChart) { tempChart.destroy(); tempChart = null; }
  if (progressChart) { progressChart.destroy(); progressChart = null; }
  document.getElementById('temp-chart').innerHTML = '';
  document.getElementById('progress-chart').innerHTML = '';
  currentDeviceId = null;
  liveBuffer = [];
}

export async function loadChartData(deviceId, range) {
  currentDeviceId = deviceId;
  currentRange = range;
  liveBuffer = [];

  const from = rangeToIso(range);

  try {
    const [samplesRes, eventsRes] = await Promise.all([
      fetch(`/api/printers/${deviceId}/history?from=${from}&limit=10000`),
      fetch(`/api/printers/${deviceId}/events?from=${from}&limit=500`),
    ]);

    const samples = await samplesRes.json();
    const events = await eventsRes.json();

    if (samples.length === 0) {
      document.getElementById('temp-chart').innerHTML =
        '<p style="color: var(--text-dim); text-align: center; padding: 40px; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">NO DATA FOR THIS RANGE</p>';
      document.getElementById('progress-chart').innerHTML = '';
      return;
    }

    renderTempChart(samples, events);
    renderProgressChart(samples, events);
  } catch {
    document.getElementById('temp-chart').innerHTML =
      '<p style="color: var(--text-dim); text-align: center; padding: 40px; text-transform: uppercase; font-size: 11px;">FAILED TO LOAD DATA</p>';
  }
}

/**
 * Push a live state update into the charts (called from app.js on each WS state message).
 */
export function pushLivePoint(deviceId, state) {
  if (deviceId !== currentDeviceId || !tempChart) return;

  const nowSec = Date.now() / 1000;
  const isDual = tempChart._isDual;

  // Append to temp chart
  tempChart.data[0].push(nowSec);
  if (isDual) {
    tempChart.data[1].push(state.nozzleTemp);
    tempChart.data[2].push(state.nozzleTarget);
    tempChart.data[3].push(state.nozzle2Temp ?? null);
    tempChart.data[4].push(state.nozzle2Target ?? null);
    tempChart.data[5].push(state.bedTemp);
    tempChart.data[6].push(state.bedTarget);
    tempChart.data[7].push(state.chamberTemp);
  } else {
    tempChart.data[1].push(state.nozzleTemp);
    tempChart.data[2].push(state.nozzleTarget);
    tempChart.data[3].push(state.bedTemp);
    tempChart.data[4].push(state.bedTarget);
    tempChart.data[5].push(state.chamberTemp);
  }

  // Trim old points outside current range window
  const cutoff = nowSec - rangeSec(currentRange);
  while (tempChart.data[0].length > 1 && tempChart.data[0][0] < cutoff) {
    for (const arr of tempChart.data) arr.shift();
  }

  tempChart.setData(tempChart.data);

  // Append to progress chart
  if (progressChart) {
    progressChart.data[0].push(nowSec);
    progressChart.data[1].push(state.progress);
    progressChart.data[2].push(state.layerNum);

    while (progressChart.data[0].length > 1 && progressChart.data[0][0] < cutoff) {
      for (const arr of progressChart.data) arr.shift();
    }

    progressChart.setData(progressChart.data);
  }
}

function renderTempChart(samples, events) {
  document.getElementById('temp-chart').innerHTML = '';

  const timestamps = samples.map((s) => new Date(s.ts.endsWith('Z') ? s.ts : s.ts + 'Z').getTime() / 1000);
  const nozzleTemp = samples.map((s) => s.nozzle_temp);
  const nozzleTarget = samples.map((s) => s.nozzle_target);
  const bedTemp = samples.map((s) => s.bed_temp);
  const bedTarget = samples.map((s) => s.bed_target);
  const chamberTemp = samples.map((s) => s.chamber_temp);

  // Detect if any sample has nozzle2 data
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

  const container = document.getElementById('temp-chart');
  const width = container.clientWidth || 800;

  const opts = {
    title: 'TEMPERATURE',
    width,
    height: 240,
    plugins: [eventsPlugin(events)],
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { stroke: '#338855', grid: { stroke: '#1a4a2a44' }, font: '10px Courier New', ticks: { stroke: '#1a4a2a' } },
      { stroke: '#338855', grid: { stroke: '#1a4a2a44' }, label: 'DEG C', font: '10px Courier New', labelFont: '10px Courier New', ticks: { stroke: '#1a4a2a' } },
    ],
    series,
  };

  tempChart = new uPlot(opts, data, container);
  tempChart._isDual = isDual;
}

function renderProgressChart(samples, events) {
  document.getElementById('progress-chart').innerHTML = '';

  const timestamps = samples.map((s) => new Date(s.ts.endsWith('Z') ? s.ts : s.ts + 'Z').getTime() / 1000);
  const progress = samples.map((s) => s.progress);
  const layerNum = samples.map((s) => s.layer_num);

  const data = [timestamps, progress, layerNum];

  const container = document.getElementById('progress-chart');
  const width = container.clientWidth || 800;

  const opts = {
    title: 'PROGRESS',
    width,
    height: 180,
    plugins: [eventsPlugin(events)],
    cursor: { show: true, drag: { x: true, y: false } },
    scales: {
      x: { time: true },
      y: { auto: true, range: [0, 100] },
      layer: { auto: true },
    },
    axes: [
      { stroke: '#338855', grid: { stroke: '#1a4a2a44' }, font: '10px Courier New', ticks: { stroke: '#1a4a2a' } },
      { stroke: '#338855', grid: { stroke: '#1a4a2a44' }, label: 'PCT', font: '10px Courier New', labelFont: '10px Courier New', ticks: { stroke: '#1a4a2a' } },
      { side: 1, stroke: '#338855', grid: { show: false }, label: 'LAYER', scale: 'layer', font: '10px Courier New', labelFont: '10px Courier New', ticks: { stroke: '#1a4a2a' } },
    ],
    series: [
      {},
      { label: 'Progress', stroke: COLORS.progress, width: 2, scale: 'y' },
      { label: 'Layer', stroke: COLORS.layer, width: 1, scale: 'layer' },
    ],
  };

  progressChart = new uPlot(opts, data, container);
}

function rangeToIso(range) {
  const now = new Date();
  return new Date(now.getTime() - rangeSec(range) * 1000).toISOString();
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
