'use strict';

// Failure counters for sign-in and password checks (BAM-30/BAM-16).
// Attempts are reserved BEFORE the slow (scrypt) check, so a parallel burst can't slip past the limit
// while every request is still hashing; a success releases its reservation.

const WINDOW_MS = 5 * 60 * 1000;

function createLimiter({ max = 10, windowMs = WINDOW_MS } = {}) {
  const attempts = new Map(); // key -> [timestamps]

  function recent(key, now = Date.now()) {
    const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) attempts.set(key, list);
    else attempts.delete(key);
    return list;
  }

  function blocked(...keys) {
    return keys.some((k) => k && recent(k).length >= max);
  }

  /** Count an attempt now; returns a release() that un-counts it (call on success). */
  function reserve(...keys) {
    const now = Date.now();
    const live = keys.filter(Boolean);
    for (const k of live) attempts.set(k, [...recent(k, now), now]);
    if (attempts.size > 1000) for (const k of attempts.keys()) recent(k, now); // bound memory
    return () => {
      for (const k of live) {
        const list = attempts.get(k);
        const i = list ? list.indexOf(now) : -1;
        if (i >= 0) list.splice(i, 1);
      }
    };
  }

  return { blocked, reserve, max, reset: () => attempts.clear() };
}

module.exports = { createLimiter, WINDOW_MS };
