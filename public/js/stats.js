// Stats view (BAM-10) — print job totals, success rates, by printer / material / day.
// All DOM is built with createElement + textContent; no innerHTML with data.

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, all: null };
const MAX_GAP_FILL_DAYS = 366;

const ui = { range: '30d', printer: '', wired: false, loadSeq: 0 };

/** Create an element with an optional class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function fmtPct(rate) {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function fmtHours(h) {
  return h == null ? '—' : h.toFixed(1);
}

function fmtMinutes(min) {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function buildQuery() {
  const params = new URLSearchParams();
  const days = RANGE_DAYS[ui.range];
  if (days == null) {
    params.set('from', '1970-01-01');
  } else {
    params.set('from', new Date(Date.now() - days * 86400e3).toISOString());
  }
  if (ui.printer) params.set('printer', ui.printer);
  return params.toString();
}

/** Query for /api/export/jobs (BAM-46): same printer/range as the view; "All" = no lower bound. */
function buildExportQuery(format) {
  const params = new URLSearchParams({ format });
  const days = RANGE_DAYS[ui.range];
  if (days != null) params.set('from', new Date(Date.now() - days * 86400e3).toISOString());
  if (ui.printer) params.set('printer', ui.printer);
  return params.toString();
}

/** Add the Export CSV / JSON links once (plain same-origin links: the session cookie is sent). */
function ensureExportLinks() {
  if (document.getElementById('stats-export')) return;
  const host = document.querySelector('#view-stats .stats-filters');
  if (!host) return;
  const wrap = el('div', 'stats-export');
  wrap.id = 'stats-export';
  for (const [format, label] of [['csv', 'Export CSV'], ['json', 'Export JSON']]) {
    const a = el('a', 'stats-range-btn stats-export-btn', label);
    a.dataset.format = format;
    a.title = `Download the jobs in this range as ${format.toUpperCase()} (UTC timestamps)`;
    a.setAttribute('download', '');
    // Refresh the href at click time so a relative range ("last 7 days") ends now, not at last load.
    a.addEventListener('click', updateExportLinks);
    wrap.append(a);
  }
  host.append(wrap);
}

/** Point the export links at the current printer/range selection. */
function updateExportLinks() {
  document.querySelectorAll('#stats-export .stats-export-btn').forEach((a) => {
    a.href = `/api/export/jobs?${buildExportQuery(a.dataset.format)}`;
  });
}

function populatePrinterSelect(state) {
  const sel = document.getElementById('stats-filter-printer');
  if (!sel) return;
  const current = ui.printer;
  sel.replaceChildren(el('option', null, 'All Printers'));
  sel.firstChild.value = '';
  const entries = Object.entries(state.printers || {})
    .map(([id, p]) => [id, p?.db?.name || id])
    .sort((a, b) => a[1].localeCompare(b[1]));
  for (const [id, name] of entries) {
    const opt = el('option', null, name);
    opt.value = id;
    sel.append(opt);
  }
  sel.value = entries.some(([id]) => id === current) ? current : '';
  ui.printer = sel.value;
}

// ─── Rendering ───

function renderTiles(overall) {
  const wrap = document.getElementById('stats-tiles');
  const tiles = [
    ['Jobs', overall.jobs, overall.running ? `${overall.running} running` : `${overall.finished} finished`],
    ['Success Rate', fmtPct(overall.successRate), `${overall.finished} ok / ${overall.failed} failed / ${overall.cancelled} cancelled`],
    ['Print Hours', fmtHours(overall.totalPrintHours), 'wall-clock, incl. pauses'],
    ['Avg Duration', fmtMinutes(overall.avgDurationMin), 'ended jobs'],
  ];
  wrap.replaceChildren(...tiles.map(([label, value, sub]) => {
    const tile = el('div', 'stats-tile');
    tile.append(el('div', 'stats-tile-label', label), el('div', 'stats-tile-value', value), el('div', 'stats-tile-sub', sub));
    return tile;
  }));
}

function rateClass(rate) {
  if (rate == null) return '';
  if (rate >= 0.9) return 'stats-good';
  if (rate >= 0.7) return 'stats-warn';
  return 'stats-bad';
}

