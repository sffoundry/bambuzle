'use strict';

const { GCODE_STATE } = require('./constants');

// Bambu reports a user cancel as gcode_state FAILED + print_error 50348044 (see src/bambu/diagnostics.js).
const JOB_END_CANCELLED = 'CANCELLED';

/**
 * end_state to store for a job ending in gcode state `curr`.
 * User cancels become CANCELLED so stats don't count them as failures (review finding 3).
 */
function jobEndState(curr, state) {
  if (curr === GCODE_STATE.FAILED && state?.diagnostics?.printError?.userCancelled) return JOB_END_CANCELLED;
  return curr;
}

module.exports = { jobEndState, JOB_END_CANCELLED };
