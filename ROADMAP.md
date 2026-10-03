# Bambuzle Roadmap

> **Mission:** Self-hosted monitoring dashboard for BambuLab 3D printers. Connects to BambuLab Cloud via MQTT, stores telemetry in SQLite, and serves a real-time web dashboard.
> **Adoption surface for `aiw feature adopt BAM-<N>`.**

**Last updated:** 2026-10-02 (backfilled v0.3.0–v0.4.1 shipped work as BAM-19..29; flagged requester-auth gap on BAM-16/BAM-28; added BAM-30..46 proposals from enhancement xval)

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

### P0.2: Post-foundation additions (v0.3.0–v0.4.1) — backfilled 2026-10-02

Shipped Feb 2026 but never recorded on the roadmap. Effort sizes are retrospective estimates.

| ID | Feature | Status | Effort | Notes |
|---|---|---|---|---|
| BAM-19 |Dashboard config modal + two-pane layout with events widget|✅|M|v0.3.0 (`be1960e`)|
| BAM-20 |Global filters + time-range presets with chart zoom sync|✅|M|v0.4.0–v0.4.1 (`64b9ed8`, `6d07207`)|
| BAM-21 |Auth session persistence across restarts|✅|S|v0.4.0 (`64b9ed8`) — persists the server's Bambu Cloud session, not dashboard users|
| BAM-22 |AMS widget|✅|M|v0.4.0 (`64b9ed8`)|
| BAM-23 |Fan and print-speed stats|✅|S|v0.4.0 (`64b9ed8`)|
| BAM-24 |Progress semicircle gauges + printer selection prompt|✅|S|`efe242d`|
| BAM-25 |Anomaly capture: layer transitions, temp anomalies, job pauses|✅|L|`abaa82d` — `src/anomaly/detector.js`; capture + REST API, no triage view yet|
| BAM-26 |Swagger UI API docs at `/api/docs`|✅|S|`fee6e55` — `openapi.yaml`|
| BAM-27 |Multi-chart MQTT visualization (6 chart types) with 60s auto-refresh|✅|L|`f896538`, `aa1b0fd`|
| BAM-28 |Printer control API (pause / resume / stop / speed)|✅|M|v0.6.0. Card buttons (Pause/Resume, Stop with confirm, speed select); state-gated; waits for the printer's reply by sequence_id and shows confirmed / rejected / unconfirmed; every attempt audited as a `command` event. **Not yet tried on real hardware** — 2025 authorization firmware may reject unsigned cloud commands (shown as "rejected")|
| BAM-29 |Rate limiting on auth login/verify endpoints|✅|S|`89148c5`|

---

## Phase 1: Planned features

| ID | Feature | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| BAM-9 |Live camera feed (LAN-only, MJPEG/WS)|❌|HIGH|XL|See § "Live camera feed" below for full spec|
| BAM-10 |Print job statistics (totals, success rates, by-material)|✅|MEDIUM|M|v0.5.0. `GET /api/stats` + Stats view; jobs now record material/colour (active tray at start) and duration. Caveats: durations include pauses; one material per job; UTC days|
| BAM-11 |Filament inventory tracking (per-spool usage)|❌|HIGH|XL|See § "Filament inventory tracking" below for full spec — schema + backend + UI changes. 2026-10-02 xval: both partners recommend re-scoping to Spoolman integration (BAM-38)|
| BAM-12 |Mobile-friendly responsive layout|❌|MEDIUM|M|Phone/tablet viewing of the dashboard|

---

## Ideas (unprioritized backlog)

| ID | Feature | Status | Effort | Notes |
|---|---|---|---|---|
| BAM-13 |Timelapse assembly from camera frames|❌|M|Depends on camera-feed feature shipping first. 2026-10-02 xval: printers already record MP4 timelapses to SD — see BAM-44|
| BAM-14 |OctoPrint-style GCode viewer|❌|L|Render G-code path with toolhead position|
| BAM-15 |Push notifications (Pushover, ntfy, Telegram) in addition to webhook alerts|✅|M|v0.5.0. `src/alerts/notifiers/push.js`; new `print_error` alert condition. ntfy uses JSON publish (header publish breaks on non-ASCII printer names). Not tested against live services|
| BAM-16 |Multi-user auth (currently single-session)|❌|L|Foundational for any shared deployment. v0.5.0 shipped the interim single shared admin token (BAM-30); this item is per-user accounts/roles on top of it, paired with the BAM-41 audit trail|
| BAM-17 |Print queue / job scheduling|❌|XL|Submit jobs from bambuzle to printer. 2026-10-02 xval: both partners say blocked — print start is authorization-gated (Jan 2025 firmware) and Bambu Farm Manager (free, local) already queues|
| BAM-18 |Power consumption tracking (smart plug integration)|❌|M|Match printer-on intervals against smart-plug telemetry. 2026-10-02 xval: start advisory-only (draw, cost, circuit-limit alerts); no plug switching before BAM-16|

