# Bambuzle Roadmap

> **Mission:** Self-hosted monitoring dashboard for BambuLab 3D printers. Connects to BambuLab Cloud via MQTT, stores telemetry in SQLite, and serves a real-time web dashboard.
> **Adoption surface for `aiw feature adopt BAM-<N>`.**

**Last updated:** 2026-05-07

---

## Legend

> Canonical taxonomy per `sffoundry/ai-workflows/reference/project-standards.md` § Roadmap Format Standard.

### Status

| Symbol | Meaning |
|---|---|
| ✅ | Implemented — complete and shipped |
| 🟡 | Partially implemented — core works, some aspects missing |
| 🔵 | Alternative approach — different from what was requested |
| ❌ | Not implemented — planned but not built |
| ➖ | Not applicable — won't ship |
| 📅 | Scheduled — committed to a specific phase |
| 🔥 | High demand (annotation, not a state — compose with the actual state) |

### Effort

| Size | Tokens / scope |
|---|---|
| **XS** | < 5K tokens — typo, config tweak, one-liner |
| **S** | 5-15K — 1-2 file edits, config or fix |
| **M** | 20-40K — new endpoint + UI, 3-5 files |
| **L** | 40-70K — new widget / overlay / subsystem, 5-10 files |
| **XL** | 70-120K — multi-component feature, new architectural pattern |

---

## Phase 0: Foundation — ✅ COMPLETE

Core dashboard with real-time MQTT, SQLite persistence, web UI, and multi-printer + multi-AMS support.

| ID | Feature | Status | Effort | Notes |
|---|---|---|---|---|
| BAM-1 |Real-time printer status cards (temps, progress, fans, ETA)|✅|L||
| BAM-2 |Historical temperature and progress charts|✅|M||
| BAM-3 |Event log with sorting and filtering|✅|M||
| BAM-4 |Configurable alert rules|✅|M|Webhook delivery|
| BAM-5 |Multi-printer support|✅|L||
| BAM-6 |H2D dual-nozzle support|✅|M||
| BAM-7 |BambuLab Cloud MQTT integration|✅|L||
| BAM-8 |SQLite telemetry persistence|✅|M||

---

## Phase 1: Planned features

| ID | Feature | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| BAM-9 |Live camera feed (LAN-only, MJPEG/WS)|❌|HIGH|XL|See § "Live camera feed" below for full spec|
| BAM-10 |Print job statistics (totals, success rates, by-material)|❌|MEDIUM|M|Aggregations across `prints` table|
| BAM-11 |Filament inventory tracking (per-spool usage)|❌|HIGH|XL|See § "Filament inventory tracking" below for full spec — schema + backend + UI changes|
| BAM-12 |Mobile-friendly responsive layout|❌|MEDIUM|M|Phone/tablet viewing of the dashboard|

---

## Ideas (unprioritized backlog)

| ID | Feature | Status | Effort | Notes |
|---|---|---|---|---|
| BAM-13 |Timelapse assembly from camera frames|❌|M|Depends on camera-feed feature shipping first|
| BAM-14 |OctoPrint-style GCode viewer|❌|L|Render G-code path with toolhead position|
| BAM-15 |Push notifications (Pushover, ntfy, Telegram) in addition to webhook alerts|❌|M|New alert delivery channels|
| BAM-16 |Multi-user auth (currently single-session)|❌|L|Foundational for any shared deployment|
| BAM-17 |Print queue / job scheduling|❌|XL|Submit jobs from bambuzle to printer|
| BAM-18 |Power consumption tracking (smart plug integration)|❌|M|Match printer-on intervals against smart-plug telemetry|

---

## Detailed specs

### Live camera feed

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

### Filament inventory tracking

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
