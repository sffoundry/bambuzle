'use strict';

// Which transport a printer should use, and what it can do (BAM-35, docs/architecture-transports.md).

/**
 * @param {object} conn — from printer-connections.getConnection()
 * @param {boolean} cloudAuthenticated
 * @returns {'cloud'|'lan'|null} null = can't connect yet (cloud printer without a cloud login)
 */
function chooseTransport(conn, cloudAuthenticated) {
  if (!conn || conn.source === 'removed') return null;
  const lanReady = Boolean(conn.lanHost && conn.accessCode);
  if (conn.mode === 'lan') return lanReady ? 'lan' : null;
  if (conn.mode === 'cloud') return cloudAuthenticated ? 'cloud' : null;
  if (lanReady) return 'lan';
  return cloudAuthenticated ? 'cloud' : null;
}

/**
 * Capability summary for the UI/API. `developerMode` comes from the printer's own print.fun bit
 * (src/bambu/diagnostics.js); `signatureRejected` is set once a printer answered "verify failed".
 */
function computeCapabilities({ conn, transport, connected, developerMode, signatureRejected = false, lastError = null }) {
  const base = {
    transport: transport || null,
    connected: Boolean(connected),
    connectionMode: conn?.mode || 'auto',
    lanConfigured: Boolean(conn?.lanHost && conn?.accessCode),
    developerMode: developerMode ?? null,
  };
  if (!transport || !connected) {
    return { ...base, control: 'offline', lastError: lastError || null, controlHint: transport ? (lastError ? `Not connected: ${lastError}` : 'Printer not connected') : connectHint(conn) };
  }
  if (developerMode === true && transport === 'lan') return { ...base, control: 'available', controlHint: null };
  if (developerMode === false || signatureRejected) {
    return {
      ...base,
      control: 'signature_required',
      controlHint: transport === 'lan'
        ? 'Turn on Developer Mode on the printer to allow commands over LAN'
        : 'This printer only accepts commands signed by Bambu\'s apps. Enable Developer Mode and connect over LAN to control it from Bambuzle.',
    };
  }
  if (developerMode === true && transport === 'cloud') {
    // Developer Mode printers are LAN-only; seeing this over cloud means the state is stale
    return { ...base, control: 'signature_required', controlHint: 'Developer Mode printers must be connected over LAN' };
  }
  return { ...base, control: 'unknown', controlHint: 'Firmware did not report its authorization mode — commands will be tried' };
}

function connectHint(conn) {
  if (!conn) return 'Unknown printer';
  if (conn.mode === 'lan') return 'Set the printer IP and LAN access code';
  return 'Log in to BambuLab Cloud, or configure a LAN connection';
}

// ─── Input validation for connection settings ───

const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*$/;
const ACCESS_CODE_RE = /^[A-Za-z0-9]{8}$/; // shown on the printer screen (Settings → LAN / Network)
const SERIAL_RE = /^[A-Za-z0-9]{8,20}$/;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
function validHost(v) {
  if (typeof v !== 'string' || !HOST_RE.test(v)) return false;
  return /^[\d.]+$/.test(v) ? IPV4_RE.test(v) : true; // all-numeric must be a real IPv4
}
function validAccessCode(v) { return typeof v === 'string' && ACCESS_CODE_RE.test(v); }
function validSerial(v) { return typeof v === 'string' && SERIAL_RE.test(v); }

module.exports = { chooseTransport, computeCapabilities, validHost, validAccessCode, validSerial };
