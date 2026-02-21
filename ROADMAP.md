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

**Data already available from MQTT (per AMS tray):**
- `remain` — percentage remaining (0-100)
- `tray_weight` — spool weight in grams (e.g. "1000")
- `tray_type` — material (PLA, PETG, ABS, TPU, etc.)
- `tray_sub_brands` — specific variant (PLA Basic, PLA Glow, etc.)
- `tray_color` — hex color code
- `tray_uuid` — unique spool identifier (changes when a new spool is loaded)
- `tag_uid` — RFID tag ID (BBL spools only)
- `tray_id_name` — spool SKU (e.g. "A00-R0", "A12-B0")

**Database changes:**
- New `filament_spools` table — tracks each unique spool seen:
  - `id`, `tray_uuid`, `tag_uid`, `tray_type`, `tray_sub_brands`, `tray_color`, `tray_weight`, `tray_id_name`
  - `first_seen`, `last_seen`, `initial_remain`, `current_remain`
- New `filament_usage` table — per-job consumption:
  - `id`, `spool_id` (FK), `job_id` (FK), `device_id`
  - `remain_before`, `remain_after`, `grams_used` (computed from remain delta × tray_weight)
  - `timestamp`

**Backend changes:**
- Detect spool changes via `tray_uuid` diff on each MQTT update — upsert into `filament_spools`
- On job start: snapshot `remain` for all active trays → `remain_before`
- On job end: snapshot `remain` again → compute delta, insert `filament_usage` row
- New endpoints:
  - `GET /api/filament/spools` — all known spools with current remain
  - `GET /api/filament/spools/:id/history` — usage history for a spool
  - `GET /api/filament/usage` — usage log across all spools (filterable by printer, material, date)
  - `GET /api/filament/stats` — aggregate stats (total grams used by material, by printer, by time period)

**Frontend — new Filament Inventory view:**
- Spool cards showing color swatch, material, brand, current remain %, estimated grams left
- Group by AMS unit/slot or by material type
- Usage timeline chart (grams consumed per day/week)
- Per-spool history: which prints consumed how much
- Low filament warnings (configurable threshold, e.g. < 15%)

**Edge cases:**
- Spool swaps mid-print (tray_uuid changes during a job) — split the usage record
- Non-BBL spools (no RFID) — `tag_uid` may be empty, rely on `tray_uuid` only
- Manual tray loads without AMS — `remain` may not be reported
- Multiple printers sharing a spool (physically moved between AMS units) — match by `tray_uuid`

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