---

## Proposed: enhancement discovery (2026-10-02, pending owner review)

From the CODEX-SF371 × AGY-SF002 blind xval, merged and verified in `research/claude/2026-10-02-claude-bambuzle-enhancement-xval-merge.md`. Strategy both partners reached independently: a local-first **observability** appliance — reliability and data surfacing before more control features. Suggested first tranche: BAM-30 → BAM-31/32 → BAM-33/34 → BAM-10 (as S) → BAM-38.

| ID | Feature | Status | Priority | Effort | Depends on | Notes |
|---|---|---|---|---|---|---|
| BAM-30 |Interim requester auth (shared admin token on all `/api` + `/ws`) + query `limit` caps|✅|HIGH|S|—|v0.5.0. Generated token or `BAMBUZLE_ADMIN_TOKEN`; `BAMBUZLE_PUBLIC_READ`, `BAMBUZLE_AUTH=off`. Closes code-review 2026-10-02 H1/H2/M1/M2/M3|
| BAM-31 |Full HMS code dictionary with wiki links|✅|HIGH|S|—|v0.5.0. 5,293 codes from ha-bambulab's tables (sourced from Bambu's public HMS endpoint + wiki), regenerate with `scripts/update-hms-codes.js`; severity/subsystem decoded per Bambu Studio. Model-specific text not wired yet (needs cloud model → dataset model map)|
| BAM-32 |Surface unused MQTT fields: xcam AI flags, nozzle type/diameter, upgrade state, network|✅|HIGH|M|—|v0.5.0. `src/bambu/diagnostics.js` → `state.diagnostics` + card chips; `print_error` events (user-cancel excluded). Note: `xcam` is AI-monitor *settings*, not detections (agy's spec was wrong). `home_flag` wired-network bit left out — unverified (set on Wi-Fi-only A1). `print.fun` dev-mode bit parsed → seeds BAM-35|
| BAM-33 |Docker/Compose packaging (amd64 + arm64)|✅|HIGH|S|—|v0.5.0. `Dockerfile` (bookworm-slim, non-root, /data volume, healthcheck), `compose.example.yaml`, Install.md § Docker. amd64 verified healthy (238 MB); **arm64 unverified** (no buildx/QEMU on build host)|
| BAM-34 |Health/readiness endpoints + SQLite backup & restore|✅|HIGH|M|—|v0.5.0. `/healthz`, `/readyz` (public, no device detail), `/api/system`; daily online backup → integrity_check → sha256, keep 7 (0600, contains Bambu token); `npm run backup:restore`; Docker HEALTHCHECK → /healthz|
| BAM-35 |Per-printer connection capability matrix (cloud / LAN / Dev Mode / camera)|❌|MEDIUM|M|—|Gate for BAM-9, BAM-44 and any LAN adapter|
| BAM-36 |Telemetry rollups and tiered retention|❌|MEDIUM|L|BAM-34|Raw samples today: 5s active / 30s idle, 90-day delete|
| BAM-37 |Prometheus `/metrics` (incl. MQTT connection count, last-message age)|✅|MEDIUM|S|BAM-34|v0.5.0. No client lib; admin-token guarded; bounded labels (device_id + name). Install.md § Monitoring has scrape config + suggested alerts|
| BAM-38 |Spoolman integration|❌|MEDIUM|M|—|Proposed to supersede bespoke BAM-11 inventory|
| BAM-39 |Maintenance ledger (print hours, service intervals, repeat HMS)|❌|MEDIUM|M|BAM-10||
| BAM-40 |Print-failure triage timeline (anomalies + xcam + HMS)|❌|MEDIUM|M|BAM-32|Builds on BAM-25 anomaly capture|
| BAM-41 |Operator audit trail (auth, config, command attempts)|❌|MEDIUM|M|BAM-30||
| BAM-42 |Home Assistant MQTT discovery bridge (read-only)|❌|LOW|M|BAM-34|Overlaps sibling `bambu-farm-card`|
| BAM-43 |AMS humidity / desiccant trend + alert|❌|LOW|S|—|Raw `ams` humidity already reaches the client|
| BAM-44 |SD-card timelapse/file harvester over FTPS|❌|LOW|M|BAM-35|Proposed replacement for BAM-13's frame-stitching approach|
| BAM-45 |Compact fleet matrix view (read-only)|❌|LOW|M|—|No control buttons until BAM-30|
| BAM-46 |Job data export (CSV/JSON + data dictionary)|❌|LOW|S|BAM-10||

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
