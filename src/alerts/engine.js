'use strict';

const queries = require('../db/queries');
const { GCODE_STATE } = require('../utils/constants');
const { createConsoleNotifier } = require('./notifiers/console');
const { createWebhookNotifier } = require('./notifiers/webhook');

class AlertEngine {
  constructor(logger) {
    this.log = logger.child({ component: 'alerts' });
    this.notifiers = {
      console: createConsoleNotifier(logger),
      webhook: createWebhookNotifier(logger),
    };
    // Track previous state per printer for transition detection
    this.prevStates = {};
    // Track progress timestamps for stall detection
    this.progressTimestamps = {}; // { deviceId: { progress, ts } }
  }

  /**
   * Evaluate all enabled alert rules against the current printer state.
   * Called on each state update.
   */
  evaluate(deviceId, state, printerName) {
    const rules = queries.getAllAlertRules().filter(
      (r) => r.enabled && (!r.device_id || r.device_id === deviceId)
    );

    const prev = this.prevStates[deviceId] || {};

    for (const rule of rules) {
      try {
        if (this._isInCooldown(rule)) continue;

        const triggered = this._checkCondition(rule, deviceId, state, prev);
        if (triggered) {
          this._fireAlert(rule, deviceId, printerName, triggered);
        }
      } catch (err) {
        this.log.error({ err, ruleId: rule.id }, 'Error evaluating alert rule');
      }
    }

    // Update previous state and progress tracking
    this.prevStates[deviceId] = { ...state };
    if (state.progress != null) {
      const prevProgress = this.progressTimestamps[deviceId];
      if (!prevProgress || prevProgress.progress !== state.progress) {
        this.progressTimestamps[deviceId] = { progress: state.progress, ts: Date.now() };
      }
    }
  }

  _isInCooldown(rule) {
    if (!rule.last_fired_at) return false;
    const lastFired = new Date(rule.last_fired_at + 'Z').getTime();
    return (Date.now() - lastFired) < (rule.cooldown_sec * 1000);
  }

  _checkCondition(rule, deviceId, state, prev) {
    const config = typeof rule.condition_config === 'string'
      ? JSON.parse(rule.condition_config)
      : rule.condition_config;

    switch (rule.condition_type) {
      case 'state_change':
        return this._checkStateChange(state, prev, config);
      case 'hms_error':
        return this._checkHmsError(state);
      case 'temp_anomaly':
        return this._checkTempAnomaly(state, config);
      case 'temp_threshold':
        return this._checkTempThreshold(state, config);
      case 'progress_stall':
        return this._checkProgressStall(deviceId, state, config);
      default:
        return null;
    }
  }

  _checkStateChange(state, prev, config) {
    if (!prev.gcodeState || state.gcodeState === prev.gcodeState) return null;
    const targetStates = config.states || [GCODE_STATE.FINISH, GCODE_STATE.FAILED];
    if (targetStates.includes(state.gcodeState)) {
      return {
        severity: state.gcodeState === GCODE_STATE.FAILED ? 'error' : 'info',
        message: `Print state changed to ${state.gcodeState}${state.subtaskName ? ` (${state.subtaskName})` : ''}`,
      };
    }
    return null;
  }

  _checkHmsError(state) {
    if (!state.hmsErrors || state.hmsErrors.length === 0) return null;
    // HMS errors present in current state
    return {
      severity: 'error',
      message: `HMS error(s) detected: ${state.hmsErrors.length} active`,
    };
  }

  _checkTempAnomaly(state, config) {
    const threshold = config.deviationDeg || 10;
    const checks = [];

    if (state.nozzleTarget > 0 && state.nozzleTemp != null) {
      const diff = Math.abs(state.nozzleTemp - state.nozzleTarget);
      if (diff > threshold) {
        checks.push(`Nozzle temp ${state.nozzleTemp}°C deviates ${diff.toFixed(1)}°C from target ${state.nozzleTarget}°C`);
      }
    }
    if (state.bedTarget > 0 && state.bedTemp != null) {
      const diff = Math.abs(state.bedTemp - state.bedTarget);
      if (diff > threshold) {
        checks.push(`Bed temp ${state.bedTemp}°C deviates ${diff.toFixed(1)}°C from target ${state.bedTarget}°C`);
      }
    }

    if (checks.length > 0) {
      return { severity: 'warning', message: checks.join('; ') };
    }
    return null;
  }

  _checkTempThreshold(state, config) {
    const { sensor, operator, value } = config;
    if (!sensor || value == null) return null;

    const sensorMap = {
      nozzle: state.nozzleTemp,
      bed: state.bedTemp,
      chamber: state.chamberTemp,
    };
    const actual = sensorMap[sensor];
    if (actual == null) return null;

    const triggered = operator === 'above' ? actual > value : actual < value;
    if (triggered) {
      return {
        severity: 'warning',
        message: `${sensor} temp (${actual}°C) is ${operator} threshold (${value}°C)`,
      };
    }
    return null;
  }

  _checkProgressStall(deviceId, state, config) {
    if (state.gcodeState !== GCODE_STATE.RUNNING) return null;

    const stallMinutes = config.minutes || 15;
    const prev = this.progressTimestamps[deviceId];
    if (!prev) return null;

    const elapsed = (Date.now() - prev.ts) / 60000;
    if (prev.progress === state.progress && elapsed >= stallMinutes) {
      return {
        severity: 'warning',
        message: `Print progress stalled at ${state.progress}% for ${Math.round(elapsed)} minutes`,
      };
    }
    return null;
  }

  async _fireAlert(rule, deviceId, printerName, result) {
    this.log.warn({ ruleId: rule.id, deviceId, message: result.message }, 'Alert fired');

    // Record event
    const activeJob = queries.getActiveJob(deviceId);
    queries.insertEvent({
      deviceId,
      jobId: activeJob?.id || null,
      eventType: 'alert_fired',
      severity: result.severity,
      code: rule.condition_type,
      message: `[${rule.name}] ${result.message}`,
    });

    // Update last fired
    queries.updateAlertRuleFired(rule.id);

    // Send notification
    const notifyVia = rule.notify_via || 'console';
    const notifyConfig = typeof rule.notify_config === 'string'
      ? JSON.parse(rule.notify_config)
      : rule.notify_config;

    const notifier = this.notifiers[notifyVia];
    if (notifier) {
      await notifier.notify({
        ruleName: rule.name,
        deviceId,
        printerName,
        severity: result.severity,
        message: result.message,
      }, notifyConfig);
    }

    return result;
  }

  /**
   * Create default alert rules if none exist.
   */
  ensureDefaults() {
    const existing = queries.getAllAlertRules();
    if (existing.length > 0) return;

    this.log.info('Creating default alert rules');

    queries.createAlertRule({
      name: 'Print Completed',
      conditionType: 'state_change',
      conditionConfig: { states: [GCODE_STATE.FINISH] },
      notifyVia: 'console',
      cooldownSec: 60,
    });

    queries.createAlertRule({
      name: 'Print Failed',
      conditionType: 'state_change',
      conditionConfig: { states: [GCODE_STATE.FAILED] },
      notifyVia: 'console',
      cooldownSec: 60,
    });

    queries.createAlertRule({
      name: 'HMS Error',
      conditionType: 'hms_error',
      conditionConfig: {},
      notifyVia: 'console',
      cooldownSec: 300,
    });
  }
}

module.exports = { AlertEngine };
