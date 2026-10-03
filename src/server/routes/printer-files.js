'use strict';

// SD-card files over FTPS (BAM-44). Admin-guarded under /api; private even with BAMBUZLE_PUBLIC_READ
// (file names can be sensitive). Uses the printer's saved LAN connection — never a host from the request.

const express = require('express');
const path = require('path');
const conns = require('../../db/printer-connections');
const files = require('../../printers/printer-files');
const config = require('../../config');
const { audit } = require('../audit');

const CONTENT_TYPES = { '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', '.gcode': 'text/plain' };

function lanConn(id) {
  const c = conns.getConnection(id);
  if (!c) return { status: 404, error: 'Printer not found' };
  if (!c.lanHost || !c.accessCode) return { status: 409, error: 'Configure a LAN connection (IP + access code) to browse SD-card files' };
  return { conn: c };
}

/** @param {object} [opts] — { fileOps } injectable for tests */
function createPrinterFilesRouter({ fileOps = files } = {}) {
  const router = express.Router();
  const ftpOpts = () => ({ tlsVerify: config.lan.tlsVerify });

  // GET /api/printers/:id/files?kind=timelapse|prints
  router.get('/printers/:id/files', async (req, res) => {
    const kind = req.query.kind || 'timelapse';
    if (!files.MEDIA[kind]) return res.status(400).json({ error: 'kind must be timelapse or prints' });
    const r = lanConn(req.params.id);
    if (r.error) return res.status(r.status).json({ error: r.error });
    try {
      const list = await fileOps.listFiles(req.params.id, r.conn, kind, ftpOpts());
      audit(req, { action: 'printer.files.list', target: req.params.id, result: 'ok', detail: { kind, count: list.length } });
      res.json({ kind, files: list });
    } catch (err) {
      audit(req, { action: 'printer.files.list', target: req.params.id, result: 'error', detail: { kind, stage: err.stage || 'error' } });
      res.status(err.status || 502).json({ error: err.message, stage: err.stage || 'error' });
    }
  });

  // GET /api/printers/:id/files/download?kind=&path=
  router.get('/printers/:id/files/download', async (req, res) => {
    const kind = req.query.kind;
    const remote = files.safeRemotePath(kind, req.query.path);
    if (!remote) return res.status(400).json({ error: 'Invalid file' });
    const r = lanConn(req.params.id);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const name = path.posix.basename(remote).replace(/[^\w.\- ()]/g, '_');
    try {
      await fileOps.downloadFile(req.params.id, r.conn, kind, remote, res, {
        ...ftpOpts(),
        onSize: (size) => {
          res.setHeader('Content-Type', CONTENT_TYPES[path.posix.extname(name).toLowerCase()] || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          res.setHeader('Cache-Control', 'no-store');
          if (Number.isFinite(size) && size > 0) res.setHeader('Content-Length', String(size));
        },
      });
      if (!res.writableEnded) res.end();
      audit(req, { action: 'printer.files.download', target: req.params.id, result: 'ok', detail: { kind, file: name } });
    } catch (err) {
      audit(req, { action: 'printer.files.download', target: req.params.id, result: 'error', detail: { kind, file: name, stage: err.stage || 'error' } });
      if (res.headersSent) return res.destroy(err); // mid-stream failure: abort so the browser sees an error
      // Failed before any bytes: drop the file headers onSize set, or the JSON error is saved as "a.mp4" (#8)
      for (const h of ['Content-Disposition', 'Content-Length', 'Content-Type']) res.removeHeader(h);
      res.status(err.status || 502).json({ error: err.message, stage: err.stage || 'error' });
    }
  });

  return router;
}

module.exports = { createPrinterFilesRouter };
