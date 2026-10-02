# Bambuzle Enhancement Discovery (Beyond BAM-18)

> **Task ID:** AGY-SF002  
> **Author:** Antigravity (Gemini 3.8) — Research & Analysis Partner  
> **Date:** 2026-10-02  
> **Project:** `sffoundry/bambuzle`  
> **Analytic Mode:** Divergent discovery → Convergent ranking (Blind xval pair with CODEX-SF371)

---

## 1. Executive Summary

Bambu Lab's January 2025 Authorization Control System (ACS) and mandatory Cloud 2FA represent
an existential threat to Bambuzle's cloud-only MQTT architecture. While real-time telemetry
ingestion continues to function over Cloud MQTT, critical command execution (pause, resume,
stop, speed adjustments) is now systematically rejected on updated firmware unless printers
operate in LAN-Only Developer Mode. Relying exclusively on cloud authentication tokens exposes
single-operator and small-farm deployments to sudden cloud outages, rate-limiting, and account
authentication invalidation. Furthermore, Bambuzle's telemetry engine suffers from unmitigated
SQLite write amplification and misses high-value native telemetry like `xcam` AI failure flags
and complete HMS error diagnostics. Consequently, the primary strategic priority for Bambuzle
must be establishing a resilient, local-first foundation by introducing dual-mode local LAN
MQTT failover alongside robust operational hardening.

---

## 2. Ranked Enhancement Candidates (BAM-19 – BAM-30)

