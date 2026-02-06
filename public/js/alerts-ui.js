let currentState = null;

export async function initAlertsUI(state) {
  currentState = state;
  await loadAlertRules();
  setupAddButton();
}

async function loadAlertRules() {
  try {
    const res = await fetch('/api/alerts');
    const rules = await res.json();
    renderAlertRules(rules);
  } catch { /* ignore */ }
}

function renderAlertRules(rules) {
  const container = document.getElementById('alert-rules-list');
  container.innerHTML = '';

  if (rules.length === 0) {
    container.innerHTML = '<p style="color: var(--text-dim); padding: 20px;">No alert rules configured.</p>';
    return;
  }

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = 'alert-rule-card';

    const printerLabel = rule.device_id || 'All printers';
    const condDesc = describeCondition(rule.condition_type, rule.condition_config);

    card.innerHTML = `
      <label class="toggle">
        <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-id="${rule.id}">
        <span class="slider"></span>
      </label>
      <div class="rule-info">
        <div class="rule-name">${escapeHtml(rule.name)}</div>
        <div class="rule-details">${escapeHtml(condDesc)} | ${escapeHtml(printerLabel)} | via ${rule.notify_via} | cooldown ${rule.cooldown_sec}s</div>
      </div>
      <div class="rule-actions">
        <button class="btn-secondary btn-edit" data-id="${rule.id}">Edit</button>
        <button class="btn-danger btn-delete" data-id="${rule.id}">Delete</button>
      </div>
    `;

    // Toggle enabled
    card.querySelector('input[type="checkbox"]').addEventListener('change', async (e) => {
      await fetch(`/api/alerts/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: e.target.checked ? 1 : 0 }),
      });
    });

    // Delete
    card.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete rule "${rule.name}"?`)) return;
      await fetch(`/api/alerts/${rule.id}`, { method: 'DELETE' });
      loadAlertRules();
    });

    // Edit
    card.querySelector('.btn-edit').addEventListener('click', () => {
      openAlertForm(rule);
    });

    container.appendChild(card);
  }
}

function setupAddButton() {
  const btn = document.getElementById('btn-add-alert');
  // Remove old listeners by cloning
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => openAlertForm(null));

  const cancelBtn = document.getElementById('btn-cancel-alert');
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  newCancel.addEventListener('click', () => {
    document.getElementById('alert-form-modal').classList.add('hidden');
  });
}

