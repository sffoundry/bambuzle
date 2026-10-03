import { isTopDialog } from './confirm-dialog.js';

// Printer connection settings (BAM-35): cloud vs LAN per printer, LAN access code, connection test,
// and adding LAN-only printers by hand. The access code is write-only — the API never returns it.
// After a change we fire 'bambuzle:printers-changed' so app.js reloads the printer list.

const MODE_LABELS = {
  auto: 'Auto — LAN if configured, otherwise Cloud',
  cloud: 'BambuLab Cloud',
  lan: 'LAN (direct to printer)',
};

const STAGE_TEXT = {
  connected: 'Connected',
  auth: 'Access code rejected',
  identity: 'Wrong printer at this address',
  tls: 'Certificate check failed',
  unreachable: 'Not reachable',
  error: 'Failed',
};

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

function field(label, input, hint) {
  const wrap = el('label', { class: 'conn-field' }, el('span', { class: 'conn-label', text: label }), input);
  if (hint) wrap.append(el('span', { class: 'conn-hint', text: hint }));
  return wrap;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Modal shell shared by both dialogs; resolves when closed. Topmost-only Escape, focus trap, focus return. */
export function openModal(title, buildBody) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const overlay = el('div', { class: 'modal conn-dialog', role: 'dialog', 'aria-modal': 'true' });
    const box = el('div', { class: 'modal-content conn-dialog-content' }, el('h3', { text: title }));
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (!isTopDialog(overlay)) return; // e.g. the "Remove printer?" confirm on top handles Escape itself
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); return; }
      if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button, input, select')].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    buildBody(box, close);
    overlay.append(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    box.querySelector('select, input')?.focus();
  });
}

function testResultLine() {
  return el('div', { class: 'conn-test-result', role: 'status' });
}

function showTestResult(line, r) {
  line.className = `conn-test-result ${r.ok ? 'conn-ok' : 'conn-bad'}`;
  const dev = r.developerMode === true ? ' · Developer Mode ON — printer controls will work over LAN'
    : r.developerMode === false ? ' · Developer Mode OFF — monitoring works; controls need Developer Mode' : '';
  line.textContent = `${STAGE_TEXT[r.stage] || r.stage}: ${r.message || ''}${r.ok ? dev : ''}`;
}

