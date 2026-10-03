'use strict';

// BAM-16 account APIs. Mounted under /api; roles come from src/server/permissions.js:
//   /api/users/*  admin — manage accounts
//   /api/me/*     any signed-in principal — who am I, change my own password

const express = require('express');
const users = require('../../db/users');
const { audit } = require('../audit');

function handle(res, err) {
  if (err instanceof users.UserError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: 'Internal error' });
}

function createUsersRouter(adminAuth) {
  const router = express.Router();

  router.get('/users', (req, res) => res.json(users.listUsers()));

  router.post('/users', async (req, res) => {
    const { username, password, role } = req.body || {};
    try {
      const u = await users.createUser({ username, password, role });
      audit(req, { action: 'user.create', target: `user:${u.username}`, result: 'ok', detail: { role: u.role } });
      res.status(201).json(u);
    } catch (err) {
      audit(req, { action: 'user.create', target: `user:${String(username || '').slice(0, 32)}`, result: 'rejected', detail: { reason: err.message } });
      handle(res, err);
    }
  });

  router.patch('/users/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { role, disabled, password } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const u = await users.updateUser(id, { role, disabled, password });
      audit(req, { action: 'user.update', target: `user:${u.username}`, result: 'ok',
        detail: { role: role !== undefined ? u.role : undefined, disabled: disabled !== undefined ? u.disabled : undefined, passwordReset: password !== undefined } });
      res.json(u);
    } catch (err) {
      audit(req, { action: 'user.update', target: `user-id:${id}`, result: 'rejected', detail: { reason: err.message } });
      handle(res, err);
    }
  });

  router.delete('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const u = users.getUser(id);
      users.deleteUser(id);
      audit(req, { action: 'user.delete', target: `user:${u?.username || id}`, result: 'ok' });
      res.json({ deleted: id });
    } catch (err) {
      audit(req, { action: 'user.delete', target: `user-id:${id}`, result: 'rejected', detail: { reason: err.message } });
      handle(res, err);
    }
  });

  router.get('/me', (req, res) => {
    const p = adminAuth.getPrincipal(req);
    res.json(p ? { name: p.name, role: p.role, kind: p.kind } : null);
  });

  router.post('/me/password', async (req, res) => {
    const p = adminAuth.getPrincipal(req);
    if (!p || p.kind !== 'user') return res.status(400).json({ error: 'Only user accounts have a password (the admin token is configured on the server)' });
    try {
      await users.changeOwnPassword(p.userId, req.body?.currentPassword, req.body?.newPassword, adminAuth.userSessionToken(req));
      audit(req, { action: 'user.password', target: `user:${p.name}`, result: 'ok' });
      res.json({ ok: true });
    } catch (err) {
      audit(req, { action: 'user.password', target: `user:${p.name}`, result: 'rejected', detail: { reason: err.message } });
      handle(res, err);
    }
  });

  return router;
}

module.exports = { createUsersRouter };
