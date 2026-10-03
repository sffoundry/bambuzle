// BAM-16 account UI: user management (admins) and "My account" (password change).
// The server enforces every permission; this UI only hides what a role can't use. DOM via textContent.

import { openModal } from './connection-ui.js';
import { confirmDialog } from './confirm-dialog.js';

const ROLES = [
  ['viewer', 'Viewer — see everything except admin areas'],
  ['operator', 'Operator — viewer + printer controls, maintenance, SD files'],
  ['admin', 'Admin — everything, incl. users, connections, alerts, audit'],
];

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

function roleSelect(value) {
  const s = el('select', { class: 'users-role' });
  for (const [v, label] of ROLES) {
    const o = el('option', { value: v, text: v, title: label });
    if (v === value) o.selected = true;
    s.append(o);
  }
  return s;
}

/** In-app (themed) password prompt — never the browser's native prompt. Resolves the value or null. */
function promptNewPassword(username) {
  return new Promise((resolve) => {
    let value = null;
    openModal(`Reset password — ${username}`, (box, close) => {
      const input = el('input', { type: 'password', autocomplete: 'new-password', minlength: '10' });
      const ok = el('button', { type: 'button', class: 'btn-primary', text: 'Set password' });
      const cancel = el('button', { type: 'button', class: 'btn-secondary', text: 'Cancel' });
      ok.addEventListener('click', () => { value = input.value; close(true); });
      cancel.addEventListener('click', () => close(false));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
      box.append(
        el('p', { class: 'conn-intro', text: 'They\'ll be signed out everywhere and use the new password next time.' }),
        el('label', { class: 'conn-field' }, el('span', { class: 'conn-label', text: 'New password (min 10)' }), input),
        el('div', { class: 'form-actions' }, cancel, ok));
    }).then(() => resolve(value));
  });
}

