'use strict';

/**
 * Webhook notifier — sends HTTP POST to a configured URL.
 * Compatible with Slack/Discord webhook formats.
 */
function createWebhookNotifier(logger) {
  const log = logger.child({ component: 'alert-webhook' });

  return {
    name: 'webhook',
    async notify(alert, config) {
      const url = config.url;
      if (!url) {
        log.error('Webhook URL not configured');
        return;
      }

      const payload = config.format === 'slack'
        ? buildSlackPayload(alert)
        : config.format === 'discord'
          ? buildDiscordPayload(alert)
          : buildGenericPayload(alert);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          log.error({ status: res.status, url }, 'Webhook request failed');
        } else {
          log.info({ url }, 'Webhook sent successfully');
        }
      } catch (err) {
        log.error({ err, url }, 'Webhook request error');
      }
    },
  };
}

function buildGenericPayload(alert) {
  return {
    ruleName: alert.ruleName,
    deviceId: alert.deviceId,
    printerName: alert.printerName,
    severity: alert.severity,
    message: alert.message,
    timestamp: new Date().toISOString(),
  };
}

function buildSlackPayload(alert) {
  const icon = alert.severity === 'error' ? ':red_circle:' : alert.severity === 'warning' ? ':warning:' : ':information_source:';
  return {
    text: `${icon} *Bambuzle Alert — ${alert.printerName || alert.deviceId}*\n${alert.message}`,
  };
}

function buildDiscordPayload(alert) {
  const color = alert.severity === 'error' ? 0xFF0000 : alert.severity === 'warning' ? 0xFFAA00 : 0x0099FF;
  return {
    embeds: [{
      title: `Bambuzle Alert — ${alert.printerName || alert.deviceId}`,
      description: alert.message,
      color,
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Rule', value: alert.ruleName, inline: true },
        { name: 'Severity', value: alert.severity, inline: true },
      ],
    }],
  };
}

module.exports = { createWebhookNotifier };
