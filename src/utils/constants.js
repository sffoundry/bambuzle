'use strict';

const GCODE_STATE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSE: 'PAUSE',
  FINISH: 'FINISH',
  FAILED: 'FAILED',
  PREPARE: 'PREPARE',
  SLICING: 'SLICING',
  UNKNOWN: 'UNKNOWN',
};

// Map raw values to normalized states
const GCODE_STATE_MAP = {
  IDLE: GCODE_STATE.IDLE,
  RUNNING: GCODE_STATE.RUNNING,
  PAUSE: GCODE_STATE.PAUSE,
  FINISH: GCODE_STATE.FINISH,
  FAILED: GCODE_STATE.FAILED,
  PREPARE: GCODE_STATE.PREPARE,
  SLICING: GCODE_STATE.SLICING,
};

const SPEED_LEVELS = {
  1: 'Silent',
  2: 'Standard',
  3: 'Sport',
  4: 'Ludicrous',
};

const MQTT_BROKER = 'mqtts://us.mqtt.bambulab.com:8883';
const BAMBU_API_BASE = 'https://api.bambulab.com';
const BAMBU_LOGIN_URL = `${BAMBU_API_BASE}/v1/user-service/user/login`;
const BAMBU_TOKEN_URL = `${BAMBU_API_BASE}/v1/user-service/user/refreshtoken`;
const BAMBU_DEVICES_URL = `${BAMBU_API_BASE}/v1/iot-service/api/user/bind`;
const BAMBU_USER_INFO_URL = `${BAMBU_API_BASE}/v1/design-user-service/my/preference`;

const PUSHALL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum between pushall

module.exports = {
  GCODE_STATE,
  GCODE_STATE_MAP,
  SPEED_LEVELS,
  MQTT_BROKER,
  BAMBU_API_BASE,
  BAMBU_LOGIN_URL,
  BAMBU_TOKEN_URL,
  BAMBU_DEVICES_URL,
  BAMBU_USER_INFO_URL,
  PUSHALL_INTERVAL_MS,
};