| Proposed ID | Feature | Priority | Effort | Depends on | Evidence |
|---|---|---|---|---|---|
| BAM-19 | Local LAN-Mode MQTT & Direct Control Failover | HIGH | L | None | `src/bambu/mqtt-client.js:20-56`, [Bambu LAN Mode](https://wiki.bambulab.com/en/general/lan-only-mode) |
| BAM-20 | Automated SQLite Downsampling & WAL Pruning | HIGH | M | None | `src/db/database.js:47-70`, `src/db/queries.js:338-366` |
| BAM-21 | Spoolman Bidirectional Filament Inventory Integration | HIGH | M | None | `ROADMAP.md:109-154`, [Spoolman API](https://github.com/Donkie/Spoolman) |
| BAM-22 | Comprehensive HMS Error Code Dictionary & Troubleshooter | HIGH | S | None | `src/utils/hms-codes.js:6-45`, [HMS Codes](https://wiki.bambulab.com/en/x1/troubleshooting/hmscode) |
| BAM-23 | AI Print Failure & Spaghetti Event Engine (`xcam`) | HIGH | S | None | `src/bambu/message-parser.js:47-146`, [openHAB Bambu](https://openhab.org/addons/bindings/bambulab/) |
| BAM-24 | Multi-Arch Docker & Compose Production Packaging | HIGH | S | None | `package.json:1-40`, `repo-context.json:27-34` |
| BAM-25 | Single-Pane Compact Fleet Overview Matrix | MED | M | None | `public/js/dashboard.js:1-50`, `repo-context.json:12-17` |
| BAM-26 | Native FTPS SD-Card Storage & Timelapse Harvester | MED | M | BAM-19 | `src/bambu/message-parser.js:140`, [P1P FTPS Manual](https://wiki.bambulab.com/en/p1/manual/p1p-faq) |
| BAM-27 | AMS Moisture & Desiccant Health Degradation Tracker | MED | S | None | `src/bambu/message-parser.js:137`, `public/js/ams-widget.js:1-40` |
| BAM-28 | Toolhead Maintenance & Consumable Wear Scheduler | MED | S | None | `src/db/database.js:25-32`, [Bambu Maintenance](https://wiki.bambulab.com/en/x1/maintenance/basic-maintenance) |
| BAM-29 | Prometheus `/metrics` Exporter & System Health Probe | MED | S | None | `src/server/app.js:8-52`, `src/index.js:15-50` |
| BAM-30 | Home Assistant MQTT Auto-Discovery Gateway | LOW | M | BAM-19 | `repo-context.json:40`, [HA MQTT Discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery) |

### Candidate Profiles

#### BAM-19: Local LAN-Mode MQTT & Direct Control Failover
- **Why it matters:** In January 2025, Bambu Lab introduced the Authorization Control System (ACS)
  in printer firmware, causing unapproved third-party cloud commands to fail with
  `HMS_0500-0500-0001-0007`. Bambuzle currently routes all communication through Bambu Cloud
  MQTT (`src/bambu/mqtt-client.js:20-56`), making local print control impossible when the
  internet is disrupted or when Bambu rotates auth tokens. Connecting directly over local Wi-Fi
  guarantees reliable command dispatch and eliminates cloud latency.
- **Technical Architecture:** Extend printer records to support `lan_ip` and `access_code`.
  `MqttPrinterClient` should initiate a TLS connection directly to `tls://${lan_ip}:8883` using
  username `bblp` and the printer's 8-character LAN access code as password, setting
  `rejectUnauthorized: false` to allow self-signed printer certificates. The client implements
  an automated fallback ladder: check local LAN reachability first, and fall back to Cloud MQTT
  only when the local IP is unresponsive.
- **First Slice:** Add `lan_ip` and `access_code` fields to `.env` and `src/config.js`. Update
  `MqttPrinterClient.connect()` to target the local broker when configured, validating that
  live telemetry and commands (`pause`/`resume`/`stop`) execute cleanly on modern firmware.
- **Dependencies & Risks:** Requires the user to enable LAN-Only mode or Developer Mode on the
  printer screen. Zero breaking database changes.

#### BAM-20: Automated SQLite Downsampling & WAL Pruning
- **Why it matters:** The telemetry collector inserts a new sample into `samples` every 1–2 seconds
  during active printing jobs (`src/db/queries.js:65-86`). In continuous multi-printer
  printing, this table accumulates over 50,000 rows per machine daily. The current cleanup cron
  (`src/config.js:32-35`) merely executes a 90-day delete. Without downsampling, the database
  file grows to multiple gigabytes, triggering checkpoint timeouts in SQLite WAL mode and
  freezing uPlot historical charts in the browser.
- **Technical Architecture:** Implement a multi-tier downsampling architecture in
  `src/db/queries.js`. Retain high-resolution 1-second samples for 7 days. Compress data
  between 7 and 30 days into 1-minute averaged rollups (`avg(nozzle_temp)`, `avg(bed_temp)`,
  etc.). For data older than 30 days up to 90 days, rollup samples into 5-minute intervals.
  Schedule weekly execution of `PRAGMA incremental_vacuum`.
- **First Slice:** Write a database migration adding `sample_rollups_1m` and `sample_rollups_5m`
  tables. Create a nocturnal cron job in `src/index.js` that aggregates historical samples and
  truncates raw data older than 7 days, ensuring historical charts load instantly.
- **Dependencies & Risks:** Requires modifying historical chart queries in
  `src/server/routes/api.js` to query rollups for long time windows. Low risk, massive query
  speedup.

#### BAM-21: Spoolman Bidirectional Filament Inventory Integration
- **Why it matters:** Planned item BAM-11 proposes implementing a bespoke spool inventory
  management subsystem from scratch (`ROADMAP.md:109-154`). This requires custom tables,
  complex UI forms, and manual spool weight tracking. The open-source 3D printing community has
  already standardized on Spoolman, which features an active REST API, filament vendor presets,
  QR code labeling, and multi-printer support. Building a proprietary inventory in Bambuzle
  isolates users from the broader tool ecosystem.
- **Technical Architecture:** Create a Spoolman sync service in `src/integrations/spoolman.js`. Map
  Bambu AMS tray UUIDs, spool colors, and RFID tags (`tag_uid`) to Spoolman spool entities.
  When a print job finishes, calculate the consumed filament weight based on layer telemetry
  and post usage updates directly to Spoolman via `PATCH /api/v1/spool/{id}/use`.
- **First Slice:** Add `SPOOLMAN_URL` to configuration. Implement an endpoint `GET
  /api/integrations/spoolman/spools` and wire an AMS slot selector in `public/js/ams-widget.js`
  allowing operators to associate an AMS tray with an active Spoolman spool ID.
- **Dependencies & Risks:** Dependent on an external Spoolman instance. Fails gracefully if
  Spoolman is offline without interrupting printing.

#### BAM-22: Comprehensive HMS Error Code Dictionary & Troubleshooter
- **Why it matters:** Bambu's Health Management System (HMS) provides diagnostic notifications
  covering AMS filament jams, heater decoupling, motor overload, and cutter failures.
  Currently, `src/utils/hms-codes.js:6-45` hardcodes only 20 error descriptions. Consequently,
  the majority of real-world printer faults render in the UI as unhelpful hex strings (`HMS
  error 0700_0200_0002_0001`), forcing operators to manually look up codes online.
- **Technical Architecture:** Import the comprehensive community Bambu HMS database into an indexed
  JSON lookup structure or SQLite table (`hms_dictionary`). Update `src/utils/hms-
  codes.js:52-60` to translate 32-bit hex tuples (`attr`, `code`) into plain English
  descriptions, categorizing issues by subsystem (AMS, Toolhead, Bed, Motion) and providing
  direct URLs to Bambu's official wiki repair guides.
- **First Slice:** Ingest the community HMS code JSON dataset (~400 definitions). Update
  `describeHmsCode()` to return the full human description, severity level, and wiki URL,
  displaying actionable error popups in the live event log.
- **Dependencies & Risks:** Completely self-contained in `src/utils/hms-codes.js`. Zero external
  runtime dependencies.

#### BAM-23: AI Print Failure & Spaghetti Detection Engine (`xcam`)
- **Why it matters:** Bambu printers equipped with chamber cameras (X1, P1S, A1) transmit an `xcam`
  telemetry block over MQTT containing status flags: `spaghetti_detector`,
  `first_layer_inspector`, `buildplate_marker_detector`, and `print_error`. Bambuzle's message
  parser currently strips out the entire `xcam` object (`src/bambu/message-parser.js:47-146`),
  ignoring built-in failure detection intelligence.
- **Technical Architecture:** Expand `extractPrinterState()` to extract `xcam` attributes and emit
  them over the internal event bus. Connect `xcam` failure events to `src/alerts/engine.js`.
  When the printer flags spaghetti or first-layer adhesion loss, Bambuzle fires high-priority
  alerts to webhooks and push channels and logs the incident in `temp_anomalies` or a dedicated
  `ai_failures` table.
- **First Slice:** Update `src/bambu/message-parser.js` to extract `xcam.spaghetti_detector` and
  `xcam.print_error`. Add an alert condition type `ai_failure` in `src/alerts/engine.js` that
  triggers immediate desktop and webhook notifications when an AI pause occurs.
- **Dependencies & Risks:** Requires printers with vision hardware (X1, P1S with camera, A1).
  Harmlessly passes null on camera-less P1P printers.

#### BAM-24: Multi-Arch Docker & Compose Production Packaging
- **Why it matters:** Bambuzle currently lacks official containerization (`repo-
  context.json:27-34`). Setting up Bambuzle requires manual host installation of Node.js and a
  full C++ build toolchain to compile native `better-sqlite3` bindings (`package.json:1-40`).
  This creates friction for self-hosters and print farm operators using Unraid, TrueNAS Scale,
  or Proxmox where Docker Compose is the default deployment mechanism.
- **Technical Architecture:** Author a multi-stage, multi-arch `Dockerfile` (linux/amd64,
  linux/arm64) using Node 20 Alpine. Compile native SQLite bindings during the build stage and
  prune build tools in the final image to keep the footprint under 150MB. Provide a production-
  ready `docker-compose.yml` with persistent volume mappings for `/data` (SQLite database) and
  `/config` (`.env` and configuration).
- **First Slice:** Supply a tested `Dockerfile` and `docker-compose.yml.example` in the repo root.
  Include automated healthcheck directives and ensure `better-sqlite3` compiles cleanly on
  ARM64 (Raspberry Pi 4/5) and x86_64.
- **Dependencies & Risks:** None. Does not alter existing bare-metal `npm start` workflows.

#### BAM-25: Single-Pane Compact Fleet Overview Matrix
- **Why it matters:** The current frontend renders full-sized cards for each printer
  (`public/js/dashboard.js:1-50`), which becomes unwieldy when managing small farms of 3 to 10
  machines. Print farm operators need a dense, high-information-density grid that presents
  operational status at a glance without extensive vertical scrolling.
- **Technical Architecture:** Implement a responsive "Farm Matrix" view toggle in
  `public/js/dashboard.js`. Render a condensed data table featuring one row per printer: online
  status indicator, device model, active job name, thumbnail preview, nozzle and bed
  temperatures, progress bar, time remaining, active AMS spool color swatch, and emergency
  pause/stop buttons.
- **First Slice:** Add a layout toggle button (`Cards` vs `Matrix`) in the UI header. Render the
  table view utilizing existing WebSocket state updates without creating new backend endpoints.
- **Dependencies & Risks:** Purely frontend presentation enhancements. Preserves all existing
  printer card components.

#### BAM-26: Native FTPS SD-Card Storage & Timelapse Harvester
- **Why it matters:** Planned item BAM-13 suggests assembling timelapses by capturing frames from
  MJPEG streams on the host CPU. However, Bambu printers already record hardware-accelerated,
  layer-synchronized MP4 timelapses directly to the internal microSD card and expose them over
  FTPS on port 990 (`src/bambu/message-parser.js:140`). Stitching frames on the host wastes CPU
  and yields inferior video quality.
- **Technical Architecture:** Build an FTPS storage client module in `src/bambu/ftps.js` using
  `basic-ftp`. Connect to the printer's FTPS server using the printer's access code. Expose
  REST endpoints to list `/timelapse` and `/cache`, extract embedded plate preview thumbnails
  from sliced `.gcode.3mf` files on the SD card, and stream native MP4 video files directly to
  the browser.
- **First Slice:** Implement `GET /api/printers/:id/timelapses` to list video files on the SD card
  and provide download links. Embed a video player in the completed job history view.
- **Dependencies & Risks:** Dependent on BAM-19 (requires printer local IP and access code).
  Requires microSD card installed in the printer.

#### BAM-27: AMS Moisture & Desiccant Health Degradation Tracker
- **Why it matters:** Bambu AMS units report an integer humidity rating (`ams.humidity`, 1–5) and
  internal chamber temperatures (`src/bambu/message-parser.js:137`). Moisture saturation is the
  primary cause of print failures and stringing in hygroscopic materials like PETG, ABS, and
  TPU, yet Bambuzle provides no historical tracking for desiccant health.
- **Technical Architecture:** Ingest AMS humidity levels and persist them in SQLite on an hourly
  cadence (`ams_humidity_log`). Add an AMS health widget to `public/js/ams-widget.js`
  displaying the current moisture index (1=dry, 5=saturated) alongside a historical trendline,
  triggering a maintenance alert when humidity rises above index level 3.
- **First Slice:** Store hourly AMS humidity readings in SQLite. Display a desiccant status badge
  (Green/Yellow/Red) in the AMS widget and emit an alert rule condition when desiccant
  saturation is detected.
- **Dependencies & Risks:** Requires printers with AMS units attached. Silently skips printers
  operating with bare spools.

#### BAM-28: Toolhead Maintenance & Consumable Wear Scheduler
- **Why it matters:** Bambu printers report cumulative odometer printing hours and hardware
  characteristics like `nozzle_diameter` and `nozzle_type` (hardened vs stainless steel).
  Operators routinely neglect preventive maintenance routines such as carbon rod cleaning, lead
  screw lubrication, and nozzle replacement until print defects occur.
- **Technical Architecture:** Create a maintenance tracking schema in `src/db/database.js` tracking
  operating hours against configurable thresholds (e.g., carbon rod wiping every 100 hours,
  lead screw lubrication every 250 hours). Calculate active hours from `print_jobs` elapsed
  times and display visual warning badges on printer cards when services are due.
- **First Slice:** Create a `maintenance_tasks` table and REST endpoints (`GET`/`POST
  /api/printers/:id/maintenance`). Add a maintenance modal in the UI where operators can log
  completed service tasks and reset hour counters.
- **Dependencies & Risks:** Low complexity, self-contained schema additions.

#### BAM-29: Prometheus `/metrics` Exporter & System Health Probe
- **Why it matters:** For 24/7 unattended homelab hosting, Bambuzle currently offers no
  observability endpoints (`src/server/app.js:8-52`). Operators cannot detect stalled MQTT
  subscriptions or SQLite database lockups without inspecting raw application console logs.
- **Technical Architecture:** Expose `GET /health` to verify SQLite read/write responsiveness and
  MQTT connection state, and `GET /metrics` using `prom-client` to export standard Prometheus
  gauges for temperatures, fan percentages, progress, and job durations for Grafana dashboard
  ingestion.
- **First Slice:** Implement `/health` returning JSON health checks for database and MQTT clients.
  Expose `/metrics` exporting standard gauges (`bambuzle_nozzle_temp`, `bambuzle_bed_temp`,
  `bambuzle_print_progress`, `bambuzle_print_state`).
- **Dependencies & Risks:** Introduces `prom-client` dependency. Endpoints are read-only and non-
  intrusive.

#### BAM-30: Home Assistant MQTT Auto-Discovery Gateway
- **Why it matters:** Sibling project `sffoundry/bambu-farm-card` shares algorithm logic with
  Bambuzle (`repo-context.json:40`). Running separate Home Assistant integrations that poll
  printers redundantly wastes network bandwidth and creates connection collisions on local
  printer MQTT ports.
- **Technical Architecture:** Add an outbound MQTT publisher module that broadcasts normalized
  printer states to an external broker using standard Home Assistant MQTT Discovery topics
  (`homeassistant/sensor/.../config`), turning Bambuzle into a single telemetry hub.
- **First Slice:** Configure an outbound MQTT broker connection in `src/config.js`. Publish Home
  Assistant discovery payloads for nozzle/bed temperatures, print progress, and printer status
  on startup.
- **Dependencies & Risks:** Dependent on BAM-19 for reliable local data ingestion.

---

## 3. BAM-9..18 Critique Table

| ID | Feature | Verdict | Reason |
|---|---|---|---|
| BAM-9 | Live camera feed (LAN) | RESIZE | Demuxing proprietary port 6000 binary TLS in Node.js is overly fragile; delegate stream ingestion to a lightweight `go2rtc` or RTSPS sidecar proxy (Effort XL → L). |
| BAM-10 | Print job statistics | REPRIORITIZE | High operational value with minimal effort (Effort M → S; Priority MED → HIGH); the `print_jobs` table already tracks start/end/pauses/anomalies (`src/db/database.js:34-45`). |
| BAM-11 | Filament inventory | MERGE | Merge into BAM-21 (Spoolman integration). Building a bespoke spool tracking database from scratch is redundant when Spoolman is the established community standard. |
| BAM-12 | Mobile responsive layout | REPRIORITIZE | Elevate from MED to HIGH. Operators and hobbyists overwhelmingly monitor print progression from mobile devices and tablets rather than desktop browsers. |
| BAM-13 | Timelapse assembly | DROP | Bambu hardware automatically saves high-quality, layer-synced timelapses directly to the microSD card. Replaced by BAM-26 (direct FTPS harvester). |
| BAM-14 | G-code 3D viewer | DROP | In-browser 3D G-code rendering incurs high browser CPU overhead and frequent mobile crashes. Sliced 2D thumbnails from 3MF files deliver superior ROI. |
| BAM-15 | Push notifications | REPRIORITIZE | Elevate from Backlog to HIGH. Push delivery via ntfy, Pushover, or Telegram is critical for unattended print monitoring; notification hooks are already supported. |
| BAM-16 | Multi-user auth | SPLIT | Split into BAM-16A (Reverse-proxy header authentication / single admin token, Effort S) and BAM-16B (Granular multi-role RBAC, Effort L). |
| BAM-17 | Print queue / scheduling | BLOCKED | Bambu ACS blocks remote print starts without Developer Mode; unassisted remote job initiation without physical plate clearing poses severe fire and mechanical hazards. |
| BAM-18 | Power consumption tracking | KEEP | Retain at MED priority (Effort M). Connects cleanly with smart plug APIs (Shelly, Tasmota, Kasa) to measure electrical kWh consumption per print job. |

### Critique Rationale

- **BAM-9 (Live Camera Feed) & BAM-13 (Timelapse Assembly):** Handling raw binary TLS framing over
  port 6000 (P1/A1) or port 322 (X1) in Node.js requires substantial low-level packet
  reconstruction. Delegating RTSPS and port 6000 streaming to an external proxy like `go2rtc`
  shrinks implementation effort from XL to L. BAM-13 should be dropped entirely: stitching low-
  framerate MJPEG frames on the server CPU produces choppy, inferior videos compared to the
  high-definition, layer-synchronized timelapses captured natively by printer hardware and
  retrieved via FTPS (BAM-26).
- **BAM-10 (Print Job Statistics) & BAM-12 (Mobile Layout):** Both features provide immediate day-
  to-day usability improvements with modest development effort. `print_jobs` already captures
  start/end timestamps, pause counts, anomaly events, and layer counts. Adding aggregate SQL
  queries (`GET /api/stats`) and responsive CSS media queries delivers immense value for single
  operators and small farms.
- **BAM-11 (Filament Inventory) & BAM-14 (G-Code Viewer):** Attempting to build a full spool
  management lifecycle within Bambuzle duplicates existing dedicated software. Adopting
  Spoolman (BAM-21) provides QR labeling, manufacturer catalogs, and active weight deductions
  out of the box. Dropping the 3D WebGL G-code visualizer prevents browser crashes and high
  memory consumption on low-end client devices.
- **BAM-16 (Authentication) & BAM-17 (Print Queue):** Securing command execution routes
  (`/api/printers/:id/command`) against unauthenticated LAN tampering is an urgent baseline
  requirement. Splitting auth into BAM-16A (forward-auth headers via Authelia/Cloudflare Access
  or single admin token) immediately hardens security without waiting for complex multi-tenant
  RBAC (BAM-16B). Autonomous print queueing (BAM-17) is currently blocked by firmware ACS
  restrictions and carries mechanical risks unless physical bed-clearing mechanisms are in
  place.

---

## 4. Outlier Ledger

1. **Pure LAN Sovereign Appliance (Drop Cloud MQTT Entirely):**
   Sever all ties with Bambu Lab's cloud infrastructure by eliminating cloud account logins,
access tokens, and verification codes. Operate Bambuzle strictly via local LAN-Mode MQTT (port
8883) with Developer Mode enabled. This insulates the deployment against Bambu ToS revisions,
API deprecations, cloud outages, or account suspensions, turning Bambuzle into a fully
sovereign offline appliance.
2. **Terminal / TUI Headless Daemon (Pi Zero / Kiosk Console):**
   Develop an ncurses/Blessed text user interface that executes directly over SSH or on small
dedicated LCD displays attached to a Raspberry Pi. This honors Bambuzle's retro HamClock
monospace design language while allowing headless server monitoring without launching a web
browser.
3. **Automated Print Cost & Quoting Engine (Micro-Job Shop):**
   Evolve Bambuzle from a passive monitoring tool into a commercial production console. Combine
filament consumption (BAM-21), smart-plug electrical energy usage (BAM-18), and machine wear
depreciation ($/hour) to calculate the exact cost-of-goods-sold (COGS) per printed part, with
automated PDF invoicing for clients.
4. **Universal Fleet Abstraction (Klipper / Moonraker + PrusaLink):**
   Decouple Bambuzle's backend telemetry engine from Bambu-specific schemas by defining a
generic 3D printer abstraction model. Ingest Moonraker feeds (Voron, Creality Ender) and
PrusaLink APIs alongside Bambu MQTT, positioning Bambuzle as the premier unified self-hosted
dashboard for mixed printer fleets.

---

## 5. Sources

### Repository Evidence
- `src/bambu/message-parser.js:47-146` — Primary telemetry parser and ignored `xcam`, `hms`,
and sensor attributes.
- `src/bambu/mqtt-client.js:20-56` — Cloud MQTT broker connection logic and TLS configuration.
- `src/bambu/commands.js:1-88` — Pushall, pause, resume, stop, and gcode command structures.
- `src/bambu/auth.js:49-73` — Bambu Cloud HTTP authentication and 2FA verification code flow.
- `src/db/database.js:24-173` — SQLite schema definitions, anomaly tracking tables, and
migration logic.
- `src/db/queries.js:65-86, 338-366` — Telemetry insertion and 90-day retention pruning queries
without downsampling.
- `src/utils/hms-codes.js:6-45` — Hardcoded HMS code lookup map covering only 20 error states.
- `ROADMAP.md:57-77, 109-154` — Existing Phase 1 and Backlog feature specifications (BAM-9..18).
- `repo-context.json:1-58` — Architectural definitions and relationship to `bambu-farm-card`.

### External Citations
- Bambu Lab LAN Mode & Access Code Specification: `https://wiki.bambulab.com/en/general/lan-only-mode`
- Bambu Lab Firmware Authorization & Developer Mode Overview:
`https://wiki.bambulab.com/en/knowledge-sharing/developer-mode`
- Bambu Lab Health Management System (HMS) Codes Reference:
`https://wiki.bambulab.com/en/x1/troubleshooting/hmscode`
- Greg Hesp `ha-bambulab` Integration & MQTT Schema: `https://github.com/greghesp/ha-bambulab`
- Spoolman Open-Source Filament Management System API: `https://github.com/Donkie/Spoolman`
- BambuBoard Open-Source Streaming Dashboard: `https://github.com/t0nyz0/BambuBoard`
- SimplyPrint Bambu Lab Farm Management Features: `https://simplyprint.io/3d-printer/bambu-lab`
- openHAB BambuLab Binding MQTT Schema & `xcam`: `https://openhab.org/addons/bindings/bambulab/`
