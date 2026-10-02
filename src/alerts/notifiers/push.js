'use strict';

// Push-notification channels (BAM-15): ntfy, Pushover, Telegram.
// Each notifier takes the rule's notify_config; secrets live there (alert routes are admin-guarded).
// `opts.apiBase` exists only so tests can point Pushover/Telegram at a local server.

const TIMEOUT_MS = 10000;

function title(alert) {
  return `Bambuzle — ${alert.printerName || alert.deviceId}`;
}

async function send(log, channel, url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      log.error({ status: res.status, channel }, 'Push notification failed');
      return false;
    }
    log.info({ channel }, 'Push notification sent');
    return true;
  } catch (err) {
    log.error({ err: err.message, channel }, 'Push notification error');
    return false;
  }
}

/**
 * ntfy: config { server (default https://ntfy.sh), topic, token? }
 * Uses JSON publishing (POST to the server root) because header-based Title/Tags can't carry
 * non-ASCII — fetch rejects it, and printer names are user-chosen.
 */
function createNtfyNotifier(logger) {
  const log = logger.child({ component: 'alert-ntfy' });
  const PRIORITY = { error: 5, warning: 4, info: 3 };
  const TAGS = { error: 'rotating_light', warning: 'warning', info: 'printer' };
  return {
    name: 'ntfy',
    async notify(alert, config = {}) {
      if (!config.topic) {
        log.error('ntfy topic not configured');
        return false;
      }
      const server = (config.server || 'https://ntfy.sh').replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      return send(log, 'ntfy', `${server}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic: config.topic,
          title: title(alert),
          message: `[${alert.ruleName}] ${alert.message}`,
          priority: PRIORITY[alert.severity] || 3,
          tags: [TAGS[alert.severity] || 'printer'],
        }),
      });
    },
  };
}

/** Pushover: config { appToken, userKey } */
function createPushoverNotifier(logger, opts = {}) {
  const log = logger.child({ component: 'alert-pushover' });
  const apiBase = opts.apiBase || 'https://api.pushover.net';
  const PRIORITY = { error: 1, warning: 0, info: -1 };
  return {
    name: 'pushover',
    async notify(alert, config = {}) {
      if (!config.appToken || !config.userKey) {
        log.error('Pushover appToken/userKey not configured');
        return false;
      }
      return send(log, 'pushover', `${apiBase}/1/messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: config.appToken,
          user: config.userKey,
          title: title(alert),
          message: `[${alert.ruleName}] ${alert.message}`,
          priority: PRIORITY[alert.severity] ?? 0,
        }),
      });
    },
  };
}

/** Telegram: config { botToken, chatId } */
function createTelegramNotifier(logger, opts = {}) {
  const log = logger.child({ component: 'alert-telegram' });
  const apiBase = opts.apiBase || 'https://api.telegram.org';
  const ICON = { error: '🔴', warning: '⚠️', info: 'ℹ️' };
  return {
    name: 'telegram',
    async notify(alert, config = {}) {
      if (!config.botToken || !config.chatId) {
        log.error('Telegram botToken/chatId not configured');
        return false;
      }
      return send(log, 'telegram', `${apiBase}/bot${encodeURIComponent(config.botToken)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: `${ICON[alert.severity] || ''} ${title(alert)}\n[${alert.ruleName}] ${alert.message}`.trim(),
          disable_web_page_preview: true,
        }),
      });
    },
  };
}

module.exports = { createNtfyNotifier, createPushoverNotifier, createTelegramNotifier };
