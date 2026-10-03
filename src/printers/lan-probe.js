'use strict';

// One-shot LAN connection test for the settings UI (BAM-35): connect, wait for the first status report,
// and say exactly which stage failed. Never sends commands (only the pushall status request).

const { MqttPrinterClient } = require('../bambu/mqtt-client');

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const NET_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);

/** Map a connection error to a stage + human message. Exported for tests. */
function classifyError(err, host) {
  const code = err?.code;
  if (code === 'ERR_PRINTER_IDENTITY') return { stage: 'identity', message: err.message };
  if (TLS_CODES.has(code)) return { stage: 'tls', message: `TLS certificate check failed (${code}) — not a Bambu printer, or an unknown Bambu CA` };
  if (NET_CODES.has(code)) return { stage: 'unreachable', message: `Can't reach ${host}:8883 (${code}) — check the IP and that LAN access is enabled on the printer` };
  if (code === 4 || code === 5 || code === 134 || code === 135 || /not authori[sz]ed|bad user ?name or password/i.test(err?.message || '')) {
    return { stage: 'auth', message: 'Printer refused the access code — re-check it on the printer screen' };
  }
  return { stage: 'error', message: err?.message || 'Connection failed' };
}

/**
 * @returns {Promise<{ ok, stage, message, developerMode?, model? }>}
 */
function probeLan({ serial, host, accessCode, tlsVerify = true, timeoutMs = 10000, logger, connectFn }) {
  return new Promise((resolve) => {
    const client = new MqttPrinterClient({ deviceId: serial, kind: 'lan', lan: { host, accessCode }, tlsVerify, reconnect: false, logger, connectFn });
    let done = false;
    let connected = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(connected
      ? { ok: true, stage: 'connected', message: 'Connected, but the printer sent no status yet', developerMode: null }
      : { ok: false, stage: 'unreachable', message: `No answer from ${host}:8883 within ${Math.round(timeoutMs / 1000)}s — check the IP; printers also throttle rapid reconnects, so wait a minute and retry` }), timeoutMs);
    client.on('connected', () => { connected = true; });
    client.on('state', (_id, state) => finish({
      ok: true,
      stage: 'connected',
      message: 'Connected and receiving status',
      developerMode: state.diagnostics?.developerMode ?? null,
    }));
    client.on('mqtt_error', (_id, err) => finish({ ok: false, ...classifyError(err, host) }));
    client.connect();
  });
}

module.exports = { probeLan, classifyError };
