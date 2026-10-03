'use strict';

// BAM-35 (camera capability): is a printer's camera stream reachable on the LAN?
// Detection only. Nothing here streams video or sends the access code. The probe opens a TLS
// connection to the camera port, checks the certificate (Bambu CA + CN == serial, same policy as
// LAN MQTT) and closes it.
//
// Camera protocols by model (as in ha-bambulab pybambu, MIT):
//   X1 / X1C / X1E / H2D / H2S / H2C  RTSPS on 322; only open when "LAN Only Liveview" is on
//   P1P / P1S / A1 / A1MINI           JPEG frames over TLS on 6000
// Checked on hardware 2026-10-03: with liveview off, an H2D and an X1C refuse 322. Port 6000 on both
// presents a printer certificate that verifies against the bundled Bambu CA, CN = serial.

const tls = require('tls');
const { getLanCaBundle, checkPrinterIdentity } = require('../bambu/mqtt-client');
const { validHost } = require('./transport-policy');

const RTSPS = { protocol: 'rtsps', port: 322 };
const JPEG = { protocol: 'jpeg-tls', port: 6000 };
const BY_MODEL = {
  X1: RTSPS, X1C: RTSPS, X1E: RTSPS, H2D: RTSPS, H2S: RTSPS, H2C: RTSPS,
  P1P: JPEG, P1S: JPEG, A1: JPEG, A1MINI: JPEG,
};

const RECHECK_OK_MS = 60 * 60 * 1000;
const RECHECK_FAIL_MS = 10 * 60 * 1000;

function cameraProtocol(modelKey) {
  return BY_MODEL[String(modelKey || '').toUpperCase()] || null;
}

/**
 * One TLS handshake to host:port. Resolves { ok, stage, message }:
 * 'ok' | 'refused' (host up, port closed) | 'unreachable' | 'tls' | 'identity'.
 */
function probeCameraPort({ serial, host, port, timeoutMs = 5000, tlsVerify = true, ca, connectFn = tls.connect }) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, stage: 'unreachable', message: `No answer from port ${port} within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    try {
      sock = connectFn({
        host,
        port,
        ca: tlsVerify ? (ca || getLanCaBundle()) : undefined, // `ca` override: tests only
        rejectUnauthorized: tlsVerify,
        checkServerIdentity: tlsVerify ? (h, cert) => checkPrinterIdentity(serial, h, cert) : () => undefined,
        maxVersion: 'TLSv1.2',
      });
    } catch (err) {
      finish({ ok: false, stage: 'unreachable', message: err.message });
      return;
    }
    sock.once('secureConnect', () => finish({ ok: true, stage: 'ok', message: `Camera port ${port} answers with a verified printer certificate` }));
    sock.once('error', (err) => {
      if (err.code === 'ERR_PRINTER_IDENTITY') return finish({ ok: false, stage: 'identity', message: err.message });
      if (err.code === 'ECONNREFUSED') return finish({ ok: false, stage: 'refused', message: `Port ${port} is closed` });
      if (/CERT|SSL|TLS|VERIFY|SIGNATURE|ISSUER/.test(err.code || '')) return finish({ ok: false, stage: 'tls', message: `Camera port certificate check failed (${err.code})` });
      finish({ ok: false, stage: 'unreachable', message: `${err.code || 'error'} on port ${port}` });
    });
  });
}

/** Turn a probe result + what the printer reports into the capability fields. Exported for tests. */
function cameraCapability({ proto, reported, host, status }) {
  if (reported?.present === false) return { camera: 'none', cameraHint: 'No camera reported by the printer' };
  if (!proto) return { camera: 'unknown', cameraHint: 'Camera protocol for this model is not known yet' };
  const base = { cameraProtocol: proto.protocol };
  if (proto.protocol === 'rtsps' && reported?.lanLiveview === false) {
    return { ...base, camera: 'disabled', cameraHint: 'Turn on "LAN Only Liveview" on the printer to allow a local camera stream' };
  }
  if (!host) return { ...base, camera: 'unknown', cameraHint: 'Printer address not known yet' };
  if (!status) return { ...base, camera: 'unknown', cameraHint: null };
  if (status.ok) return { ...base, camera: 'available', cameraHint: 'Camera stream port is reachable on the LAN (viewing needs the LAN access code)' };
  if (status.stage === 'refused') {
    return { ...base, camera: 'disabled', cameraHint: proto.protocol === 'rtsps'
      ? 'Camera port is closed. Turn on "LAN Only Liveview" on the printer'
      : 'Camera port is closed. Check the printer\'s LAN / liveview settings' };
  }
  return { ...base, camera: 'unreachable', cameraHint: status.message };
}

/**
 * Background detector: probes each printer at most once per RECHECK_* interval, or again as soon
 * as its address or liveview switch changes. One probe per printer at a time.
 * @param {object} [opts]
 * @param {function} [opts.probe] — injectable (tests)
 * @param {boolean} [opts.tlsVerify]
 */
function createCameraMonitor({ probe = probeCameraPort, tlsVerify = true, now = Date.now, onChange = () => {} } = {}) {
  const entries = new Map(); // serial -> { key, at, status, inFlight }

  /**
   * @param {string} serial
   * @param {object} info — { modelKey, host, reported } (reported = diagnostics.camera)
   * @returns capability fields for computeCapabilities
   */
  function check(serial, { modelKey, host, reported }) {
    const proto = cameraProtocol(modelKey);
    const usableHost = host && validHost(host) ? host : null;
    const e = entries.get(serial) || {};
    entries.set(serial, e);
    const key = `${usableHost}|${proto?.port}|${reported?.lanLiveview}`;
    const skip = !proto || !usableHost || reported?.present === false || (proto.protocol === 'rtsps' && reported?.lanLiveview === false);
    if (e.key !== key) { e.key = key; e.status = null; e.at = 0; }
    const age = now() - (e.at || 0);
    const due = !e.status || age >= (e.status.ok ? RECHECK_OK_MS : RECHECK_FAIL_MS);
    if (!skip && due && !e.inFlight) {
      const probedKey = key;
      e.inFlight = Promise.resolve(probe({ serial, host: usableHost, port: proto.port, tlsVerify }))
        .catch((err) => ({ ok: false, stage: 'unreachable', message: err.message }))
        .then((status) => {
          e.inFlight = null;
          if (e.key !== probedKey) return; // settings changed mid-probe — the next check re-probes
          const changed = e.status?.stage !== status.stage;
          e.status = status;
          e.at = now();
          if (changed) onChange(serial);
        });
    }
    return cameraCapability({ proto, reported, host: usableHost, status: e.status });
  }

  function forget(serial) { entries.delete(serial); }

  return { check, forget, _entries: entries };
}

module.exports = { cameraProtocol, probeCameraPort, cameraCapability, createCameraMonitor, RECHECK_OK_MS, RECHECK_FAIL_MS };
