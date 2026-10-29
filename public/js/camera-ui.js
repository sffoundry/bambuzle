// BAM-9 live camera viewer. LAN only; the server holds the printer's access code.
//   jpeg-tls (P1/A1): MJPEG — shown directly in an <img>
//   rtsps (X1/H2):    fragmented MP4 (src/server/routes/camera.js) played via Media Source Extensions
// DOM via textContent only.

import { openModal } from './connection-ui.js';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...children);
  return n;
}

const streamUrl = (id) => `/api/printers/${encodeURIComponent(id)}/camera/stream`;

/** Why a stream request failed (the server answers JSON for errors). */
async function streamError(id) {
  const ac = new AbortController();
  try {
    const r = await fetch(streamUrl(id), { signal: ac.signal });
    if (r.ok) { ac.abort(); return null; }
    return (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
  } catch {
    return 'Camera stream could not be opened';
  }
}

// `onEnd` (optional): called once when the stream stops on its own (error or end), not when closed by the caller.
function showMjpeg(id, stage, status, { onEnd } = {}) {
  const img = el('img', { class: 'camera-view', alt: 'Live camera' });
  let closed = false;
  img.addEventListener('load', () => { status.textContent = ''; }, { once: true });
  img.addEventListener('error', async () => {
    if (closed) return; // closing swaps the src, which fires error — don't open a new stream to explain it
    const why = await streamError(id);
    if (closed) return;
    status.textContent = why || 'Camera stream ended';
    onEnd?.();
  });
  img.src = streamUrl(id);
  stage.append(img);
  status.textContent = 'Connecting…';
  return () => { closed = true; img.removeAttribute('src'); img.src = 'data:,'; img.remove(); };
}

/** Codec string from the init segment's avcC box (profile, compatibility, level). */
function codecFromInit(bytes) {
  for (let i = 4; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x43) { // 'avcC'
      return `avc1.${[bytes[i + 5], bytes[i + 6], bytes[i + 7]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return null;
}

/** Length of the leading ftyp+moov (init segment) once complete, else 0. */
function initLength(bytes) {
  let off = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 8 <= bytes.length) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (size < 8 || off + size > bytes.length) return 0;
    off += size;
    if (type === 'moov') return off;
  }
  return 0;
}

/** X1 / H2: fragmented MP4 via Media Source Extensions (works on plain http://, unlike WebCodecs). */
function showMse(id, stage, status, { onEnd } = {}) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) {
    status.textContent = 'This browser can\'t play the camera stream (no Media Source Extensions).';
    if (onEnd) queueMicrotask(onEnd); // after the caller has stored the returned stop function
    return () => {};
  }
  const video = el('video', { class: 'camera-view', muted: '', autoplay: '', playsinline: '' });
  video.muted = true;
  video.disableRemotePlayback = true;
  stage.append(video);
  const ac = new AbortController();
  const ms = new MS();
  let closed = false;
  video.src = URL.createObjectURL(ms);
  status.textContent = 'Connecting…';

  ms.addEventListener('sourceopen', async () => {
    let res;
    try {
      res = await fetch(streamUrl(id), { signal: ac.signal });
    } catch {
      if (!closed) { status.textContent = 'Camera stream could not be opened'; onEnd?.(); }
      return;
    }
    if (!res.ok) {
      const why = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
      if (!closed) { status.textContent = why; onEnd?.(); }
      return;
    }
    const reader = res.body.getReader();
    let head = new Uint8Array(0);
    let sb = null;
    const queue = [];
    const pump = () => {
      if (!sb || sb.updating || !queue.length || ms.readyState !== 'open') return;
      try {
        // Stay live: drop what's more than ~30 s behind, and jump forward if playback lags
        const b = sb.buffered;
        if (b.length && video.currentTime - b.start(0) > 30) { sb.remove(b.start(0), video.currentTime - 10); return; }
        if (b.length && b.end(b.length - 1) - video.currentTime > 2) video.currentTime = b.end(b.length - 1) - 0.3;
        sb.appendBuffer(queue[0]);
        queue.shift(); // only once accepted: a QuotaExceededError keeps the chunk for the retry
      } catch (e) {
        if (e.name === 'QuotaExceededError' && sb.buffered.length && video.currentTime - sb.buffered.start(0) > 1) {
          sb.remove(sb.buffered.start(0), video.currentTime - 1); // make room; updateend retries the append
        } else {
          status.textContent = `Playback error: ${e.message}`;
        }
      }
    };
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      if (!sb) {
        const merged = new Uint8Array(head.length + chunk.value.length);
        merged.set(head);
        merged.set(chunk.value, head.length);
        head = merged;
        if (!initLength(head)) continue;
        const codec = codecFromInit(head) || 'avc1.640028';
        const mime = `video/mp4; codecs="${codec}"`;
        if (!MS.isTypeSupported(mime)) { status.textContent = `This browser can't play ${codec} video.`; ac.abort(); onEnd?.(); return; }
        sb = ms.addSourceBuffer(mime);
        sb.mode = 'segments';
        sb.addEventListener('updateend', () => {
          pump();
          if (video.paused && sb.buffered.length) video.play().then(() => { status.textContent = ''; }).catch(() => {});
        });
        queue.push(head);
      } else {
        queue.push(chunk.value);
      }
      pump();
    }
    if (!closed) { status.textContent = onEnd ? 'Camera stream ended' : 'Camera stream ended — close and reopen to retry'; onEnd?.(); }
  }, { once: true });

  // Stall watchdog: playback stuck while video is buffered ahead → skip to just behind the live edge
  let lastT = -1;
  const watchdog = setInterval(() => {
    const b = video.buffered;
    if (!b.length || video.paused) return;
    const end = b.end(b.length - 1);
    if (video.currentTime === lastT && end - video.currentTime > 0.5) video.currentTime = end - 0.2;
    lastT = video.currentTime;
  }, 500);

  return () => {
    closed = true;
    clearInterval(watchdog);
    ac.abort();
    try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* closing */ }
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  };
}

