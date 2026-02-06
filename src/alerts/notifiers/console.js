'use strict';

/**
 * Console notifier — logs alerts to stdout via the logger.
 */
function createConsoleNotifier(logger) {
  const log = logger.child({ component: 'alert-console' });

  return {
    name: 'console',
    async notify(alert) {
      log.warn({
        rule: alert.ruleName,
        deviceId: alert.deviceId,
        severity: alert.severity,
        message: alert.message,
      }, `ALERT: ${alert.message}`);
    },
  };
}

module.exports = { createConsoleNotifier };
