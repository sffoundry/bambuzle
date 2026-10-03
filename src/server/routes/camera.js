'use strict';

// BAM-9 live camera (LAN only). GET /api/printers/:id/camera/stream — role: viewer (permissions.js),
// never anonymous (isPrivateRead). Body depends on the printer's camera protocol:
//   jpeg-tls → multipart/x-mixed-replace MJPEG (an <img> can show it directly)
//   rtsps    → video/mp4: fragmented MP4 (init segment, then one fragment per frame) for Media Source
//              Extensions. MSE works on plain http://<LAN IP>; WebCodecs would need HTTPS.
// Slow viewers: frames are dropped (H.264 resumes at the next keyframe) instead of buffering.
// Long-lived responses re-check the viewer's session every 30 s (BAM-16 revocation).

const express = require('express');
const { hasRole } = require('../permissions');
const { Fmp4Writer } = require('../../printers/fmp4');

const MAX_VIEWERS = 6;
const MAX_BUFFER = 2 * 1024 * 1024;
const RECHECK_MS = Number(process.env.BAMBUZLE_CAMERA_RECHECK_MS) || 30 * 1000; // env: tests only
const BOUNDARY = 'bambuzleframe';

/**
 * @param {object} deps
 * @param {object} deps.printerManager — getCameraTarget(id) → { ok, protocol, host, accessCode } | { ok: false, status, error }
 * @param {object} deps.cameraStreams — from createCameraStreams()
 * @param {object} deps.adminAuth
 */
function createCameraRouter({ printerManager, cameraStreams, adminAuth }) {
  const router = express.Router();

  router.get('/printers/:id/camera/stream', (req, res) => {
    const id = req.params.id;
    const target = printerManager.getCameraTarget?.(id);
    if (!target || !cameraStreams) return res.status(404).json({ error: 'Printer not found' });
    if (!target.ok) return res.status(target.status || 409).json({ error: target.error });
    if (cameraStreams.viewerCount(id) >= MAX_VIEWERS) return res.status(503).json({ error: 'Too many people are watching this camera' });

    const hub = cameraStreams.hubFor(id, target);
    const mjpeg = target.protocol === 'jpeg-tls';
    res.writeHead(200, {
      'Content-Type': mjpeg ? `multipart/x-mixed-replace; boundary=${BOUNDARY}` : 'video/mp4',
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
      Connection: 'close',
    });
    res.flushHeaders?.();

    let waitKey = !mjpeg; // a new H.264 viewer starts at a keyframe (the hub replays the current GOP)
    let ended = false;
    const mp4 = mjpeg ? null : new Fmp4Writer((buf) => res.write(buf));
    const send = (msg) => {
      // Never write after end: an unhandled write-after-end would take the whole process down (review #1)
      if (ended || res.writableEnded || res.destroyed) return;
      if (msg.type === 'end') { finish(); return; } // hub replaced or shut down
      if (mjpeg) {
        if (msg.type !== 'jpeg' || res.writableLength > MAX_BUFFER) return;
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${msg.data.length}\r\n\r\n`);
        res.write(msg.data);
        res.write('\r\n');
        return;
      }
      if (msg.type === 'config') {
        try {
          mp4.config({ avcc: msg.description, sps: msg.sps });
        } catch {
          finish(); // corrupt decoder config from the camera: end this viewer cleanly
          return;
        }
        waitKey = true;
        return;
      }
      if (msg.type !== 'au') return;
      if (res.writableLength > MAX_BUFFER) { waitKey = true; return; } // too slow: skip to the next keyframe
      if (waitKey && !msg.key) return;
      waitKey = false;
      mp4.frame(msg);
    };
    let unsubscribe = () => {};
    let recheck = null;
    function finish() {
      if (ended) return;
      ended = true;
      clearInterval(recheck);
      unsubscribe();
      if (!res.writableEnded) res.end();
    }
    unsubscribe = hub.subscribe(send);
    if (ended) unsubscribe(); // the hub ended us during replay

    recheck = setInterval(() => {
      delete req._principal;
      const p = adminAuth?.getPrincipal(req);
      if (adminAuth?.enabled && (!p || !hasRole(p.role, 'viewer'))) finish(); // revoked / expired / demoted
    }, RECHECK_MS);
    recheck.unref?.();
    req.on('close', finish);
    res.on('close', finish);
    res.on('error', finish);
  });

  return router;
}

module.exports = { createCameraRouter, MAX_VIEWERS };
