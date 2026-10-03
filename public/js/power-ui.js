// BAM-18 power UI: per-printer smart-plug settings and global power settings (price, circuits).
// Admin-only (hidden for other roles, enforced server-side). Read-only plugs: nothing here switches power.
// DOM via textContent only.

import { openModal } from './connection-ui.js';
import { confirmDialog } from './confirm-dialog.js';

const KIND_LABELS = {
  'shelly-gen2': 'Shelly Plus / Pro / Gen3+ (local RPC)',
  'shelly-gen1': 'Shelly Plug / Plug S / 1PM (Gen1)',
  tasmota: 'Tasmota (energy sensor)',
  homeassistant: 'Home Assistant sensor',
  'http-json': 'Other — JSON over HTTP',
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

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const field = (label, input, hint) => el('label', { class: 'conn-field' }, el('span', { class: 'conn-label', text: label }), input, ...(hint ? [el('span', { class: 'conn-hint', text: hint })] : []));

/** Smart plug for one printer. */
export async function openPlugDialog(deviceId, printerName) {
  const [cur, settings] = await Promise.all([
    api('GET', `/api/printers/${encodeURIComponent(deviceId)}/power-plug`),
    api('GET', '/api/power'),
  ]);
  if (!cur.ok) return false;
  const p = cur.data.plug;
  const circuits = settings.data?.settings?.circuits || [];

  return openModal(`Power plug — ${printerName}`, (box, close) => {
    const kind = el('select', { name: 'kind' });
    for (const [v, label] of Object.entries(KIND_LABELS)) {
      const o = el('option', { value: v, text: label });
      if (v === (p?.kind || 'shelly-gen2')) o.selected = true;
      kind.append(o);
    }
    const hiddenCreds = Boolean(p?.url.includes('(credentials hidden)'));
    const url = el('input', { type: 'text', name: 'url', autocomplete: 'off', spellcheck: 'false',
      placeholder: hiddenCreds ? `${p.url.replace(' (credentials hidden)', '')} — saved with a password; leave blank to keep` : 'http://10.0.0.20' });
    url.value = p && !hiddenCreds ? p.url : '';
    const channel = el('input', { type: 'number', name: 'channel', min: '0', max: '16' });
    channel.value = String(p?.channel ?? 0);
    const entity = el('input', { type: 'text', name: 'entity', placeholder: 'sensor.printer_plug_power', spellcheck: 'false' });
    entity.value = p?.entity || '';
    const jsonPath = el('input', { type: 'text', name: 'jsonPath', placeholder: 'data.power', spellcheck: 'false' });
    jsonPath.value = p?.jsonPath || '';
    const secret = el('input', { type: 'password', name: 'secret', autocomplete: 'off', placeholder: p?.hasSecret ? '•••••••• (saved — leave blank to keep)' : 'optional' });
    const circuit = el('select', { name: 'circuit' }, el('option', { value: '', text: '— none —' }));
    for (const c of circuits) {
      const o = el('option', { value: c.name, text: `${c.name} (${c.limitW} W)` });
      if (c.name === p?.circuit) o.selected = true;
      circuit.append(o);
    }
    const enabled = el('input', { type: 'checkbox', name: 'enabled' });
    enabled.checked = p ? p.enabled : true;

    const fChannel = field('Channel / relay', channel, 'Usually 0. Multi-relay devices: the relay feeding the printer.');
    const fEntity = field('Home Assistant entity', entity, 'A power sensor in W or kW.');
    const fPath = field('JSON path to watts', jsonPath, 'Dotted path, numbers for list items: e.g. data.0.power');
    const fSecret = field('Token / password', secret, 'Home Assistant: a long-lived access token. Other JSON: sent as a Bearer token. Stored on the server, never shown again.');
    const sync = () => {
      const k = kind.value;
      fChannel.classList.toggle('hidden', !['shelly-gen2', 'shelly-gen1', 'tasmota'].includes(k));
      fEntity.classList.toggle('hidden', k !== 'homeassistant');
      fPath.classList.toggle('hidden', k !== 'http-json');
      fSecret.classList.toggle('hidden', !['homeassistant', 'http-json'].includes(k));
    };
    kind.addEventListener('change', sync);
    sync();

    const result = el('div', { class: 'conn-test-result', role: 'status' });
    const body = () => {
      const b = { kind: kind.value, url: url.value.trim(), channel: Number(channel.value || 0), circuit: circuit.value, enabled: enabled.checked };
      if (kind.value === 'homeassistant') b.entity = entity.value.trim();
      if (kind.value === 'http-json') b.jsonPath = jsonPath.value.trim();
      if (secret.value) b.secret = secret.value;
      return b;
    };
    const say = (ok, text) => { result.className = `conn-test-result ${ok ? 'conn-ok' : 'conn-bad'}`; result.textContent = text; };

    const test = el('button', { type: 'button', class: 'btn-secondary', text: 'Test plug' });
    test.addEventListener('click', async () => {
      test.disabled = true;
      result.className = 'conn-test-result';
      result.textContent = 'Reading… (up to 3 s)';
      const r = await api('POST', `/api/printers/${encodeURIComponent(deviceId)}/power-plug/test`, body());
      if (!r.ok) say(false, r.data.error || `HTTP ${r.status}`);
      else if (r.data.ok) say(true, `Reading OK: ${r.data.watts} W${r.data.totalWh != null ? ` · meter ${(r.data.totalWh / 1000).toFixed(2)} kWh` : ''}`);
      else say(false, r.data.message || 'Plug test failed');
      test.disabled = false;
    });

    const save = el('button', { type: 'button', class: 'btn-primary', text: 'Save' });
    save.addEventListener('click', async () => {
      const r = await api('PUT', `/api/printers/${encodeURIComponent(deviceId)}/power-plug`, body());
      if (r.ok) { window.dispatchEvent(new CustomEvent('bambuzle:printers-changed')); close(true); } else say(false, r.data.error || `HTTP ${r.status}`);
    });
    const cancel = el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel' });
    cancel.addEventListener('click', () => close(false));
    const actions = el('div', { class: 'form-actions' });
    if (p) {
      const remove = el('button', { type: 'button', class: 'btn-danger conn-remove', text: 'Remove plug' });
      remove.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Remove the plug for ${printerName}?`, message: 'Bambuzle stops reading it. Recorded energy history stays.', confirmLabel: 'Remove', danger: true }))) return;
        const r = await api('DELETE', `/api/printers/${encodeURIComponent(deviceId)}/power-plug`);
        if (r.ok) { window.dispatchEvent(new CustomEvent('bambuzle:printers-changed')); close(true); }
      });
      actions.append(remove);
    }
    actions.append(test, cancel, save);

    box.append(
      el('p', { class: 'conn-intro', text: 'Read-only: Bambuzle only reads the plug\'s power meter. It never switches the plug.' }),
      field('Plug type', kind),
      field('Plug address', url, 'Its local http:// address. Plug login (Shelly Gen1, Tasmota): http://user:pass@… — never shown again. Shelly Gen2+ device passwords are not supported yet.'),
      fChannel, fEntity, fPath, fSecret,
      field('Circuit', circuit, circuits.length ? 'For circuit-limit alerts.' : 'Add circuits under Configuration → Power settings to get circuit-limit alerts.'),
      el('label', { class: 'conn-inline' }, enabled, el('span', { text: 'Read this plug' })),
      result,
      actions,
    );
  });
}

/** Electricity price and circuit limits. */
export async function openPowerSettings() {
  const cur = await api('GET', '/api/power');
  if (!cur.ok) return false;
  const s = cur.data.settings;

  return openModal('Power settings', (box, close) => {
    const price = el('input', { type: 'number', name: 'price', min: '0', max: '100', step: '0.0001', placeholder: 'e.g. 0.15' });
    price.value = s.pricePerKwh ?? '';
    const currency = el('input', { type: 'text', name: 'currency', maxlength: '8', placeholder: 'e.g. USD or $' });
    currency.value = s.currency || '';
    const list = el('div', { class: 'power-circuits' });
    const addRow = (c = { name: '', limitW: 1800 }) => {
      const name = el('input', { type: 'text', placeholder: 'Garage', maxlength: '40', 'aria-label': 'Circuit name' });
      name.value = c.name;
      const limit = el('input', { type: 'number', min: '100', max: '100000', step: '10', 'aria-label': 'Limit in watts' });
      limit.value = String(c.limitW);
      const del = el('button', { type: 'button', class: 'btn-secondary', text: 'Remove', 'aria-label': 'Remove circuit' });
      const row = el('div', { class: 'power-circuit-row' }, name, limit, el('span', { class: 'conn-hint', text: 'W' }), del);
      del.addEventListener('click', () => row.remove());
      list.append(row);
    };
    for (const c of s.circuits) addRow(c);
    const add = el('button', { type: 'button', class: 'btn-secondary', text: '+ Add circuit' });
    add.addEventListener('click', () => addRow());

    const msg = el('div', { class: 'conn-test-result', role: 'status' });
    const save = el('button', { type: 'button', class: 'btn-primary', text: 'Save' });
    save.addEventListener('click', async () => {
      const circuits = [...list.querySelectorAll('.power-circuit-row')].map((r) => {
        const [n, l] = r.querySelectorAll('input');
        return { name: n.value.trim(), limitW: Number(l.value) };
      }).filter((c) => c.name);
      const body = { pricePerKwh: price.value === '' ? null : Number(price.value), currency: currency.value.trim(), circuits };
      const r = await api('PUT', '/api/power/settings', body);
      if (r.ok) close(true);
      else { msg.className = 'conn-test-result conn-bad'; msg.textContent = r.data.error || `HTTP ${r.status}`; }
    });
    const cancel = el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel' });
    cancel.addEventListener('click', () => close(false));

    box.append(
      el('p', { class: 'conn-intro', text: 'Used for job energy cost (Stats, export) and circuit-limit alerts (Alerts → Power / circuit limit). A circuit\'s load is the sum of the plugs assigned to it.' }),
      field('Electricity price per kWh', price),
      field('Currency', currency),
      el('h4', { text: 'Circuits' }),
      list,
      add,
      msg,
      el('div', { class: 'form-actions' }, cancel, save),
    );
  });
}
