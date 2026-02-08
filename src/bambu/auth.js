'use strict';

const {
  BAMBU_LOGIN_URL,
  BAMBU_TOKEN_URL,
  BAMBU_DEVICES_URL,
  BAMBU_USER_INFO_URL,
  BAMBU_SEND_CODE_URL,
  BAMBU_PROFILE_URL,
  BAMBU_CLIENT_HEADERS,
} = require('../utils/constants');
const { saveAuthToken, getAuthToken, deleteAuthToken } = require('../db/queries');

let cachedAuth = null; // { token, refreshToken, expiresAt, userId }
let pendingVerification = null; // { email } when waiting for verify code

/**
 * Build headers for BambuLab API requests.
 */
function buildHeaders(includeAuth, token) {
  const headers = {
    'Content-Type': 'application/json',
    ...BAMBU_CLIENT_HEADERS,
  };
  if (includeAuth && token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

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
    headers: buildHeaders(),
    body: JSON.stringify({ account: email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BambuLab login failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.accessToken) {
    if (data.loginType === 'verifyCode') {
      await sendVerificationCode(email);
      pendingVerification = { email };
      return { needsVerification: true };
    }
    throw new Error(`BambuLab login returned unexpected response: ${JSON.stringify(data)}`);
  }

  return finalizeAuth(data);
}

/**
 * Request BambuLab to send the verification code email.
 */
async function sendVerificationCode(email) {
  const res = await fetch(BAMBU_SEND_CODE_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ email, type: 'codeLogin' }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to send verification code (${res.status}): ${text}`);
  }
}

/**
 * Complete the verification-code flow.
 */
async function verifyLogin(code) {
  if (!pendingVerification) {
    throw new Error('No pending verification — call login() first');
  }

  const { email } = pendingVerification;

  const res = await fetch(BAMBU_LOGIN_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ account: email, code: String(code).trim() }),
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
 * Store the auth response, fetch user ID, and persist token to DB.
 */
async function finalizeAuth(data) {
  const token = data.accessToken;

  // Fetch the numeric uid needed for MQTT username
  const userId = await fetchUserId(token);

  const expiresAt = data.expiresIn
    ? Date.now() + data.expiresIn * 1000
    : Date.now() + 24 * 60 * 60 * 1000;

  cachedAuth = {
    token,
    refreshToken: data.refreshToken || null,
    expiresAt,
    userId,
  };
  pendingVerification = null;

  // Persist to DB for cross-restart survival
  try {
    saveAuthToken({
      token,
      refreshToken: data.refreshToken || null,
      userId,
      expiresAt,
    });
  } catch (err) {
    console.error('[auth] Failed to persist token to DB:', err.message);
  }

  return cachedAuth;
}

/**
 * Fetch the numeric user ID from the BambuLab preference API.
 * This is the uid required for the MQTT username (u_{uid}).
 */
async function fetchUserId(token) {
  const res = await fetch(BAMBU_USER_INFO_URL, {
    headers: buildHeaders(true, token),
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
 * Verify a token is still valid by calling the profile endpoint.
 */
async function verifyToken(token) {
  try {
    const res = await fetch(BAMBU_PROFILE_URL, {
      headers: buildHeaders(true, token),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Attempt to refresh using a refresh token.
 * Returns response data or null on failure.
 */
async function refreshTokenCall(refreshToken) {
  try {
    const res = await fetch(BAMBU_TOKEN_URL, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get current auth, with priority chain:
 * 1. BAMBU_TOKEN env var
 * 2. In-memory cache (if not expired)
 * 3. DB persisted token (verify, then refresh if needed)
 * 4. Fall back to login()
 */
async function getAuth(config) {
  // 1. Env var override
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

  // 2. In-memory cache
  if (cachedAuth && cachedAuth.expiresAt > Date.now() + 60_000) {
    return cachedAuth;
  }

  // 3. DB persisted token
  try {
    const stored = getAuthToken();
    if (stored) {
      // Check if not expired
      if (stored.expires_at > Date.now() + 60_000) {
        const valid = await verifyToken(stored.token);
        if (valid) {
          cachedAuth = {
            token: stored.token,
            refreshToken: stored.refresh_token,
            expiresAt: stored.expires_at,
            userId: stored.user_id,
          };
          console.log('[auth] Restored token from database');
          return cachedAuth;
        }
      }

      // Token expired or invalid — try refresh
      if (stored.refresh_token) {
        console.log('[auth] Stored token invalid, attempting refresh...');
        const refreshData = await refreshTokenCall(stored.refresh_token);
        if (refreshData && refreshData.accessToken) {
          return finalizeAuth(refreshData);
        }
      }

      // Refresh failed — clean up stale token
      console.log('[auth] Stored token could not be refreshed, clearing');
      deleteAuthToken();
    }
  } catch (err) {
    console.error('[auth] Error loading persisted token:', err.message);
  }

  // 4. Fall back to login
  return login(config.bambu.email, config.bambu.password);
}

/**
 * Refresh the auth token using refresh token or re-login.
 */
async function refreshAuth(config) {
  if (process.env.BAMBU_TOKEN) {
    return getAuth(config);
  }

  // Try refresh token from cache or DB
  const rt = cachedAuth?.refreshToken;
  if (rt) {
    const refreshData = await refreshTokenCall(rt);
    if (refreshData && refreshData.accessToken) {
      return finalizeAuth(refreshData);
    }
  }

  // Try DB stored refresh token
  try {
    const stored = getAuthToken();
    if (stored && stored.refresh_token) {
      const refreshData = await refreshTokenCall(stored.refresh_token);
      if (refreshData && refreshData.accessToken) {
        return finalizeAuth(refreshData);
      }
    }
  } catch (err) {
    console.error('[auth] Error loading stored refresh token:', err.message);
  }

  // Fall back to full re-login
  cachedAuth = null;
  return login(config.bambu.email, config.bambu.password);
}

/**
 * Clear cached auth state and DB token (for logout / re-login).
 */
function clearAuth() {
  cachedAuth = null;
  pendingVerification = null;
  try {
    deleteAuthToken();
  } catch (err) {
    console.error('[auth] Error clearing persisted token:', err.message);
  }
}

/**
 * Fetch the list of printers bound to this account.
 */
async function getDevices(auth) {
  const res = await fetch(BAMBU_DEVICES_URL, {
    method: 'GET',
    headers: buildHeaders(true, auth.token),
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
