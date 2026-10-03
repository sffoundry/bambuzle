// Audit view (BAM-41) — operator audit trail: who did what, when, from where, with what result.
// Builds its own DOM inside #view-audit (createElement + textContent only, no innerHTML with data).
// Colours come from theme CSS variables via existing / audit-* classes in style.css.

const RANGES = [['1d', '24 hours', 1], ['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['365d', '1 year', 365]];
const CATEGORIES = [
  ['', 'All actions'],
  ['session', 'Dashboard sign-in'],
  ['access', 'Access denied'],
  ['cloud', 'BambuLab Cloud'],
  ['printer.command', 'Printer commands'],
  ['printer', 'All printer actions'],
  ['alert', 'Alert rules'],
  ['maintenance', 'Maintenance'],
  ['system', 'System / backup'],
];
const RESULTS = [['', 'All results'], ['ok', 'ok'], ['denied', 'denied'], ['rejected', 'rejected'], ['error', 'error']];
const RESULT_CLASS = { ok: 'stats-good', rejected: 'stats-warn', denied: 'stats-bad', error: 'stats-bad' };
const LIMIT = 500;

const ui = { range: '7d', action: '', result: '', built: false, loadSeq: 0 };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function select(id, label, options, value, onChange) {
  const sel = el('select');
  sel.id = id;
  sel.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const opt = el('option', null, text);
    opt.value = v;
    sel.append(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function buildQuery() {
  const days = RANGES.find(([key]) => key === ui.range)?.[2] ?? 7;
  const params = new URLSearchParams({ from: new Date(Date.now() - days * 86400e3).toISOString() });
  if (ui.action) params.set('action', ui.action);
  if (ui.result) params.set('result', ui.result);
  return params;
}

function updateCsvLink() {
  const a = document.getElementById('audit-csv');
  if (!a) return;
  const params = buildQuery();
  params.set('format', 'csv');
  a.href = `/api/audit/export?${params}`;
}

function setStatus(msg) {
  const s = document.getElementById('audit-status');
  if (s) s.textContent = msg || '';
}

function build() {
  const root = document.getElementById('view-audit');
  if (!root) return false;
  const header = el('div', 'stats-header');
  const filters = el('div', 'event-filters stats-filters');
  const reload = () => { updateCsvLink(); load(); };
  filters.append(
    select('audit-filter-range', 'Time range', RANGES.map(([k, label]) => [k, label]), ui.range, (v) => { ui.range = v; reload(); }),
    select('audit-filter-action', 'Action', CATEGORIES, ui.action, (v) => { ui.action = v; reload(); }),
    select('audit-filter-result', 'Result', RESULTS, ui.result, (v) => { ui.result = v; reload(); }),
  );
  const status = el('span', 'stats-status');
  status.id = 'audit-status';
  const csv = el('a', 'stats-range-btn stats-export-btn', 'Download CSV');
  csv.id = 'audit-csv';
  csv.title = 'Download the audit entries matching these filters as CSV (UTC timestamps)';
  csv.setAttribute('download', '');
  // Refresh at click time so "last 7 days" ends now, not when the view was opened
  csv.addEventListener('click', updateCsvLink);
  const exportWrap = el('div', 'stats-export');
  exportWrap.append(csv);
  filters.append(status, exportWrap);
  header.append(el('h2', null, 'Audit Trail'), filters);

  const note = el('p', 'audit-note', 'Who changed what: sign-ins, access denials, cloud login, connection settings, printer commands, alert rules, maintenance and backups. Secrets (access codes, passwords, tokens, notifier settings) are never recorded.');

  const wrap = el('div', 'stats-table-wrap audit-table-wrap');
  const table = el('table', 'data-table audit-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Time', 'Actor', 'Source', 'Action', 'Target', 'Result', 'Detail']) hr.append(el('th', null, h));
  thead.append(hr);
  const tbody = el('tbody');
  tbody.id = 'audit-body';
  table.append(thead, tbody);
  wrap.append(table);

  root.replaceChildren(header, note, wrap);
  updateCsvLink();
  return true;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** Flatten a detail object into "key: value" text (values JSON-encoded when not scalar). */
function fmtDetail(detail) {
  if (detail == null) return '';
  if (typeof detail !== 'object') return String(detail);
  return Object.entries(detail).map(([k, v]) => {
    let val = v;
    if (v && typeof v === 'object') {
      val = 'from' in v && 'to' in v ? `${v.from ?? '—'} → ${v.to ?? '—'}` : JSON.stringify(v);
    }
    return `${k}: ${val}`;
  }).join(', ');
}

function renderRows(entries) {
  const tbody = document.getElementById('audit-body');
  if (!tbody) return;
  if (!entries.length) {
    const tr = el('tr');
    const td = el('td', 'stats-empty', 'No audit entries match these filters');
    td.colSpan = 7;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(...entries.map((e) => {
    const tr = el('tr');
    const source = el('td', 'audit-source', e.source_ip || '—');
    if (e.user_agent) source.title = e.user_agent;
    tr.append(
      el('td', 'audit-time', fmtTime(e.ts)),
      el('td', null, e.actor),
      source,
      el('td', 'audit-action', e.action),
      el('td', 'audit-target', e.target || ''),
      el('td', RESULT_CLASS[e.result] || '', e.result),
      el('td', 'audit-detail', fmtDetail(e.detail)),
    );
    return tr;
  }));
}

async function load() {
  const seq = ++ui.loadSeq;
  setStatus('Loading…');
  try {
    const params = buildQuery();
    params.set('limit', String(LIMIT));
    const res = await fetch(`/api/audit?${params}`);
    const data = await res.json().catch(() => null);
    if (seq !== ui.loadSeq) return; // a newer filter change won
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    renderRows(data.entries || []);
    setStatus(data.truncated ? `Newest ${data.entries.length} shown — narrow the filters or download CSV` : `${data.entries.length} entries`);
  } catch (err) {
    if (seq !== ui.loadSeq) return;
    renderRows([]);
    setStatus(`Failed to load: ${err.message}`);
  }
}

export function initAuditUI() {
  if (!ui.built) ui.built = build();
  if (ui.built) load();
}
