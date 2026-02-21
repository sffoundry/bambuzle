'use strict';

const queries = require('../db/queries');
const { GCODE_STATE } = require('../utils/constants');

class AnomalyDetector {
  constructor(log, config) {
    this.log = log;
    this.thresholds = config.anomaly;
    this.deviceState = {}; // deviceId -> { lastLayerNum, lastLayerTs, lastTemps }
  }

  _getState(deviceId) {
    if (!this.deviceState[deviceId]) {
      this.deviceState[deviceId] = {
        lastLayerNum: null,
        lastLayerTs: null,
        lastTemps: {}, // sensor -> { temp, ts }
      };
    }
    return this.deviceState[deviceId];
  }

  /**
   * Detect layer transitions and record them.
   */
  checkLayerTransition(deviceId, state, activeJob) {
    const layerNum = state.layerNum;
    if (layerNum == null) return;

    const ds = this._getState(deviceId);

    // Skip if unchanged
    if (layerNum === ds.lastLayerNum) return;

    // Backward layer number = new print starting, reset
    if (ds.lastLayerNum !== null && layerNum < ds.lastLayerNum) {
      ds.lastLayerNum = null;
      ds.lastLayerTs = null;
      return;
    }

    const now = Date.now();
    let durationSec = null;
    if (ds.lastLayerTs !== null) {
      durationSec = (now - ds.lastLayerTs) / 1000;
    }

    queries.insertLayerTransition({
      deviceId,
      jobId: activeJob?.id || null,
      layerNum,
      durationSec,
      nozzleTemp: state.nozzleTemp,
      nozzleTarget: state.nozzleTarget,
      bedTemp: state.bedTemp,
      bedTarget: state.bedTarget,
      chamberTemp: state.chamberTemp,
      speedLevel: state.speedLevel,
      progress: state.progress,
    });

    ds.lastLayerNum = layerNum;
    ds.lastLayerTs = now;

    // Update total_layers on the job if available
    if (activeJob && state.totalLayers) {
      queries.updateJobTotalLayers(activeJob.id, state.totalLayers);
    }
  }

  /**
   * Check temperature readings for anomalies (deviation from target, rapid rate of change).
   * Only runs during RUNNING or PAUSE states to avoid false positives during heating ramps.
   */
  checkTemperatureAnomalies(deviceId, state, activeJob) {
    if (state.gcodeState !== GCODE_STATE.RUNNING && state.gcodeState !== GCODE_STATE.PAUSE) {
      return;
    }

    const ds = this._getState(deviceId);
    const now = Date.now();

    const sensors = [
      { name: 'nozzle', actual: state.nozzleTemp, target: state.nozzleTarget },
      { name: 'nozzle2', actual: state.nozzle2Temp, target: state.nozzle2Target },
      { name: 'bed', actual: state.bedTemp, target: state.bedTarget },
      { name: 'chamber', actual: state.chamberTemp, target: null }, // chamber has no target in MQTT
    ];

    for (const sensor of sensors) {
      if (sensor.actual == null) continue;

      const devThreshold = this.thresholds.deviationDeg[sensor.name];
      const rateThreshold = this.thresholds.rateDegPerSec[sensor.name];

      // Calculate deviation (signed: negative=undershoot, positive=overshoot)
      let deviation = null;
      let deviationTriggered = false;
      if (sensor.target != null && sensor.target > 0) {
        deviation = sensor.actual - sensor.target;
        deviationTriggered = Math.abs(deviation) > devThreshold;
      }

      // Calculate rate of change
      let rateOfChange = null;
      let rateTriggered = false;
      const lastReading = ds.lastTemps[sensor.name];
      if (lastReading) {
        const elapsedSec = (now - lastReading.ts) / 1000;
        // Skip rate calc if gap > 60s (avoids false positives after reconnect)
        if (elapsedSec > 0 && elapsedSec <= 60) {
          rateOfChange = (sensor.actual - lastReading.temp) / elapsedSec;
          rateTriggered = Math.abs(rateOfChange) > rateThreshold;
        }
      }

      // Update last reading
      ds.lastTemps[sensor.name] = { temp: sensor.actual, ts: now };

      // Record anomaly if either threshold exceeded
      if (deviationTriggered || rateTriggered) {
        let anomalyType;
        if (deviationTriggered && rateTriggered) anomalyType = 'both';
        else if (deviationTriggered) anomalyType = 'deviation';
        else anomalyType = 'rate';

        queries.insertTempAnomaly({
          deviceId,
          jobId: activeJob?.id || null,
          sensor: sensor.name,
          actualTemp: sensor.actual,
          targetTemp: sensor.target,
          deviation,
          rateOfChange,
          layerNum: state.layerNum,
          anomalyType,
        });

        if (activeJob) {
          queries.incrementJobAnomalyCount(activeJob.id);
        }

        this.log.debug({
          deviceId,
          sensor: sensor.name,
          anomalyType,
          deviation,
          rateOfChange,
        }, 'Temperature anomaly detected');
      }
    }
  }

  /**
   * Record a pause event with context about what caused it.
   */
  handlePause(deviceId, state) {
    const activeJob = queries.getActiveJob(deviceId);
    if (!activeJob) return;

    // Determine pause source: HMS errors active = 'error', otherwise 'user'
    const hmsCodes = state.hmsErrors?.length > 0
      ? state.hmsErrors.map((e) => e.key || e.code || String(e))
      : null;
    const pauseSource = hmsCodes ? 'error' : 'user';

    queries.insertJobPause({
      deviceId,
      jobId: activeJob.id,
      pauseSource,
      layerNum: state.layerNum,
      progress: state.progress,
      hmsCodes,
    });

    queries.incrementJobPauseCount(activeJob.id);
    this.log.info({ deviceId, jobId: activeJob.id, pauseSource }, 'Job paused');
  }

  /**
   * Close an open pause record and accumulate pause duration.
   */
  handleResume(deviceId) {
    const activeJob = queries.getActiveJob(deviceId);
    if (!activeJob) return;

    const durationSec = queries.resumeJobPause(activeJob.id);
    if (durationSec != null) {
      queries.addJobPauseDuration(activeJob.id, durationSec);
      this.log.info({ deviceId, jobId: activeJob.id, durationSec }, 'Job resumed');
    }
  }

  /**
   * Record HMS error codes on the job for later correlation.
   */
  trackJobHmsErrors(deviceId, parsedErrors, activeJob) {
    if (!activeJob) return;
    for (const error of parsedErrors) {
      queries.addJobHmsCode(activeJob.id, error.key);
    }
  }

  /**
   * Clear in-memory tracking state for a device (called on job start).
   */
  resetDevice(deviceId) {
    this.deviceState[deviceId] = {
      lastLayerNum: null,
      lastLayerTs: null,
      lastTemps: {},
    };
  }
}

module.exports = { AnomalyDetector };
