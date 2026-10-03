'use strict';

// BAM-28: which commands make sense in which printer state, and how to build them.
// Rejecting e.g. "stop" on an idle printer protects against stale UIs and replayed requests.

const { buildPause, buildResume, buildStop, buildSetSpeed } = require('../bambu/commands');
const { GCODE_STATE } = require('../utils/constants');

const ACTIVE = [GCODE_STATE.RUNNING, GCODE_STATE.PAUSE, GCODE_STATE.PREPARE];

const COMMANDS = {
  pause: { allowed: [GCODE_STATE.RUNNING, GCODE_STATE.PREPARE], build: (seq) => buildPause(seq) },
  resume: { allowed: [GCODE_STATE.PAUSE], build: (seq) => buildResume(seq) },
  stop: { allowed: ACTIVE, build: (seq) => buildStop(seq) },
  set_speed: { allowed: ACTIVE, build: (seq, level) => buildSetSpeed(level, seq) },
};

const SPEED_LEVELS = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };

let nextSeq = Math.floor(Math.random() * 1e6);

/**
 * @returns {{ status: number, error: string } | { cmd: object, label: string }}
 */
function planCommand(command, param, liveState) {
  const spec = COMMANDS[command];
  if (!spec) return { status: 400, error: `Unknown command: ${command}` };

  let level;
  if (command === 'set_speed') {
    level = Number(param);
    if (!Number.isInteger(level) || !SPEED_LEVELS[level]) {
      return { status: 400, error: 'set_speed needs param 1–4 (Silent, Standard, Sport, Ludicrous)' };
    }
  }

  const state = liveState?.gcodeState || GCODE_STATE.UNKNOWN;
  if (!spec.allowed.includes(state)) {
    return { status: 409, error: `Cannot ${command.replace('_', ' ')} while printer is ${state}` };
  }

  nextSeq = (nextSeq + 1) % 1e9;
  const label = command === 'set_speed' ? `set speed ${SPEED_LEVELS[level]}` : command;
  return { cmd: spec.build(String(nextSeq), level), label };
}

module.exports = { planCommand, SPEED_LEVELS };
