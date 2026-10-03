'use strict';

// BAM-16: per-user accounts and server-side sessions.
// - Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte random salt), verified in constant time.
// - Sessions: a random 32-byte token goes in the cookie; only its SHA-256 is stored, so a leaked
//   database or backup doesn't hand out live sessions. Sessions are revoked on sign-out, password
//   change, role change, disable and delete.
// Self-creating tables (same pattern as audit/ams-humidity).

const crypto = require('crypto');
const { promisify } = require('util');
const { getDb } = require('./database');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const ROLES = ['viewer', 'operator', 'admin'];
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const MIN_PASSWORD = 10;

let ensured = false;
function db() {
  const d = getDb();
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        username_lc TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,           -- sha256(token), base64url
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    `);
    ensured = true;
  }
  return d;
}

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateUsername(u) {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) throw new UserError('Username: 2–32 letters, digits, dot, dash or underscore');
  return u;
}

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD || p.length > 256) throw new UserError(`Password must be ${MIN_PASSWORD}–256 characters`);
  return p;
}

function validateDisabled(d) {
  if (typeof d !== 'boolean') throw new UserError('disabled must be true or false');
  return d;
}

function validateRole(r) {
  if (!ROLES.includes(r)) throw new UserError(`Role must be one of ${ROLES.join(', ')}`);
  return r;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

// A fixed dummy hash so unknown usernames cost the same as wrong passwords (no user enumeration by timing)
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('bambuzle-dummy-password');
  await verifyPassword(password, dummyHash);
}

const publicUser = (u) => u && ({ id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), createdAt: u.created_at, lastLoginAt: u.last_login_at });

function countUsers() {
  return db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function countActiveAdmins(excludeId = null) {
  return db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(excludeId ?? -1).n;
}

function listUsers() {
  return db().prepare('SELECT * FROM users ORDER BY username_lc').all().map(publicUser);
}

function getUser(id) {
  return publicUser(db().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

async function createUser({ username, password, role }) {
  validateUsername(username);
  validatePassword(password);
  validateRole(role);
  if (usernameExists(username)) throw new UserError('A user with this name already exists', 409);
  const hash = await hashPassword(password);
  try {
    const r = db().prepare('INSERT INTO users (username, username_lc, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(username, username.toLowerCase(), hash, role);
    return getUser(r.lastInsertRowid);
  } catch (err) {
    // A concurrent create of the same name won the race while we were hashing
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UserError('A user with this name already exists', 409);
    throw err;
  }
}

function usernameExists(username) {
  return typeof username === 'string' && Boolean(db().prepare('SELECT 1 FROM users WHERE username_lc = ?').get(username.toLowerCase()));
}

/** Credential check. Returns the public user or null (same timing for unknown user / wrong password / disabled). */
async function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) {
    await burnTime('x');
    return null;
  }
  const u = db().prepare('SELECT * FROM users WHERE username_lc = ?').get(username.toLowerCase());
  if (!u) {
    await burnTime(password);
    return null;
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok || u.disabled) return null;
  db().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  return publicUser(u);
}

/** Admin edits. Guards against removing the last active admin. Revokes the user's sessions on any change. */
async function updateUser(id, { role, disabled, password }) {
  if (role !== undefined) validateRole(role);
  if (disabled !== undefined) validateDisabled(disabled);
  // Hash BEFORE the check-and-write: the last-admin check and the UPDATE must not have an await between
  // them, or two concurrent demotions can each see the other admin and leave none (review finding).
  const newHash = password !== undefined ? await hashPassword(validatePassword(password)) : null;
  db().transaction(() => {
    const u = db().prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new UserError('User not found', 404);
    const nextRole = role ?? u.role;
    const nextDisabled = disabled ?? Boolean(u.disabled);
    const losesAdmin = u.role === 'admin' && !u.disabled && (nextRole !== 'admin' || nextDisabled);
    if (losesAdmin && countActiveAdmins(u.id) === 0) throw new UserError('Can\'t demote or disable the last active admin', 409);
    db().prepare('UPDATE users SET role = ?, disabled = ?, password_hash = ? WHERE id = ?').run(nextRole, nextDisabled ? 1 : 0, newHash ?? u.password_hash, id);
    revokeUserSessions(id);
  })();
  return getUser(id);
}

function deleteUser(id) {
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new UserError('User not found', 404);
  if (u.role === 'admin' && !u.disabled && countActiveAdmins(u.id) === 0) throw new UserError('Can\'t delete the last active admin', 409);
  db().prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade
  revokeUserSessions(id); // explicit too, in case foreign_keys is off
}

/** Self-service password change: needs the current password; revokes other sessions. */
async function changeOwnPassword(id, current, next, keepSessionToken) {
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u || !(await verifyPassword(String(current ?? ''), u.password_hash))) throw new UserError('Current password is incorrect', 403);
  const hash = await hashPassword(validatePassword(next));
  db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  const keep = keepSessionToken ? hashToken(keepSessionToken) : '';
  db().prepare('DELETE FROM user_sessions WHERE user_id = ? AND id != ?').run(id, keep);
}

// ─── Sessions ───

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
  db().prepare('INSERT INTO user_sessions (id, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, datetime(\'now\'))').run(hashToken(token), userId, expires);
  return { token, maxAgeSec: SESSION_DAYS * 86400 };
}

/** Session token → active, non-disabled user, or null. */
function sessionUser(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db().prepare(`
    SELECT u.*, s.id AS sid, s.last_seen_at FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.disabled = 0
  `).get(hashToken(token));
  if (!row) return null;
  // touch at most once a minute
  if (!row.last_seen_at || Date.parse(row.last_seen_at.replace(' ', 'T') + 'Z') < Date.now() - 60e3) {
    db().prepare("UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(row.sid);
  }
  return publicUser(row);
}

function deleteSession(token) {
  if (typeof token === 'string') db().prepare('DELETE FROM user_sessions WHERE id = ?').run(hashToken(token));
}

function revokeUserSessions(userId) {
  db().prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

function pruneExpiredSessions() {
  return db().prepare("DELETE FROM user_sessions WHERE expires_at <= datetime('now')").run().changes;
}

module.exports = {
  ROLES, UserError, MIN_PASSWORD,
  countUsers, listUsers, usernameExists, getUser, createUser, updateUser, deleteUser, authenticate, changeOwnPassword,
  createSession, sessionUser, deleteSession, revokeUserSessions, pruneExpiredSessions,
  hashPassword, verifyPassword,
};
