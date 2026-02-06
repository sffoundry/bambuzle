'use strict';

const { BAMBU_LOGIN_URL, BAMBU_DEVICES_URL, BAMBU_USER_INFO_URL } = require('../utils/constants');

let cachedAuth = null; // { token, refreshToken, expiresAt, userId }
let pendingVerification = null; // { email, password } when waiting for verify code

/**
 * Current auth status.
 * @returns {'authenticated'|'needs_login'|'needs_verification'}
 */
function getAuthStatus() {
  if (cachedAuth && cachedAuth.expiresAt > Date.now() + 60_000) {
    return 'authenticated';
  }
  if (pendingVerification) {
    return 'needs_verification';
  }
  return 'needs_login';
}

/**
 * Log in to BambuLab cloud API with email/password.
 * Returns auth object on success, or { needsVerification: true } if a code is required.
 */
async function login(email, password) {
  const res = await fetch(BAMBU_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BambuLab login failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.accessToken) {
    if (data.loginType === 'verifyCode') {
      pendingVerification = { email, password };
      return { needsVerification: true };
    }
    throw new Error(`BambuLab login returned unexpected response: ${JSON.stringify(data)}`);
  }

  return finalizeAuth(data);
}

/**
 * Complete the verification-code flow.
 */
async function verifyLogin(code) {
  if (!pendingVerification) {
    throw new Error('No pending verification — call login() first');
  }

  const { email, password } = pendingVerification;

  const res = await fetch(BAMBU_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: email, password, code: String(code).trim() }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Verification failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.accessToken) {
    throw new Error('Verification did not return an access token — code may be incorrect');
  }

  pendingVerification = null;
  return finalizeAuth(data);
}

/**
 * Store the auth response and fetch the real user ID from the preference endpoint.
 */
async function finalizeAuth(data) {
  const token = data.accessToken;

  // Fetch the numeric uid needed for MQTT username
  const userId = await fetchUserId(token);

  cachedAuth = {
    token,
    refreshToken: data.refreshToken || null,
    expiresAt: data.expiresIn
      ? Date.now() + data.expiresIn * 1000
      : Date.now() + 24 * 60 * 60 * 1000,
    userId,
  };
  pendingVerification = null;
  return cachedAuth;
}

/**
 * Fetch the numeric user ID from the BambuLab preference API.
 * This is the uid required for the MQTT username (u_{uid}).
 */
async function fetchUserId(token) {
  const res = await fetch(BAMBU_USER_INFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch user info (${res.status})`);
  }

  const data = await res.json();

  // The preference endpoint returns { uid: <number>, name: ..., ... }
  if (data.uid != null) {
    return String(data.uid);
  }

  throw new Error('User info response missing uid field');
}

/**
 * Get current auth, refreshing if needed.
 */
async function getAuth(config) {
  if (process.env.BAMBU_TOKEN) {
    const token = process.env.BAMBU_TOKEN;
    if (!cachedAuth) {
      const userId = process.env.BAMBU_USER_ID || await fetchUserId(token);
      cachedAuth = {
        token,
        refreshToken: null,
        expiresAt: Infinity,
        userId,
      };
    }
    return cachedAuth;
  }

  if (cachedAuth && cachedAuth.expiresAt > Date.now() + 60_000) {
    return cachedAuth;
  }

  return login(config.bambu.email, config.bambu.password);
}

/**
 * Refresh the auth token.
 */
async function refreshAuth(config) {
  if (process.env.BAMBU_TOKEN) {
    return getAuth(config);
  }
  cachedAuth = null;
  return login(config.bambu.email, config.bambu.password);
}

/**
 * Clear cached auth state (for logout / re-login).
 */
function clearAuth() {
  cachedAuth = null;
  pendingVerification = null;
}

/**
 * Fetch the list of printers bound to this account.
 */
async function getDevices(auth) {
  const res = await fetch(BAMBU_DEVICES_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch devices (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.devices && !data.message) return [];

  return (data.devices || []).map((d) => ({
    deviceId: d.dev_id,
    name: d.name,
    model: d.dev_model_name || d.dev_product_name || 'Unknown',
    nozzleDiameter: d.nozzle_diameter || null,
    online: d.dev_connection_type !== 'unknown',
  }));
}

module.exports = {
  login,
  verifyLogin,
  getAuth,
  refreshAuth,
  getDevices,
  getAuthStatus,
  clearAuth,
};
