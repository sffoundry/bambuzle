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
const BAMBU_SEND_CODE_URL = `${BAMBU_API_BASE}/v1/user-service/user/sendemail/code`;
const BAMBU_PROFILE_URL = `${BAMBU_API_BASE}/v1/user-service/my/profile`;

const BAMBU_CLIENT_HEADERS = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Executable-info': '{}',
  'X-BBL-Agent-OS-Type': 'linux',
};

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
  BAMBU_SEND_CODE_URL,
  BAMBU_PROFILE_URL,
  BAMBU_CLIENT_HEADERS,
  PUSHALL_INTERVAL_MS,
};
