// SD-card files dialog (BAM-44): timelapses and sliced print files over FTPS. Downloads are plain
// same-origin links (the session cookie authorises them). DOM built with textContent only.

import { openModal } from './connection-ui.js';

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

function fmtSize(b) {
  if (b == null) return '—';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString();
}

export function openFilesDialog(deviceId, printerName) {
  return openModal(`SD card — ${printerName}`, (box, close) => {
    const tabs = el('div', { class: 'files-tabs', role: 'tablist' });
    const body = el('div', { class: 'files-body', role: 'status' });
    const kinds = [['timelapse', 'Timelapses'], ['prints', 'Print files']];

    async function load(kind) {
      for (const b of tabs.children) b.classList.toggle('active', b.dataset.kind === kind);
      body.replaceChildren(el('p', { class: 'conn-intro', text: 'Reading the printer\'s SD card… (FTPS over LAN)' }));
      let res;
      let data;
      try {
        res = await fetch(`/api/printers/${encodeURIComponent(deviceId)}/files?kind=${kind}`);
        data = await res.json();
      } catch {
        body.replaceChildren(el('p', { class: 'conn-test-result conn-bad', text: 'Network error' }));
        return;
      }
      if (!res.ok) {
        body.replaceChildren(el('p', { class: 'conn-test-result conn-bad', text: data.error || `Failed (${res.status})` }));
        window.dispatchEvent(new CustomEvent('bambuzle:printers-changed')); // capability changed (files unavailable)
        return;
      }
      if (!data.files.length) {
        body.replaceChildren(el('p', { class: 'conn-intro', text: kind === 'timelapse' ? 'No timelapses on the SD card. (Turn on timelapse in the print settings to record them.)' : 'No print files on the SD card.' }));
        return;
      }
      const table = el('table', { class: 'data-table files-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Size' }), el('th', { text: 'Date' }), el('th', { text: '' }))));
      const tbody = el('tbody');
      for (const f of data.files) {
        const href = `/api/printers/${encodeURIComponent(deviceId)}/files/download?kind=${kind}&path=${encodeURIComponent(f.path)}`;
        tbody.append(el('tr', {},
          el('td', { class: 'files-name', text: f.name }),
          el('td', { text: fmtSize(f.size) }),
          el('td', { text: fmtTime(f.modifiedAt) }),
          el('td', {}, el('a', { href, class: 'btn-secondary files-dl', download: f.name, text: 'Download' }))));
      }
      table.append(tbody);
      body.replaceChildren(el('div', { class: 'table-scroll' }, table));
    }

    for (const [kind, label] of kinds) {
      const b = el('button', { type: 'button', class: 'btn-secondary files-tab', role: 'tab', text: label });
      b.dataset.kind = kind;
      b.addEventListener('click', () => load(kind));
      tabs.append(b);
    }
    const closeBtn = el('button', { type: 'button', class: 'btn-primary', text: 'Close' });
    closeBtn.addEventListener('click', () => close(true));
    box.append(
      el('p', { class: 'conn-intro', text: 'Files on the printer\'s SD card, read over the LAN connection. On current Bambu firmware this may only work with Developer Mode on.' }),
      tabs, body, el('div', { class: 'form-actions' }, closeBtn));
    box.classList.add('files-dialog-content');
    load('timelapse');
  });
}