/** Open the live view. `protocol` is capabilities.cameraProtocol. */
export function openCameraDialog(deviceId, printerName, protocol) {
  let stop = () => {};
  return openModal(`Camera — ${printerName}`, (box, close) => {
    box.classList.add('camera-dialog-content');
    const stage = el('div', { class: 'camera-stage' });
    const status = el('div', { class: 'camera-status', role: 'status' });
    const closeBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Close' });
    closeBtn.addEventListener('click', () => close(true));
    const full = el('button', { type: 'button', class: 'btn-secondary', text: 'Full screen' });
    full.addEventListener('click', () => stage.requestFullscreen?.().catch(() => {}));
    box.append(stage, status, el('p', { class: 'conn-intro', text: 'Live from the printer over your local network.' }), el('div', { class: 'form-actions' }, full, closeBtn));
    stop = protocol === 'rtsps' ? showMse(deviceId, stage, status) : showMjpeg(deviceId, stage, status);
  }).finally(() => stop());
}

// ─── BAM-52: dashboard camera widget ───
// Shown when the dashboard filter is one specific printer whose camera is live. The stream starts by
// default; Stop only affects this tab and isn't remembered (a reload or a new selection starts it again).
// Leaving the Dashboard view disconnects without counting as a Stop.

const cam = {
  deviceId: null, // printer the widget is showing
  live: false, // that printer's capabilities.cameraLive
  protocol: null,
  hint: null, // why the camera isn't available (capabilities.cameraHint / offline)
  userStopped: false,
  enabled: true, // Configuration → Camera Widget
  viewActive: true, // Dashboard view is showing
  stop: null, // closes the running stream, or null when none
};

