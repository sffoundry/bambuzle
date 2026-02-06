'use strict';

/**
 * Build a pushall command — requests the printer to send its full state.
 * Rate-limit to once per 5 min for P1P compatibility.
 */
function buildPushall() {
  return {
    pushing: {
      sequence_id: '0',
      command: 'pushall',
    },
  };
}

/**
 * Build a pause print command.
 */
function buildPause() {
  return {
    print: {
      sequence_id: '0',
      command: 'pause',
    },
  };
}

/**
 * Build a resume print command.
 */
function buildResume() {
  return {
    print: {
      sequence_id: '0',
      command: 'resume',
    },
  };
}

/**
 * Build a stop print command.
 */
function buildStop() {
  return {
    print: {
      sequence_id: '0',
      command: 'stop',
    },
  };
}

/**
 * Build a speed level command.
 * @param {number} level — 1=Silent, 2=Standard, 3=Sport, 4=Ludicrous
 */
function buildSetSpeed(level) {
  return {
    print: {
      sequence_id: '0',
      command: 'print_speed',
      param: String(level),
    },
  };
}

/**
 * Build a gcode line command.
 * @param {string} gcode — raw gcode line(s)
 */
function buildGcodeLine(gcode) {
  return {
    print: {
      sequence_id: '0',
      command: 'gcode_line',
      param: gcode,
    },
  };
}

module.exports = {
  buildPushall,
  buildPause,
  buildResume,
  buildStop,
  buildSetSpeed,
  buildGcodeLine,
};
