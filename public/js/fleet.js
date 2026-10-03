// Compact fleet view (BAM-45): one dense, read-only row per printer — an alternative to the cards when
// watching several printers. No control buttons (those stay on the cards, where state is visible).
// Choice persists per browser. DOM via textContent only.

const STORAGE_KEY = 'bambuzle_dash_layout';

function read() {
  try { return localStorage.getItem(STORAGE_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
}
let layout = read();
let renderTimer = null;

export function getLayout() {
  return layout;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtTemp(t, target) {
  if (t == null) return '—';
  return target > 0 ? `${Math.round(t)}/${Math.round(target)}°` : `${Math.round(t)}°`;
}

function fmtRemaining(min) {
  if (min == null || min < 0) return '—';
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

/** Render (or refresh) the fleet table. `printers` is app.js state.printers. */
export function renderFleet(printers) {
  const wrap = document.getElementById('fleet-table');
  if (!wrap || layout !== 'table') return;
  const table = el('table', 'data-table fleet');
  const head = el('tr');
  for (const h of ['Printer', 'State', 'Job', 'Progress', 'Left', 'Nozzle', 'Bed', 'Via', 'Alerts']) head.append(el('th', null, h));
  const thead = el('thead');
  thead.append(head); // append() returns undefined — don't chain
  table.append(thead);
  const tbody = el('tbody');
  const entries = Object.entries(printers).sort(([, a], [, b]) => String(a.db?.name || '').localeCompare(String(b.db?.name || '')));
  for (const [id, p] of entries) {
    const live = p.live || {};
    const state = p.connected ? (live.gcodeState || 'UNKNOWN') : 'OFFLINE';
    const tr = el('tr', `fleet-row fleet-${state.toLowerCase()}`);
    tr.append(el('td', 'fleet-name', p.db?.name || id));
    const st = el('td');
    st.append(el('span', `state-badge ${state.toLowerCase()}`, state));
    tr.append(st);
    tr.append(el('td', 'fleet-job', live.subtaskName || live.gcodeFile || ''));
    const prog = el('td', 'fleet-progress');
    if (live.progress != null && ['RUNNING', 'PAUSE', 'PREPARE'].includes(state)) {
      const bar = el('div', 'fleet-bar');
      const fill = el('div', 'fleet-bar-fill');
      fill.style.width = `${Math.max(0, Math.min(100, live.progress))}%`;
      bar.append(fill);
      prog.append(bar, el('span', 'fleet-pct', `${live.progress}%`));
    } else {
      prog.textContent = '—';
    }
    tr.append(prog);
    tr.append(el('td', null, ['RUNNING', 'PAUSE', 'PREPARE'].includes(state) ? fmtRemaining(live.remainingMin) : '—'));
    const nozzle = live.nozzle2Temp != null
      ? `${fmtTemp(live.nozzleTemp, live.nozzleTarget)} · ${fmtTemp(live.nozzle2Temp, live.nozzle2Target)}`
      : fmtTemp(live.nozzleTemp, live.nozzleTarget);
    tr.append(el('td', null, nozzle));
    tr.append(el('td', null, fmtTemp(live.bedTemp, live.bedTarget)));
    const via = p.capabilities?.transport;
    tr.append(el('td', null, via === 'lan' ? 'LAN' : via === 'cloud' ? 'Cloud' : '—'));
    const alerts = [];
    if (live.hmsErrors?.length) alerts.push(`${live.hmsErrors.length} HMS`);
    if (live.diagnostics?.printError?.active) alerts.push(`ERR ${live.diagnostics.printError.hex}`);
    const hum = (live.diagnostics?.amsHumidity || []).map((u) => u.percent).filter((v) => v != null);
    if (hum.length && Math.max(...hum) >= 40) alerts.push(`AMS ${Math.max(...hum)}% RH`);
    tr.append(el('td', alerts.length ? 'fleet-alerts' : null, alerts.join(' · ') || '—'));
    tbody.append(tr);
  }
  table.append(tbody);
  const scroll = el('div', 'table-scroll');
  scroll.append(table);
  wrap.replaceChildren(scroll);
}

/** Throttled refresh for live updates (many MQTT messages per second across printers). */
export function scheduleFleetRender(printers) {
  if (layout !== 'table' || renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderFleet(printers); }, 1000);
}

/** Show cards or table; wires the toggle buttons once. */
export function initFleetToggle(getPrinters) {
  const cards = document.getElementById('printer-cards');
  const wrap = document.getElementById('fleet-table');
  const apply = () => {
    cards.classList.toggle('hidden', layout === 'table');
    wrap.classList.toggle('hidden', layout !== 'table');
    for (const b of document.querySelectorAll('[data-layout]')) b.classList.toggle('active', b.dataset.layout === layout);
    renderFleet(getPrinters());
  };
  for (const b of document.querySelectorAll('[data-layout]')) {
    b.addEventListener('click', () => {
      layout = b.dataset.layout;
      try { localStorage.setItem(STORAGE_KEY, layout); } catch { /* per-page only */ }
      apply();
    });
  }
  apply();
}
