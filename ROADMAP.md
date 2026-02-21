# Bambuzle Roadmap

## Planned

### Live Camera Feed
Embed the printer's camera stream in the dashboard when a print is active.

**Requirements:**
- Printer local IP address + LAN Access Code per printer (new config fields)
- Developer Mode + LAN Liveview enabled on printer (Jan 2025+ firmware)
- Local network access between bambuzle server and printer

**Technical approach:**
- P1/A1 series (port 6000): Node.js TLS client → binary auth handshake → extract JPEG frames from byte stream → serve as MJPEG or push via WebSocket
- X1 series (port 322): RTSPS proxy → re-serve as MJPEG or WebSocket frames
- New backend endpoint: `/api/printers/:id/camera` (MJPEG stream or WS)
- Frontend: embed in printer card, show only when printer is actively printing

**Constraints:**
- LAN only — BambuLab cloud does not expose camera streams
- P1/A1 use a custom (non-RTSP) protocol on port 6000; X1 uses RTSPS on port 322
- Frame rate varies: ~5-10 FPS on P1, ~1-2 FPS on A1 series
- Self-signed TLS certs on printer — must skip cert verification

**References:**
- [bambu-connect](https://github.com/mattcar15/bambu-connect) — Python library with CameraClient for port 6000 protocol
- [go2rtc](https://github.com/AlexxIT/go2rtc) — RTSPS proxy for X1 series
- [BambuP1SCam](https://github.com/wHyEt/BambuP1SCam) — Docker container for P1S camera re-streaming

---

### Print Job Statistics
Aggregate stats across print jobs — total print hours, filament usage, success/failure rates, average print times by material.

---

### Filament Inventory Tracking
Track filament spool usage across prints. Estimate remaining filament based on AMS tray data and job consumption.

---

### Mobile-Friendly Layout
Responsive CSS for phone/tablet viewing of the dashboard.

---

## Ideas (Unprioritized)

- Timelapse assembly from camera frames
- OctoPrint-style GCode viewer
- Push notifications (Pushover, ntfy, Telegram) in addition to webhook alerts
- Multi-user auth (currently single-session)
- Print queue / job scheduling
- Power consumption tracking (smart plug integration)
