// Maintenance view (BAM-39) — per-printer service tasks, print hours since service, repeat errors.
// All DOM is built with createElement + textContent; no innerHTML with data.

const WIKI_PREFIX = 'https://wiki.bambulab.com/';
const STATUS_LABEL = { ok: 'OK', due_soon: 'Due soon', due: 'Due', unscheduled: 'No interval' };

const ui = { printer: '', wired: false, loadSeq: 0, editingId: null, editingLastDone: '', data: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, className, onClick, title) {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → local display string. */
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(`${String(ts).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function fmtNum(n, digits = 1) {
  return n == null ? '—' : Number(n).toFixed(digits);
}

function fmtInterval(t) {
  const parts = [];
  if (t.intervalHours != null) parts.push(`${t.intervalHours} h`);
  if (t.intervalDays != null) parts.push(`${t.intervalDays} d`);
  return parts.length ? parts.join(' / ') : 'not set';
}

function fmtSince(t) {
  const parts = [`${fmtNum(t.hoursSince)} h`, `${fmtNum(t.daysSince)} d`];
  return parts.join(' / ');
}

function setStatus(msg) {
  const s = document.getElementById('maint-status');
  if (s) s.textContent = msg || '';
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ─── Printer selector ───

async function loadSummary() {
  const sel = document.getElementById('maint-filter-printer');
  const summary = await api('GET', '/api/maintenance');
  const current = ui.printer;
  const opts = summary.map((p) => {
    const flags = [];
    if (p.due) flags.push(`${p.due} due`);
    if (p.dueSoon) flags.push(`${p.dueSoon} soon`);
    const opt = el('option', null, flags.length ? `${p.name} (${flags.join(', ')})` : p.name);
    opt.value = p.deviceId;
    return opt;
  });
  if (!opts.length) {
    const none = el('option', null, 'No printers');
    none.value = '';
    sel.replaceChildren(none);
    ui.printer = '';
    return;
  }
  sel.replaceChildren(...opts);
  sel.value = summary.some((p) => p.deviceId === current) ? current : summary[0].deviceId;
  ui.printer = sel.value;
}

// ─── Rendering ───

function renderTiles(d) {
  const wrap = document.getElementById('maint-tiles');
  const tiles = [
    ['Print Hours', fmtNum(d.totalPrintHours), d.firstJobAt ? `since ${fmtTs(d.firstJobAt)}` : 'no jobs recorded'],
    ['Due', d.counts.due, 'tasks overdue'],
    ['Due Soon', d.counts.dueSoon, '≥ 90% of interval'],
    ['Tasks', d.counts.tasks, d.counts.unscheduled ? `${d.counts.unscheduled} without interval` : 'tracked'],
  ];
  wrap.replaceChildren(...tiles.map(([label, value, sub]) => {
    const tile = el('div', 'stats-tile');
    tile.append(el('div', 'stats-tile-label', label), el('div', 'stats-tile-value', value), el('div', 'stats-tile-sub', sub));
    return tile;
  }));
}

function statusBadge(status) {
  return el('span', `maint-badge maint-${status}`, STATUS_LABEL[status] || status);
}

function doneForm(task, actionsCell, restore) {
  const form = el('form', 'maint-done-form');
  const note = el('input');
  note.type = 'text';
  note.maxLength = 500;
  note.placeholder = 'Note (optional)';
  const save = el('button', 'btn-primary btn-sm', 'Save');
  save.type = 'submit';
  form.append(note, save, button('Cancel', 'btn-secondary btn-sm', restore));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api('POST', `/api/maintenance/tasks/${task.id}/done`, { note: note.value });
      setStatus(`Marked "${task.name}" done`);
      await refresh();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      save.disabled = false;
    }
  });
  actionsCell.replaceChildren(form);
  note.focus();
}

function taskActions(task, cell) {
  const restore = () => taskActions(task, cell);
  cell.replaceChildren(
    button('Mark done', 'btn-primary btn-sm', () => doneForm(task, cell, restore)),
    button('Edit', 'btn-secondary btn-sm', () => startEdit(task)),
    button('Delete', 'btn-danger', async () => {
      if (!confirm(`Delete "${task.name}" and its history?`)) return;
      try {
        await api('DELETE', `/api/maintenance/tasks/${task.id}`);
        if (ui.editingId === task.id) resetForm();
        await refresh();
      } catch (err) {
        setStatus(`Error: ${err.message}`);
      }
    }),
  );
}

function renderTasks(d) {
  const tbody = document.getElementById('maint-tasks-body');
  const empty = document.getElementById('maint-empty');
  if (!d.tasks.length) {
    tbody.replaceChildren();
    const list = el('ul', 'maint-template-list');
    for (const t of d.templates) {
      const iv = t.intervalDays != null ? `every ${t.intervalDays} d` : t.intervalHours != null ? `every ${t.intervalHours} h` : 'set your own interval';
      list.append(el('li', null, `${t.name} — ${iv}`));
    }
    const add = button('Add recommended tasks', 'btn-primary', async () => {
      add.disabled = true;
      try {
        const r = await api('POST', `/api/maintenance/${encodeURIComponent(ui.printer)}/templates`);
        setStatus(`Added ${r.added} task(s)`);
        await refresh();
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        add.disabled = false;
      }
    });
    empty.replaceChildren(
      el('p', 'stats-empty', 'No maintenance tasks for this printer yet. Recommended set (intervals from the Bambu Lab wiki where published):'),
      list, add,
    );
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  empty.replaceChildren();
  tbody.replaceChildren(...d.tasks.map((t) => {
    const tr = el('tr', `maint-row-${t.status}`);
    const nameCell = el('td');
    nameCell.append(el('div', null, t.name));
    if (t.notes) nameCell.append(el('div', 'maint-notes', t.notes));
    const actions = el('td', 'maint-actions');
    taskActions(t, actions);
    const since = el('td', null, fmtSince(t));
    if (t.baselineSource !== 'last_done') since.title = t.baselineSource === 'first_job' ? 'Never done: counted from the first recorded job' : 'Never done: counted from when the task was added';
    const statusCell = el('td');
    statusCell.append(statusBadge(t.status));
    tr.append(nameCell, el('td', null, fmtInterval(t)), since, statusCell, el('td', null, fmtTs(t.lastDoneAt)), actions);
    return tr;
  }));
}

function renderLog(d) {
  const tbody = document.getElementById('maint-log-body');
  if (!d.recentLog.length) {
    const tr = el('tr');
    const td = el('td', 'stats-empty', 'Nothing logged yet');
    td.colSpan = 4;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(...d.recentLog.map((l) => {
    const tr = el('tr');
    tr.append(el('td', null, fmtTs(l.doneAt)), el('td', null, l.taskName), el('td', null, fmtNum(l.printHoursAt)), el('td', null, l.note || ''));
    return tr;
  }));
}

function renderErrors(d) {
  const tbody = document.getElementById('maint-errors-body');
  const rows = [
    ...d.repeatErrors.hms.map((e) => ({ ...e, type: 'HMS' })),
    ...d.repeatErrors.printErrors.map((e) => ({ ...e, type: 'print_error' })),
  ];
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'stats-empty', `No errors in the last ${d.repeatErrors.windowDays} days`);
    td.colSpan = 5;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  tbody.replaceChildren(...rows.map((e) => {
    const tr = el('tr');
    const desc = el('td');
    desc.append(el('span', null, e.description || '—'));
    if (typeof e.wikiUrl === 'string' && e.wikiUrl.startsWith(WIKI_PREFIX)) {
      const a = el('a', 'maint-wiki', 'wiki');
      a.href = e.wikiUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      desc.append(' ', a);
    }
    tr.append(el('td', null, e.type), el('td', 'maint-code', e.code), el('td', e.count > 1 ? 'stats-warn' : null, e.count), el('td', null, fmtTs(e.lastSeen)), desc);
    return tr;
  }));
}

function render(d) {
  ui.data = d;
  renderTiles(d);
  renderTasks(d);
  renderLog(d);
  renderErrors(d);
}

// ─── Add / edit form ───

function formEls() {
  const form = document.getElementById('maint-form');
  return {
    form,
    name: form.elements.name,
    intervalHours: form.elements.intervalHours,
    intervalDays: form.elements.intervalDays,
    lastDoneAt: form.elements.lastDoneAt,
    notes: form.elements.notes,
    title: document.getElementById('maint-form-title'),
    submit: document.getElementById('maint-form-submit'),
    cancel: document.getElementById('maint-form-cancel'),
  };
}

function resetForm() {
  const f = formEls();
  f.form.reset();
  ui.editingId = null;
  ui.editingLastDone = '';
  f.title.textContent = 'Add task';
  f.submit.textContent = 'Add';
  f.cancel.classList.add('hidden');
}

function startEdit(task) {
  const f = formEls();
  ui.editingId = task.id;
  f.name.value = task.name;
  f.intervalHours.value = task.intervalHours ?? '';
  f.intervalDays.value = task.intervalDays ?? '';
  ui.editingLastDone = task.lastDoneAt ? String(task.lastDoneAt).slice(0, 10) : '';
  f.lastDoneAt.value = ui.editingLastDone;
  f.notes.value = task.notes || '';
  f.title.textContent = `Edit task: ${task.name}`;
  f.submit.textContent = 'Save';
  f.cancel.classList.remove('hidden');
  f.form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  f.name.focus();
}

async function submitForm(e) {
  e.preventDefault();
  const f = formEls();
  const num = (v) => (v.trim() === '' ? null : Number(v));
  const body = {
    name: f.name.value,
    intervalHours: num(f.intervalHours.value),
    intervalDays: num(f.intervalDays.value),
    notes: f.notes.value,
  };
  const lastDone = f.lastDoneAt.value;
  if (ui.editingId == null) {
    if (lastDone) body.lastDoneAt = lastDone;
  } else if (lastDone !== ui.editingLastDone) {
    body.lastDoneAt = lastDone || null;
  }
  try {
    if (ui.editingId == null) {
      if (!ui.printer) throw new Error('Select a printer first');
      await api('POST', `/api/maintenance/${encodeURIComponent(ui.printer)}/tasks`, body);
      setStatus(`Added "${body.name.trim()}"`);
    } else {
      await api('PUT', `/api/maintenance/tasks/${ui.editingId}`, body);
      setStatus('Task updated');
    }
    resetForm();
    await refresh();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// ─── Loading ───

async function loadPrinter() {
  const seq = ++ui.loadSeq;
  if (!ui.printer) {
    setStatus('No printers yet');
    return;
  }
  setStatus('Loading…');
  try {
    const d = await api('GET', `/api/maintenance/${encodeURIComponent(ui.printer)}`);
    if (seq !== ui.loadSeq) return;
    render(d);
    setStatus('');
  } catch (err) {
    if (seq === ui.loadSeq) setStatus(`Error: ${err.message}`);
  }
}

async function refresh() {
  try {
    await loadSummary();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    return;
  }
  await loadPrinter();
}

/** Called when the Maintenance tab is opened. */
export function initMaintenanceUI() {
  if (!ui.wired) {
    ui.wired = true;
    const dashSel = document.getElementById('dash-filter-printer');
    if (dashSel && dashSel.value && dashSel.value !== '__all__') ui.printer = dashSel.value;
    document.getElementById('maint-filter-printer').addEventListener('change', (e) => {
      ui.printer = e.target.value;
      resetForm();
      loadPrinter();
    });
    document.getElementById('maint-form').addEventListener('submit', submitForm);
    document.getElementById('maint-form-cancel').addEventListener('click', resetForm);
  }
  refresh();
}
