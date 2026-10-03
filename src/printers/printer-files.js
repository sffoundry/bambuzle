'use strict';

// BAM-44: list and download files from a printer's SD card over implicit FTPS (port 990, user bblp,
// LAN access code) — same TLS policy as LAN MQTT: Bambu CA bundle + identity pinned to the serial.
// Directories follow ha-bambulab (pybambu media_sources, MIT): timelapses in /timelapse, sliced
// prints in /cache/ and /. Some newer models serve media over a different protocol (TCP 6000) instead
// of FTPS — those report files as unavailable rather than guessing.
//
// On Bambu's authorization firmware, FTP may only be open with Developer Mode on (Bambu: Developer
// Mode leaves "MQTT, live stream and FTP open"). We don't assume either way: the first attempt records
// whether access works and the capability says so.

const { Client } = require('basic-ftp');
const { buildConnectOptions } = require('../bambu/mqtt-client');

const FTPS_PORT = 990;
const MEDIA = {
  timelapse: { dirs: ['/timelapse'], exts: ['.mp4', '.avi'] },
  prints: { dirs: ['/cache', '/'], exts: ['.3mf', '.gcode'] },
};
const TIMEOUT_MS = 15000;

/** Only names from the allowed directories, no traversal, sane characters. Exported for tests. */
function safeRemotePath(kind, remotePath) {
  const m = MEDIA[kind];
  if (!m || typeof remotePath !== 'string' || remotePath.length > 300) return null;
  if (remotePath.includes('..') || remotePath.includes('\\') || /[\x00-\x1f]/.test(remotePath)) return null;
  const slash = remotePath.lastIndexOf('/');
  const dir = remotePath.slice(0, slash) || '/';
  const name = remotePath.slice(slash + 1);
  if (!name || !m.dirs.includes(dir === '' ? '/' : dir)) return null;
  if (!m.exts.some((e) => name.toLowerCase().endsWith(e))) return null;
  return remotePath;
}

/** Per-printer FTPS state: one session at a time (printers allow few connections) + last outcome. */
const state = new Map(); // serial -> { busy: Promise|null, status: { ok, at, error, stage } }

function getFilesStatus(serial) {
  return state.get(serial)?.status || null;
}

function setStatus(serial, status) {
  const s = state.get(serial) || {};
  s.status = { ...status, at: new Date().toISOString() };
  state.set(serial, s);
}

/** Serialise FTPS work per printer. */
async function withSession(serial, fn) {
  const s = state.get(serial) || {};
  state.set(serial, s);
  while (s.busy) {
    try { await s.busy; } catch { /* previous failure is its own caller's problem */ }
  }
  let release;
  s.busy = new Promise((r) => { release = r; });
  try {
    return await fn();
  } finally {
    s.busy = null;
    release();
  }
}

function classifyFtpError(err) {
  const code = err?.code;
  if (code === 530) return { stage: 'auth', error: 'Printer refused FTPS login — check the access code (on newer firmware, file access may require Developer Mode)' };
  if (code === 550) return { stage: 'denied', error: 'Printer refused the file operation (550)' };
  if (code === 'ERR_PRINTER_IDENTITY') return { stage: 'identity', error: err.message };
  if (code === 'ECONNREFUSED') return { stage: 'unavailable', error: 'No FTPS service on port 990 — this model may use a newer media protocol, or file access needs Developer Mode' };
  if (['EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET'].includes(code) || /timeout/i.test(err?.message || '')) {
    return { stage: 'unreachable', error: `Can't reach the printer's FTPS service (${code || 'timeout'})` };
  }
  return { stage: 'error', error: err?.message || 'FTPS failed' };
}

/**
 * @param {object} conn — { lanHost, accessCode } (from printer-connections)
 * @param {object} [opts] — { tlsVerify, clientFactory (tests) }
 */
async function openClient(serial, conn, { tlsVerify = true, clientFactory, ca, port } = {}) {
  const client = clientFactory ? clientFactory() : new Client(TIMEOUT_MS);
  // Reuse the LAN MQTT TLS policy (CA bundle, serial-pinned identity, TLS 1.2 max)
  const { options } = buildConnectOptions({ kind: 'lan', deviceId: serial, lan: { host: conn.lanHost, accessCode: conn.accessCode }, tlsVerify });
  await client.access({
    host: conn.lanHost,
    port: port || FTPS_PORT, // port/ca overrides exist only for tests
    user: 'bblp',
    password: conn.accessCode,
    secure: 'implicit',
    secureOptions: {
      ca: ca || options.ca,
      rejectUnauthorized: options.rejectUnauthorized,
      checkServerIdentity: options.checkServerIdentity,
      maxVersion: options.maxVersion,
    },
  });
  return client;
}

/**
 * List media files. Returns [{ path, name, size, modifiedAt }], newest first.
 */
async function listFiles(serial, conn, kind, opts = {}) {
  const media = MEDIA[kind];
  if (!media) throw Object.assign(new Error('Unknown file kind'), { status: 400 });
  return withSession(serial, async () => {
    let client;
    try {
      client = await openClient(serial, conn, opts);
      const files = [];
      for (const dir of media.dirs) {
        let entries;
        try {
          entries = await client.list(dir);
        } catch (err) {
          if (err?.code === 550) continue; // directory doesn't exist on this model/card
          throw err;
        }
        for (const e of entries) {
          if (!e.isFile) continue;
          const path = `${dir === '/' ? '' : dir}/${e.name}`;
          if (!safeRemotePath(kind, path)) continue;
          files.push({ path, name: e.name, size: e.size ?? null, modifiedAt: e.modifiedAt ? e.modifiedAt.toISOString() : (e.rawModifiedAt || null) });
        }
      }
      setStatus(serial, { ok: true, stage: 'ok' });
      files.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
      return files;
    } catch (err) {
      const c = classifyFtpError(err);
      setStatus(serial, { ok: false, ...c });
      throw Object.assign(new Error(c.error), { status: 502, stage: c.stage });
    } finally {
      client?.close();
    }
  });
}

/**
 * Stream one file to `writable` (e.g. the HTTP response). `onSize` is called with the size first.
 */
async function downloadFile(serial, conn, kind, remotePath, writable, { onSize, ...opts } = {}) {
  const path = safeRemotePath(kind, remotePath);
  if (!path) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  return withSession(serial, async () => {
    let client;
    try {
      client = await openClient(serial, conn, opts);
      if (onSize) {
        let size = null;
        try { size = await client.size(path); } catch { /* size is optional */ }
        onSize(size);
      }
      await client.downloadTo(writable, path);
      setStatus(serial, { ok: true, stage: 'ok' });
    } catch (err) {
      const c = classifyFtpError(err);
      setStatus(serial, { ok: false, ...c });
      throw Object.assign(new Error(c.error), { status: err?.code === 550 ? 404 : 502, stage: c.stage });
    } finally {
      client?.close();
    }
  });
}

module.exports = { listFiles, downloadFile, getFilesStatus, safeRemotePath, classifyFtpError, MEDIA, FTPS_PORT };
