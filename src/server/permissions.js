'use strict';

// BAM-16: which role each /api request needs. ONE table, checked centrally by the /api guard, so a new
// route can't be forgotten: anything not listed falls back to viewer for reads and ADMIN for writes.
// Roles: viewer < operator < admin. The admin token (Bearer or token session) acts as admin.

const RANK = { viewer: 1, operator: 2, admin: 3 };

const READ = new Set(['GET', 'HEAD']);

// Ordered — first match wins. `methods` omitted = all methods. Paths are lowercased (Express routing is
// case-insensitive) and matched against baseUrl + path.
const RULES = [
  // Accounts & self-service
  { re: /^\/api\/users(\/|$)/, role: 'admin' },
  { re: /^\/api\/me(\/|$)/, role: 'viewer' },

  // Admin-only reads: secrets, paths, raw payloads, operator history
  { re: /^\/api\/alerts(\/|$)/, role: 'admin' }, // notify_config holds bot tokens / webhook URLs
  { re: /^\/api\/system(\/|$)/, role: 'admin' },
  { re: /^\/api\/audit(\/|$)/, role: 'admin' },
  { re: /\/debug\//, role: 'admin' },
  { re: /^\/api\/printers\/[^/]+\/connection(\/|$)/, role: 'admin' }, // LAN settings + connection tests
  { re: /^\/api\/auth\/status$/, methods: READ, role: 'viewer' },
  { re: /^\/api\/auth(\/|$)/, role: 'admin' }, // BambuLab Cloud login / verify / logout

  // Operator actions
  { re: /^\/api\/printers\/[^/]+\/command$/, role: 'operator' },
  { re: /^\/api\/printers\/[^/]+\/files(\/|$)/, role: 'operator' }, // SD-card listing + downloads
  { re: /^\/api\/maintenance(\/|$)/, methods: READ, role: 'viewer' },
  { re: /^\/api\/maintenance(\/|$)/, role: 'operator' },

  // Adding / removing hand-added printers
  { re: /^\/api\/printers\/?$/, methods: new Set(['POST']), role: 'admin' },
  { re: /^\/api\/printers\/[^/]+\/?$/, methods: new Set(['DELETE']), role: 'admin' },
];

/** @returns {'viewer'|'operator'|'admin'} */
function requiredRole(method, fullPath) {
  const p = String(fullPath || '').toLowerCase();
  const m = String(method || 'GET').toUpperCase();
  for (const r of RULES) {
    if (r.re.test(p) && (!r.methods || r.methods.has(m))) return r.role;
  }
  return READ.has(m) ? 'viewer' : 'admin';
}

function hasRole(role, needed) {
  return (RANK[role] || 0) >= (RANK[needed] || 99);
}

module.exports = { requiredRole, hasRole, RANK };
