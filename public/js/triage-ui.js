// Print-failure triage UI (BAM-40): recent jobs with verdicts in the Stats view + a timeline dialog.
// Verdicts and reasons come from the server (src/printers/job-triage.js). DOM via textContent only.

import { openModal } from './connection-ui.js';

const VERDICT_TEXT = { intervene: 'Intervene', inspect: 'Inspect', clean: 'Clean' };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...children);
  return n;
}

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(`${String(ts).replace(' ', 'T')}${/[zZ]$/.test(ts) ? '' : 'Z'}`);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function badge(verdict) {
  return el('span', { class: `triage-badge triage-${verdict}`, text: VERDICT_TEXT[verdict] || verdict });
}

/** Render the recent-jobs triage list for one printer into `container`. */
export async function renderRecentTriage(container, deviceId, printerName) {
  container.replaceChildren();
  if (!deviceId) {
    container.append(el('p', { class: 'conn-intro', text: 'Choose a printer above to see its recent jobs with a triage verdict.' }));
    return;
  }
  container.append(el('p', { class: 'conn-intro', text: 'Loading…' }));
  let rows;
  try {
    const res = await fetch(`/api/printers/${encodeURIComponent(deviceId)}/triage?limit=25`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || res.status);
  } catch (err) {
    container.replaceChildren(el('p', { class: 'conn-test-result conn-bad', text: `Failed to load: ${err.message}` }));
    return;
  }
  if (!rows.length) {
    container.replaceChildren(el('p', { class: 'conn-intro', text: 'No jobs recorded yet.' }));
    return;
  }
  const tbody = el('tbody');
  for (const j of rows) {
    const open = el('button', { type: 'button', class: 'btn-secondary triage-open', text: 'Timeline' });
    open.addEventListener('click', () => openTriageDialog(deviceId, j.id, printerName));
    tbody.append(el('tr', {},
      el('td', {}, badge(j.verdict)),
      el('td', { class: 'triage-job', text: j.subtask_name || `Job ${j.id}` }),
      el('td', { text: fmtTs(j.started_at) }),
      el('td', { text: j.end_state || 'running' }),
      el('td', { class: 'triage-reason', text: j.reasons[0] || '' }),
      el('td', {}, open)));
  }
  const table = el('table', { class: 'data-table triage-table' },
    el('thead', {}, el('tr', {}, ...['Verdict', 'Job', 'Started', 'Ended', 'Main reason', ''].map((h) => el('th', { text: h })))),
    tbody);
  container.replaceChildren(el('div', { class: 'table-scroll' }, table));
}

export async function openTriageDialog(deviceId, jobId, printerName) {
  let data;
  try {
    const res = await fetch(`/api/printers/${encodeURIComponent(deviceId)}/jobs/${jobId}/triage`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
  } catch (err) {
    data = { error: err.message };
  }
  return openModal(`Job ${jobId} — ${printerName || deviceId}`, (box, close) => {
    box.classList.add('triage-dialog-content');
    if (data.error) {
      box.append(el('p', { class: 'conn-test-result conn-bad', text: data.error }));
    } else {
      box.append(el('div', { class: 'triage-head' }, badge(data.verdict),
        el('span', { class: 'triage-job', text: data.job?.subtask_name || '' })));
      if (data.reasons.length) {
        const ul = el('ul', { class: 'triage-reasons' });
        for (const r of data.reasons) ul.append(el('li', { text: r }));
        box.append(ul);
      } else {
        box.append(el('p', { class: 'conn-intro', text: 'Nothing notable recorded for this job.' }));
      }
      if (data.clusters.length) {
        box.append(el('h4', { text: 'Timeline' }));
        const list = el('div', { class: 'triage-timeline' });
        for (const c of data.clusters) {
          const group = el('div', { class: `triage-cluster triage-${c.severity}` },
            el('div', { class: 'triage-cluster-time', text: `${fmtTs(c.start)}${c.items.length > 1 ? ` · ${c.items.length} events` : ''}` }));
          for (const i of c.items) {
            group.append(el('div', { class: 'triage-item' }, el('span', { class: 'triage-item-title', text: i.title }), el('span', { class: 'triage-item-detail', text: i.detail || '' })));
          }
          list.append(group);
        }
        box.append(list);
      }
      box.append(el('p', { class: 'conn-intro', text: 'Verdicts are rule-based (HMS level, printer self-pauses, temperature-anomaly bursts, slow layers) — not camera AI.' }));
    }
    const done = el('button', { type: 'button', class: 'btn-primary', text: 'Close' });
    done.addEventListener('click', () => close(true));
    box.append(el('div', { class: 'form-actions' }, done));
  });
}