function camEls() {
  return {
    box: document.getElementById('camera-widget'),
    stage: document.getElementById('camera-widget-stage'),
    status: document.getElementById('camera-widget-status'),
    toggle: document.getElementById('camera-widget-toggle'),
    full: document.getElementById('camera-widget-full'),
  };
}

function stopStream() {
  const stop = cam.stop;
  cam.stop = null;
  stop?.();
  const { stage } = camEls();
  stage?.replaceChildren();
}

function startStream() {
  const { stage, status } = camEls();
  if (!stage || cam.stop) return;
  stage.replaceChildren(); // the last frame of a stream that ended on its own
  const onEnd = () => { cam.stop?.(); cam.stop = null; syncButtons(); };
  const show = cam.protocol === 'rtsps' ? showMse : showMjpeg;
  cam.stop = show(cam.deviceId, stage, status, { onEnd });
}

function syncButtons() {
  const { toggle, full } = camEls();
  if (!toggle) return;
  toggle.hidden = !cam.live;
  full.hidden = !cam.stop;
  toggle.textContent = cam.stop ? 'Stop' : 'Start';
}

/** Bring the widget in line with `cam` (idempotent; called on every relevant change). */
function syncCamera() {
  const { box, status } = camEls();
  if (!box) return;
  const shown = cam.enabled && Boolean(cam.deviceId);
  box.classList.toggle('hidden', !shown);
  const want = shown && cam.viewActive && cam.live && !cam.userStopped;
  if (!want && cam.stop) stopStream();
  if (!shown) return;
  if (want) startStream();
  else if (!cam.live) status.textContent = cam.hint || 'Live camera isn\'t available for this printer';
  else if (cam.userStopped) status.textContent = 'Stopped';
  syncButtons();
}

/** One specific printer selected on the dashboard → its id; "All Printers" or none → null. */
function selectedPrinter(dashFilters) {
  const id = dashFilters?.printer;
  return id && id !== '__all__' ? id : null;
}

/** Re-read the selected printer's camera state. `printers`: deviceId → { capabilities, connected, … } */
export function renderCameraWidget(printers, dashFilters) {
  const id = selectedPrinter(dashFilters);
  const caps = (id && printers[id]?.capabilities) || {};
  const live = Boolean(id && printers[id]?.connected !== false && caps.cameraLive);
  const protocol = caps.cameraProtocol || null;
  if (id !== cam.deviceId) {
    stopStream();
    cam.userStopped = false; // a new selection starts by default
    camEls().status.textContent = '';
  } else if (live === cam.live && protocol === cam.protocol) {
    if (!live) { cam.hint = hintFor(printers[id]); syncCamera(); } // the reason may have changed
    return; // nothing that affects the stream changed (state messages arrive several times a second)
  } else if (cam.stop) {
    stopStream(); // camera went away or its protocol changed
  }
  cam.deviceId = id;
  cam.live = live;
  cam.protocol = protocol;
  cam.hint = id ? hintFor(printers[id]) : null;
  syncCamera();
}

function hintFor(printer) {
  if (printer?.connected === false) return 'Printer is offline';
  return printer?.capabilities?.cameraHint || null;
}

/** A printer's state changed; only matters if it's the one the widget shows. */
export function updateCameraWidget(deviceId, printers, dashFilters) {
  if (deviceId === selectedPrinter(dashFilters)) renderCameraWidget(printers, dashFilters);
}

/** Dashboard view shown / hidden (other views don't keep the stream open). */
export function setCameraViewActive(active) {
  cam.viewActive = active;
  syncCamera();
}

/** Configuration → Camera Widget toggle. */
export function setCameraWidgetEnabled(enabled) {
  cam.enabled = enabled;
  syncCamera();
}

export function initCameraWidget() {
  const { toggle, full, stage, status } = camEls();
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    if (cam.stop) {
      cam.userStopped = true;
      stopStream();
    } else {
      cam.userStopped = false;
      status.textContent = '';
    }
    syncCamera();
  });
  full.addEventListener('click', () => stage.requestFullscreen?.().catch(() => {}));
}