/** Admin: list, add, change role, disable, reset password, delete. */
export function openUsersDialog() {
  return openModal('Users', (box, close) => {
    box.classList.add('users-dialog-content');
    const msg = el('div', { class: 'conn-test-result', role: 'status' });
    const listWrap = el('div', { class: 'table-scroll' });
    const say = (text, ok) => { msg.textContent = text; msg.className = `conn-test-result ${ok ? 'conn-ok' : 'conn-bad'}`; };

    async function refresh() {
      const r = await api('GET', '/api/users');
      if (!r.ok) { say(r.data.error || `Failed (${r.status})`, false); return; }
      const tbody = el('tbody');
      if (!r.data.length) tbody.append(el('tr', {}, el('td', { colspan: '4', text: 'No accounts yet — you\'re using the admin token. Add an admin account first.' })));
      for (const u of r.data) {
        const role = roleSelect(u.role);
        role.addEventListener('change', async () => {
          const res = await api('PATCH', `/api/users/${u.id}`, { role: role.value });
          say(res.ok ? `${u.username} is now ${role.value} (signed out everywhere)` : res.data.error, res.ok);
          refresh();
        });
        const toggle = el('button', { type: 'button', class: 'btn-secondary', text: u.disabled ? 'Enable' : 'Disable' });
        toggle.addEventListener('click', async () => {
          const res = await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled });
          say(res.ok ? `${u.username} ${u.disabled ? 'enabled' : 'disabled'}` : res.data.error, res.ok);
          refresh();
        });
        const reset = el('button', { type: 'button', class: 'btn-secondary', text: 'Reset password' });
        reset.addEventListener('click', async () => {
          const pw = await promptNewPassword(u.username);
          if (!pw) return;
          const res = await api('PATCH', `/api/users/${u.id}`, { password: pw });
          say(res.ok ? `Password reset for ${u.username} (signed out everywhere)` : res.data.error, res.ok);
        });
        const del = el('button', { type: 'button', class: 'btn-danger', text: 'Delete' });
        del.addEventListener('click', async () => {
          if (!(await confirmDialog({ title: `Delete ${u.username}?`, message: 'They are signed out immediately. Their past actions stay in the audit trail.', confirmLabel: 'Delete', danger: true }))) return;
          const res = await api('DELETE', `/api/users/${u.id}`);
          say(res.ok ? `Deleted ${u.username}` : res.data.error, res.ok);
          refresh();
        });
        tbody.append(el('tr', { class: u.disabled ? 'users-disabled' : '' },
          el('td', { text: u.username }),
          el('td', {}, role),
          el('td', { text: u.lastLoginAt ? new Date(`${u.lastLoginAt.replace(' ', 'T')}Z`).toLocaleString() : 'never' }),
          el('td', {}, el('div', { class: 'users-actions' }, toggle, reset, del))));
      }
      listWrap.replaceChildren(el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['User', 'Role', 'Last sign-in', ''].map((h) => el('th', { text: h })))), tbody));
    }

    const name = el('input', { type: 'text', name: 'username', placeholder: 'username', autocomplete: 'off', spellcheck: 'false', maxlength: '32' });
    const pass = el('input', { type: 'password', name: 'password', placeholder: 'password (min 10)', autocomplete: 'new-password' });
    const role = roleSelect('viewer');
    const add = el('button', { type: 'button', class: 'btn-primary', text: 'Add user' });
    add.addEventListener('click', async () => {
      const res = await api('POST', '/api/users', { username: name.value.trim(), password: pass.value, role: role.value });
      if (res.ok) { name.value = ''; pass.value = ''; say(`Added ${res.data.username} (${res.data.role})`, true); refresh(); }
      else say(res.data.error || `Failed (${res.status})`, false);
    });
    const closeBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Close' });
    closeBtn.addEventListener('click', () => close(true));

    box.append(
      el('p', { class: 'conn-intro', text: 'Once an account exists, the sign-in screen asks for a username and password. The admin token keeps working as a break-glass admin login and for scripts.' }),
      listWrap,
      el('h4', { text: 'Add a user' }),
      el('div', { class: 'users-add' }, name, pass, role, add),
      msg,
      el('div', { class: 'form-actions' }, closeBtn),
    );
    refresh();
  });
}

/** Signed-in user: change own password. Token sessions get an explanation instead. */
export function openAccountDialog(user) {
  return openModal('Your account', (box, close) => {
    const closeBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Close' });
    closeBtn.addEventListener('click', () => close(true));
    box.append(el('p', { class: 'conn-intro', text: user.kind === 'user'
      ? `Signed in as ${user.name} (${user.role}).`
      : 'Signed in with the admin token (full admin access). Create user accounts under Configuration → Users.' }));
    if (user.kind === 'user') {
      const cur = el('input', { type: 'password', autocomplete: 'current-password' });
      const next = el('input', { type: 'password', autocomplete: 'new-password' });
      const msg = el('div', { class: 'conn-test-result', role: 'status' });
      const save = el('button', { type: 'button', class: 'btn-primary', text: 'Change password' });
      save.addEventListener('click', async () => {
        const res = await api('POST', '/api/me/password', { currentPassword: cur.value, newPassword: next.value });
        msg.className = `conn-test-result ${res.ok ? 'conn-ok' : 'conn-bad'}`;
        msg.textContent = res.ok ? 'Password changed — other sessions were signed out.' : (res.data.error || `Failed (${res.status})`);
        if (res.ok) { cur.value = ''; next.value = ''; }
      });
      box.append(
        el('label', { class: 'conn-field' }, el('span', { class: 'conn-label', text: 'Current password' }), cur),
        el('label', { class: 'conn-field' }, el('span', { class: 'conn-label', text: 'New password (min 10)' }), next),
        msg, el('div', { class: 'form-actions' }, closeBtn, save));
    } else {
      box.append(el('div', { class: 'form-actions' }, closeBtn));
    }
  });
}