/** Edit one printer's connection. */
export async function openConnectionDialog(deviceId, printerName) {
  const current = await api('GET', `/api/printers/${encodeURIComponent(deviceId)}/connection`);
  if (!current.ok) return false;
  const c = current.data.connection;

  return openModal(`Connection — ${printerName}`, (box, close) => {
    const mode = el('select', { name: 'mode' });
    for (const [v, label] of Object.entries(MODE_LABELS)) {
      const o = el('option', { value: v, text: label });
      if (v === c.mode) o.selected = true;
      mode.append(o);
    }
    const host = el('input', { type: 'text', name: 'lanHost', placeholder: '192.168.1.50', autocomplete: 'off', spellcheck: 'false' });
    host.value = c.lanHost || '';
    const code = el('input', { type: 'password', name: 'accessCode', autocomplete: 'off', maxlength: '8',
      placeholder: c.hasAccessCode ? '•••••••• (saved — leave blank to keep)' : '8 characters' });
    const clearCode = el('label', { class: 'conn-inline' }, el('input', { type: 'checkbox', name: 'clearCode' }), el('span', { text: 'Remove saved access code' }));
    const result = testResultLine();
    const error = el('div', { class: 'login-error hidden' });

    const test = el('button', { type: 'button', class: 'btn-secondary', text: 'Test LAN connection' });
    test.addEventListener('click', async () => {
      test.disabled = true;
      result.className = 'conn-test-result';
      result.textContent = 'Testing… (up to 10 s)';
      const body = {};
      if (host.value.trim()) body.lanHost = host.value.trim();
      if (code.value) body.accessCode = code.value;
      const r = await api('POST', `/api/printers/${encodeURIComponent(deviceId)}/connection/test`, body);
      showTestResult(result, r.ok ? r.data : { ok: false, stage: 'error', message: r.data.error || `HTTP ${r.status}` });
      test.disabled = false;
    });

    const save = el('button', { type: 'button', class: 'btn-primary', text: 'Save' });
    const cancel = el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel' });
    cancel.addEventListener('click', () => close(false));
    const actions = el('div', { class: 'form-actions' });
    if (c.source === 'manual') {
      const remove = el('button', { type: 'button', class: 'btn-danger conn-remove', text: 'Remove printer' });
      remove.addEventListener('click', async () => {
        const { confirmDialog } = await import('./confirm-dialog.js');
        if (!(await confirmDialog({ title: `Remove ${printerName}?`, message: 'Bambuzle stops monitoring it. Its print history stays in the database.', confirmLabel: 'Remove', danger: true }))) return;
        const r = await api('DELETE', `/api/printers/${encodeURIComponent(deviceId)}`);
        if (r.ok) { window.dispatchEvent(new CustomEvent('bambuzle:printers-changed')); close(true); }
      });
      actions.append(remove);
    }
    actions.append(cancel, save);
    save.addEventListener('click', async () => {
      error.classList.add('hidden');
      const body = { mode: mode.value, lanHost: host.value.trim() || '' };
      if (clearCode.querySelector('input').checked) body.accessCode = '';
      else if (code.value) body.accessCode = code.value;
      const r = await api('PUT', `/api/printers/${encodeURIComponent(deviceId)}/connection`, body);
      if (!r.ok) {
        error.textContent = r.data.error || `Save failed (${r.status})`;
        error.classList.remove('hidden');
        return;
      }
      window.dispatchEvent(new CustomEvent('bambuzle:printers-changed'));
      close(true);
    });

    box.append(
      el('p', { class: 'conn-intro', text: 'LAN talks to the printer directly (find its IP and access code on the printer screen under network / LAN settings). Monitoring works either way; printer controls need LAN with Developer Mode on, on current Bambu firmware.' }),
      field('Connect via', mode),
      field('Printer IP / hostname', host),
      field('LAN access code', code),
      ...(c.hasAccessCode ? [clearCode] : []),
      el('div', { class: 'conn-test-row' }, test),
      result,
      error,
      actions,
    );
  });
}

/** Add a printer that isn't on a Bambu Cloud account (LAN / Developer Mode). */
export async function openAddLanPrinterDialog() {
  return openModal('Add LAN printer', (box, close) => {
    const serial = el('input', { type: 'text', name: 'serial', placeholder: 'e.g. 01P00A123456789', autocomplete: 'off', spellcheck: 'false', maxlength: '20' });
    const name = el('input', { type: 'text', name: 'name', placeholder: 'Garage P1S', maxlength: '64' });
    const model = el('input', { type: 'text', name: 'model', placeholder: 'P1S (optional)', maxlength: '32' });
    const host = el('input', { type: 'text', name: 'lanHost', placeholder: '192.168.1.50', autocomplete: 'off', spellcheck: 'false' });
    const code = el('input', { type: 'password', name: 'accessCode', placeholder: '8 characters', autocomplete: 'off', maxlength: '8' });
    const error = el('div', { class: 'login-error hidden' });
    const save = el('button', { type: 'button', class: 'btn-primary', text: 'Add printer' });
    const cancel = el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel' });
    cancel.addEventListener('click', () => close(false));
    save.addEventListener('click', async () => {
      error.classList.add('hidden');
      const r = await api('POST', '/api/printers', {
        serial: serial.value.trim(), name: name.value.trim(), model: model.value.trim() || undefined,
        lanHost: host.value.trim(), accessCode: code.value,
      });
      if (!r.ok) {
        error.textContent = r.data.error || `Failed (${r.status})`;
        error.classList.remove('hidden');
        return;
      }
      window.dispatchEvent(new CustomEvent('bambuzle:printers-changed'));
      close(true);
    });
    box.append(
      el('p', { class: 'conn-intro', text: 'For printers in LAN-only / Developer Mode that Bambu Cloud can\'t see. The serial number is on the printer (Settings → Device) and must match exactly — Bambuzle verifies it against the printer\'s certificate.' }),
      field('Serial number', serial),
      field('Name', name),
      field('Model', model),
      field('Printer IP / hostname', host),
      field('LAN access code', code),
      error,
      el('div', { class: 'form-actions' }, cancel, save),
    );
  });
}