/** Render a counters table. `firstCol` = [header, accessor]. */
function renderTable(tbodyId, rows, firstCol) {
  const tbody = document.getElementById(tbodyId);
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'stats-empty', 'No jobs in this range');
    td.colSpan = 8;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(...rows.map((r) => {
    const tr = el('tr');
    tr.append(
      el('td', null, firstCol(r)),
      el('td', null, r.jobs),
      el('td', 'stats-finished', r.finished),
      el('td', 'stats-failed', r.failed),
      el('td', 'stats-cancelled', r.cancelled),
      el('td', rateClass(r.successRate), fmtPct(r.successRate)),
      el('td', null, fmtHours(r.totalPrintHours)),
      el('td', null, fmtMinutes(r.avgDurationMin)),
    );
    return tr;
  }));
}

/** Fill gaps between the window start and today so empty days show as empty columns. */
function fillDays(byDay) {
  const days = RANGE_DAYS[ui.range];
  const map = new Map(byDay.map((d) => [d.date, d]));
  let start;
  if (days != null) {
    start = new Date(Date.now() - days * 86400e3);
  } else if (byDay.length) {
    start = new Date(`${byDay[0].date}T00:00:00Z`);
  } else {
    return [];
  }
  start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const end = new Date();
  const out = [];
  for (let d = start; d <= end && out.length < MAX_GAP_FILL_DAYS; d = new Date(d.getTime() + 86400e3)) {
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) || { date: key, finished: 0, failed: 0, cancelled: 0 });
  }
  // Very long "all" ranges: fall back to only the days that had jobs.
  return out.length >= MAX_GAP_FILL_DAYS ? byDay : out;
}

function renderDays(byDay) {
  const chart = document.getElementById('stats-days');
  const days = fillDays(byDay);
  if (!days.length) {
    chart.replaceChildren(el('div', 'stats-empty', 'No jobs in this range'));
    return;
  }
  const max = Math.max(1, ...days.map((d) => d.finished + d.failed + d.cancelled));
  const bars = el('div', 'stats-bars');
  for (const d of days) {
    const total = d.finished + d.failed + d.cancelled;
    const col = el('div', 'stats-bar');
    col.title = `${d.date}: ${d.finished} finished, ${d.failed} failed, ${d.cancelled} cancelled`;
    const stack = el('div', 'stats-bar-stack');
    stack.style.height = `${(total / max) * 100}%`;
    for (const [key, cls] of [['cancelled', 'seg-cancelled'], ['failed', 'seg-failed'], ['finished', 'seg-finished']]) {
      if (!d[key]) continue;
      const seg = el('div', `stats-seg ${cls}`);
      seg.style.flexGrow = String(d[key]);
      stack.append(seg);
    }
    col.append(stack);
    bars.append(col);
  }
  const axis = el('div', 'stats-axis');
  axis.append(el('span', null, days[0].date), el('span', null, `max ${max}/day`), el('span', null, days[days.length - 1].date));
  chart.replaceChildren(bars, axis);
}

function render(data) {
  renderTiles(data.overall);
  renderTable('stats-printer-body', data.byPrinter, (r) => r.name || r.deviceId);
  renderTable('stats-material-body', data.byMaterial, (r) => r.material);
  renderDays(data.byDay);
}

async function loadStats() {
  const status = document.getElementById('stats-status');
  const seq = ++ui.loadSeq;
  status.textContent = 'Loading…';
  updateExportLinks();
  try {
    const res = await fetch(`/api/stats?${buildQuery()}`);
    const data = await res.json();
    if (seq !== ui.loadSeq) return; // a newer request superseded this one
    if (!res.ok) {
      status.textContent = `Error: ${data.error || res.status}`;
      return;
    }
    render(data);
    status.textContent = `${data.window.from.slice(0, 10)} → ${data.window.to.slice(0, 10)} (UTC)`;
  } catch {
    if (seq === ui.loadSeq) status.textContent = 'Failed to load stats';
  }
}

/** Called when the Stats tab is opened. `state` is app.js's shared state (for the printer list). */
export function initStatsUI(state) {
  if (!ui.wired) {
    ui.wired = true;
    // Default to the dashboard's selected printer, if a specific one is chosen.
    const dashSel = document.getElementById('dash-filter-printer');
    if (dashSel && dashSel.value && dashSel.value !== '__all__') ui.printer = dashSel.value;

    document.getElementById('stats-filter-printer').addEventListener('change', (e) => {
      ui.printer = e.target.value;
      loadStats();
    });
    document.querySelectorAll('#stats-range .stats-range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!(btn.dataset.range in RANGE_DAYS)) return;
        ui.range = btn.dataset.range;
        document.querySelectorAll('#stats-range .stats-range-btn').forEach((b) => b.classList.toggle('active', b === btn));
        loadStats();
      });
    });
  }
  ensureExportLinks();
  populatePrinterSelect(state);
  loadStats();
}