function openAlertForm(rule) {
  const modal = document.getElementById('alert-form-modal');
  const form = document.getElementById('alert-form');
  const title = document.getElementById('alert-form-title');

  title.textContent = rule ? 'Edit Alert Rule' : 'New Alert Rule';

  form.name.value = rule?.name || '';
  form.conditionType.value = rule?.condition_type || 'state_change';
  form.notifyVia.value = rule?.notify_via || 'console';
  form.cooldownSec.value = rule?.cooldown_sec ?? 300;

  // Populate printer select
  const printerSelect = form.deviceId;
  printerSelect.innerHTML = '<option value="">All printers</option>';
  if (currentState?.printers) {
    for (const [id, p] of Object.entries(currentState.printers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.db?.name || id;
      if (rule?.device_id === id) opt.selected = true;
      printerSelect.appendChild(opt);
    }
  }

  updateConditionFields(form.conditionType.value, rule?.condition_config);
  updateNotifyFields(form.notifyVia.value, rule?.notify_config);

  form.conditionType.onchange = () => updateConditionFields(form.conditionType.value, null);
  form.notifyVia.onchange = () => updateNotifyFields(form.notifyVia.value, null);

  // Remove old submit handler by cloning form
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  // Re-attach change handlers on cloned form
  newForm.conditionType.onchange = () => updateConditionFields(newForm.conditionType.value, null);
  newForm.notifyVia.onchange = () => updateNotifyFields(newForm.notifyVia.value, null);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: newForm.name.value,
      deviceId: newForm.deviceId.value || null,
      conditionType: newForm.conditionType.value,
      conditionConfig: getConditionConfig(newForm),
      notifyVia: newForm.notifyVia.value,
      notifyConfig: getNotifyConfig(newForm),
      cooldownSec: parseInt(newForm.cooldownSec.value, 10),
    };

    if (rule) {
      await fetch(`/api/alerts/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    modal.classList.add('hidden');
    loadAlertRules();
  });

  // Cancel button on cloned form
  newForm.querySelector('#btn-cancel-alert')?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modal.classList.remove('hidden');
}

function updateConditionFields(type, config) {
  const container = document.getElementById('condition-config-fields');
  config = config || {};

  switch (type) {
    case 'state_change':
      container.innerHTML = `
        <label>Target States (comma-separated)
          <input type="text" name="cc_states" value="${(config.states || ['FINISH', 'FAILED']).join(', ')}" placeholder="FINISH, FAILED">
        </label>
      `;
      break;
    case 'temp_anomaly':
      container.innerHTML = `
        <label>Deviation threshold (°C)
          <input type="number" name="cc_deviationDeg" value="${config.deviationDeg || 10}" min="1">
        </label>
      `;
      break;
    case 'temp_threshold':
      container.innerHTML = `
        <label>Sensor
          <select name="cc_sensor">
            <option value="nozzle" ${config.sensor === 'nozzle' ? 'selected' : ''}>Nozzle</option>
            <option value="bed" ${config.sensor === 'bed' ? 'selected' : ''}>Bed</option>
            <option value="chamber" ${config.sensor === 'chamber' ? 'selected' : ''}>Chamber</option>
          </select>
        </label>
        <label>Operator
          <select name="cc_operator">
            <option value="above" ${config.operator === 'above' ? 'selected' : ''}>Above</option>
            <option value="below" ${config.operator === 'below' ? 'selected' : ''}>Below</option>
          </select>
        </label>
        <label>Value (°C) <input type="number" name="cc_value" value="${config.value || 0}"></label>
      `;
      break;
    case 'progress_stall':
      container.innerHTML = `
        <label>Stall duration (minutes)
          <input type="number" name="cc_minutes" value="${config.minutes || 15}" min="1">
        </label>
      `;
      break;
    default:
      container.innerHTML = '';
  }
}

function updateNotifyFields(via, config) {
  const container = document.getElementById('notify-config-fields');
  config = config || {};

  if (via === 'webhook') {
    container.innerHTML = `
      <label>Webhook URL <input type="url" name="nc_url" value="${config.url || ''}" placeholder="https://hooks.slack.com/..."></label>
      <label>Format
        <select name="nc_format">
          <option value="generic" ${config.format === 'generic' || !config.format ? 'selected' : ''}>Generic JSON</option>
          <option value="slack" ${config.format === 'slack' ? 'selected' : ''}>Slack</option>
          <option value="discord" ${config.format === 'discord' ? 'selected' : ''}>Discord</option>
        </select>
      </label>
    `;
  } else {
    container.innerHTML = '';
  }
}

function getConditionConfig(form) {
  const type = form.conditionType.value;
  switch (type) {
    case 'state_change':
      return { states: (form.cc_states?.value || 'FINISH,FAILED').split(',').map((s) => s.trim()).filter(Boolean) };
    case 'temp_anomaly':
      return { deviationDeg: parseInt(form.cc_deviationDeg?.value || '10', 10) };
    case 'temp_threshold':
      return {
        sensor: form.cc_sensor?.value || 'nozzle',
        operator: form.cc_operator?.value || 'above',
        value: parseInt(form.cc_value?.value || '0', 10),
      };
    case 'progress_stall':
      return { minutes: parseInt(form.cc_minutes?.value || '15', 10) };
    default:
      return {};
  }
}

function getNotifyConfig(form) {
  if (form.notifyVia.value === 'webhook') {
    return {
      url: form.nc_url?.value || '',
      format: form.nc_format?.value || 'generic',
    };
  }
  return {};
}

function describeCondition(type, config) {
  config = config || {};
  switch (type) {
    case 'state_change':
      return `State → ${(config.states || ['FINISH', 'FAILED']).join('/')}`;
    case 'hms_error':
      return 'HMS Error detected';
    case 'temp_anomaly':
      return `Temp deviation > ${config.deviationDeg || 10}°C`;
    case 'temp_threshold':
      return `${config.sensor || '?'} ${config.operator || '?'} ${config.value || '?'}°C`;
    case 'progress_stall':
      return `Stall > ${config.minutes || 15} min`;
    default:
      return type;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
