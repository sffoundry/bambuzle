# Bambuzle Enhancement Discovery Beyond BAM-18 — Research

> **For:** Claude (via developer)
> **From:** Codex
> **Date:** 2026-10-02
> **Operating under:** coordination.md v2.2, codex-prompt v1.3, STATE n/a (none found in Bambuzle)
> **Analytic mode:** divergent discovery → convergent ranking (set by: human prompt)

## Executive summary

1. **Risk verdict:** Cloud MQTT remains a workable *monitoring* input, but it is not a durable control-plane foundation: Bambu’s Jan-2025 authorization architecture restricts critical third-party actions, while LAN Developer Mode is explicitly unsupported and field reports show firmware/model-dependent local MQTT behavior. [Bambu authorization update, 2025-01-16](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/) [ha-bambulab LAN-mode report, 2025-10-19](https://github.com/greghesp/ha-bambulab/issues/1584)
2. Bambuzle should become a local-first observability service with cloud as an adapter, not chase a cloud-mediated print queue or broad remote-control surface.
3. The next high-value move is operational reliability: bounded retention/downsampling, backup/restore, health/readiness, and metrics make the existing useful dashboard safe to leave unattended.
4. The existing merged MQTT state contains actionable but unnormalized printer health, safety, and capability data; expose it read-only before adding more control features. `src/bambu/mqtt-client.js:99-110` `src/bambu/message-parser.js:101-145`
5. Reframe filament as a Spoolman-compatible integration, defer/reshape queue and camera work around firmware-capability detection, and make BAM-16 authorization first among the planned features.

## Ranked new-enhancement candidates

| Proposed ID (BAM-N?) | Feature | Priority (HIGH/MED/LOW) | Effort (XS–XL per ROADMAP legend) | Depends on | Evidence (URL or file:line) |
|---|---|---:|---:|---|---|
| BAM-19 | Local-first connection capability matrix | HIGH | M | none | `src/bambu/mqtt-client.js:43-69`; [Bambu Connect update, 2025-01-20](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/) |
| BAM-20 | Health, readiness, and backup/restore | HIGH | M | BAM-19 | `src/index.js:38-76`; `src/db/database.js:10-20` |
| BAM-21 | Telemetry retention tiers and downsampling | HIGH | L | BAM-20 | `src/index.js:156-185`; `src/db/database.js:47-69` |
| BAM-22 | Prometheus metrics and Home Assistant MQTT bridge | HIGH | L | BAM-20 | `src/index.js:200-230`; [Spoolman README](https://github.com/Donkie/Spoolman) |
| BAM-23 | Printer health and maintenance ledger | HIGH | M | BAM-19 | `src/bambu/message-parser.js:117-145`; [SimplyPrint analytics](https://simplyprint.io/features/statistics) |
| BAM-24 | Read-only diagnostics and firmware posture panel | MED | M | BAM-19 | `src/bambu/message-parser.js:101-145`; [representative push_status capture](https://github.com/greghesp/ha-bambulab/issues/1460) |
| BAM-25 | Capability-gated camera adapter | MED | L | BAM-19, BAM-9 | `ROADMAP.md:74-101`; [Bambu Connect update, 2025-01-20](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/) |
| BAM-26 | Print-failure triage from existing anomalies | MED | M | BAM-23 | `src/anomaly/detector.js:43-117`; [SimplyPrint farm features](https://simplyprint.io/print-farms) |
| BAM-27 | Spoolman interoperability | MED | M | BAM-11 | `ROADMAP.md:103-178`; [Spoolman API model](https://github.com/Donkie/Spoolman/wiki/Automatic-Filament-Usage-Tracking) |
| BAM-28 | Power and circuit safety policy layer | MED | M | BAM-18 | [Bambu Farm Manager, 2025-07-03](https://blog.bambulab.com/bambu-lab-introduces-local-fleet-control-with-bambu-farm-manager/) |
| BAM-29 | Immutable operator/audit trail | MED | M | BAM-16 | `src/bambu/commands.js:1-137`; [SimplyPrint organization controls](https://simplyprint.io/features/organisation-management/farm-enterprise) |
| BAM-30 | Exportable job-quality data set | LOW | M | BAM-10, BAM-21 | `src/db/database.js:34-69`; [SimplyPrint analytics](https://simplyprint.io/features/statistics) |

### BAM-19 — Local-first connection capability matrix

At onboarding and periodically thereafter, probe and record each printer’s available modes: cloud status, LAN status, Developer Mode/operator attestation, camera availability, and whether control is permitted. The server currently assumes one cloud MQTT transport and subscribes to its report topic after account login. `src/bambu/mqtt-client.js:35-69` First slice: read-only “connection posture” per printer plus a capability enum that every command/camera feature must consult.

This is first because Bambu’s January 2025 policy says status pushes remain available while critical control operations become authorization-gated; its subsequent update says Developer Mode leaves MQTT/live stream/FTP open but unsupported. [Authorization update, 2025-01-16](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/) [Integration update, 2025-01-20](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)

### BAM-20 — Health, readiness, and backup/restore

Add `/healthz` (process alive), `/readyz` (database and at least configured transport state known), a version endpoint, scheduled SQLite backup using the SQLite backup API, and a tested restore runbook. Bambuzle starts HTTP before authentication and runs its own database migrations, so “port open” is not a meaningful readiness result. `src/index.js:38-76` `src/db/database.js:10-20`

First slice: health/readiness JSON, backup destination configuration, retention, checksum, and a CLI/documented restore verification. This is the smallest feature that makes an unattended deployment diagnosable after host restarts, token expiry, or a failed migration.

### BAM-21 — Telemetry retention tiers and downsampling

Replace delete-only retention with a hot raw tier, hourly/min-max/mean rollups, and explicit per-table policies; serve charts from the appropriate tier. Today sampling continues during idle periods and a daily job deletes old rows, while `samples` has only raw timestamps and an index. `src/index.js:291-323` `src/index.js:156-170` `src/db/database.js:47-69`

First slice: migrate historical raw samples older than a configurable threshold into hourly aggregates, query them for wide chart windows, and record compaction success in health metrics. This protects multi-month use without silently throwing away trend value.

### BAM-22 — Prometheus metrics and Home Assistant MQTT bridge

Offer a small Prometheus `/metrics` endpoint and optional MQTT republish of normalized, read-only printer state/events under a namespaced local topic. State already flows through one `state` event and WebSocket broadcast, making it the natural fan-out point. `src/index.js:200-230` `src/bambu/mqtt-client.js:99-110`

First slice: connection state, last-message age, last-sample age, job state, temperatures, HMS-active count, database size, and backup age; publish retained availability/state only, never cloud credentials or raw command paths. This preserves Bambuzle’s self-hosted value while fitting Home Assistant and monitoring stacks.

### BAM-23 — Printer health and maintenance ledger

Turn existing hours, job outcomes, pauses, temperature anomalies, HMS errors, fan state, and capability data into service counters and a maintenance checklist. Bambuzle already records `print_jobs`, anomalies, and pause data, but none becomes an operator-facing “what needs attention” view. `src/db/database.js:34-45` `src/db/database.js:88-145`

First slice: per-printer print hours, completed/failed/cancelled counts, repeated HMS codes, and manually resettable service intervals. This is a better next operational value than a queue because it needs no privileged printer command and mirrors the use-based maintenance pattern visible in commercial farm tools. [SimplyPrint analytics](https://simplyprint.io/features/statistics)

### BAM-24 — Read-only diagnostics and firmware posture panel

Normalize and surface nozzle type/diameter, SD presence, upgrade state, camera/light state, network state, queue hints, and HMS detail, with raw JSON accessible only to an authenticated administrator. Current extraction keeps only a small normalized subset despite retaining a full merged payload in memory. `src/bambu/message-parser.js:101-145` `src/bambu/mqtt-client.js:103-110`

First slice: a typed snapshot plus an “unsupported/unknown” badge rather than assuming field universality. A contemporary `push_status` capture includes `ipcam`, `upgrade_state`, nozzle metadata, queue fields, light report, detailed AMS state, and xcam flags. [ha-bambulab diagnostic capture, 2025-07-16](https://github.com/greghesp/ha-bambulab/issues/1460)

### BAM-25 — Capability-gated camera adapter

Keep the user-facing BAM-9 objective but split its transport implementation from the dashboard widget: select an explicit local camera adapter only when BAM-19 confirms supported LAN capability. The present spec already distinguishes P1/A1 port 6000 from X1 RTSPS, so a single universal implementation would be brittle. `ROADMAP.md:74-101`

First slice: inventory and test one adapter per supported family, expose connection diagnostics, and show a clear unsupported state rather than bypassing certificate/security failures. Bambu’s current policy differentiates standard authorization paths from voluntarily open Developer Mode, so camera availability must be a detected condition, not a roadmap assumption. [Bambu Connect update, 2025-01-20](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)

### BAM-26 — Print-failure triage from existing anomalies

Make the existing layer transition, temperature, pause, and HMS detectors produce a ranked “intervene now / inspect after completion” timeline instead of adding unvalidated computer vision. `src/anomaly/detector.js:43-117` `src/index.js:207-217`

First slice: job summary with anomaly clusters, threshold explanation, and a webhook/ntfy-compatible alert payload. This is deliberately not an “AI failure detector”: camera-based claims require labeled evidence and a capability-stable camera path, whereas Bambuzle already owns deterministic telemetry evidence.

### BAM-27 — Spoolman interoperability

Resize BAM-11 around an optional Spoolman connector: map Bambuzle AMS observations to a user-confirmed external spool identity and post measured or estimated consumption through Spoolman’s API. The planned design correctly recognizes tray UUID/RFID and mid-print swaps, but it would duplicate a mature general-purpose inventory service. `ROADMAP.md:103-178`

First slice: read-only spool matching and “candidate consumption” reconciliation, never automatically decrementing a spool on ambiguous tray changes. Spoolman is self-hosted, multi-printer aware, and intentionally receives use updates from printer tools through its REST API. [Spoolman automatic-tracking design](https://github.com/Donkie/Spoolman/wiki/Automatic-Filament-Usage-Tracking)

### BAM-28 — Power and circuit safety policy layer

Expand BAM-18 from smart-plug charts into a local policy layer: alert on unexpected draw, estimate simultaneous heat-up load, and provide only advisory stagger recommendations until a consciously authorized integration is designed. Bambu Farm Manager explicitly positions local farm operation and power-load management as a fleet concern. [Bambu Farm Manager announcement, 2025-07-03](https://blog.bambulab.com/bambu-lab-introduces-local-fleet-control-with-bambu-farm-manager/)

First slice: ingest plug telemetry and annotate jobs with power cost/draw; alert on configured circuit threshold without switching anything. That preserves the self-hosted monitoring boundary and avoids introducing a second high-consequence command surface.

### BAM-29 — Immutable operator/audit trail

Add an append-only audit event for authentication, configuration, command attempts, alert deliveries, and any future integration action, with actor, source IP, target, result, and request correlation ID. This is prerequisite safety infrastructure for BAM-16, not a feature to bolt on after multi-user control.

First slice: audit the existing pause/resume/stop/speed endpoints and rejected attempts, then show a filterable read-only page. The present command module creates printer command payloads while higher-level server state has no durable operator action ledger. `src/bambu/commands.js:1-137` `src/index.js:200-230`

### BAM-30 — Exportable job-quality data set

Provide CSV/JSON exports of completed jobs with outcome, duration, temperatures, anomaly counts, pause time, HMS summary, and linked aggregate telemetry. The database already persists the underlying job, sample, and anomaly data. `src/db/database.js:34-145`

First slice: date/printer-filtered CSV plus a data dictionary and stable column versions. Export precedes sophisticated dashboards because operators can validate data quality and use it in local reporting without creating a cloud account.

## MQTT field opportunity matrix

| Ignored or underused report area | Cheap unlocked feature | Guardrail |
|---|---|---|
| `upgrade_state`, `force_upgrade`, firmware/lifecycle hints | BAM-24 update posture and incompatible-feature warning | display only; no update command |
| `ipcam`, `lights_report`, `xcam`, `xcam_info` | BAM-25 camera/light capability card; observed AI/camera status | do not claim vision detection from a flag |
| `nozzle_diameter`, `nozzle_type`, AMS nozzle-temp bounds | capability, material/nozzle mismatch warning | field availability varies by model |
| `sdcard`, `queue_*`, `gcode_file_prepare_percent` | storage/readiness and preprint-stage visibility | no queue control without explicit authorized path |
| `net`, `wifi_signal`, online subfields | connectivity diagnosis and offline-since alert | retain bounded recent snapshots |
| `heatbreak_fan_speed`, existing `big_fan*`, temperatures | fan/thermal health trend and anomaly context | normalize units/model differences |
| full HMS object, `print_error`, `stg` | richer incident timeline and deduplication | raw payload access must be authenticated |

The parser normalizes temperature, three fans, Wi-Fi, HMS, AMS, SD card, online state, and print type, but not the additional report fields above. `src/bambu/message-parser.js:101-145` The cited diagnostic payload demonstrates the fields in a real 2025 A1 message, not a promise that every model exposes every field. [ha-bambulab diagnostic capture](https://github.com/greghesp/ha-bambulab/issues/1460)

## BAM-9..18 critique

| ID | Verdict (keep / resize / reprioritize / merge / drop / blocked) | Reason |
|---|---|---|
| BAM-9 | resize | Keep LAN camera as a capability-gated adapter (BAM-25), not a blanket high-priority feature; authorization/Developer Mode and model transport differ. |
| BAM-10 | merge | Merge into BAM-23/BAM-30: job statistics are the data layer for maintenance and exports, not a standalone dashboard first. |
| BAM-11 | resize | Preserve AMS observation and consumption reconciliation, but integrate with Spoolman rather than owning a duplicate inventory product. |
| BAM-12 | keep | Keep MED after BAM-16: responsive read-only viewing is valuable, but it does not mitigate the security or reliability gaps. |
| BAM-13 | blocked | Timelapse needs a stable, authorized camera path; retain as a future derivative of BAM-25, not a separate near-term item. |
| BAM-14 | reprioritize | Defer to LOW: G-code visualization is useful only if local file acquisition and accurate toolhead semantics are reliable; it does not improve unattended operation. |
| BAM-15 | merge | Merge delivery channels into BAM-26 and BAM-22; notifications should derive from a normalized event model, not parallel alert plumbing. |
| BAM-16 | reprioritize | Move to first planned UI/control work and split authentication, authorization, and audit (BAM-29); the prompt-confirmed unauthenticated LAN command path makes this foundational. |
| BAM-17 | blocked | Do not build a general queue on top of cloud MQTT; Bambu’s own local Farm Manager now provides queueing, and authorized print control is firmware-sensitive. [Bambu Farm Manager announcement](https://blog.bambulab.com/bambu-lab-introduces-local-fleet-control-with-bambu-farm-manager/) |
| BAM-18 | resize | Keep, but start with advisory power telemetry and circuit limits (BAM-28); automated plug switching should wait for roles, audit, and explicit safety design. |

## Outlier ledger

| Idea | Why it is deliberately outside the ranked 12 | Trigger to revisit |
|---|---|---|
| Cloud-MQTT exit plan | A parallel LAN/official-adapter abstraction may become necessary if cloud account tokens, rate limits, or policy make monitoring unreliable. | Repeated cloud reconnect/authorization incident or documented API withdrawal. |
| Bambuzle as “printer observability appliance” | Focus on evidence, health, retention, and integrations; explicitly refuse to be a slicer/queue/control suite. | Users need local audit and monitoring more than job dispatch. |
| OpenTelemetry traces for every print lifecycle | Valuable for a larger fleet but excessive before Prometheus metrics and retention basics. | Multi-host deployment or difficult intermittent transport bugs. |
| External camera correlation | Pair a generic RTSP/USB camera with telemetry to avoid vendor camera transport dependence. | BAM-25 proves vendor camera access too brittle. |
| Maintenance prediction | Forecast service from hours/anomaly trends only after BAM-23 has enough quality history. | Several months of clean, retained fleet data. |

## Recommendations (prioritized)

1. Adopt BAM-19, BAM-20, and BAM-21 as the next reliability spine; add no new command path before BAM-16 and BAM-29.
2. Treat cloud MQTT as an adapter with explicit health/capability reporting; never make it the sole prerequisite for historical data, backups, or local dashboard access.
3. Re-scope BAM-11, BAM-15, BAM-18, and BAM-10 into the linked candidates above; block BAM-13 and BAM-17 pending capability/authorization evidence.
4. Start with the BAM-24 field snapshot and BAM-23 maintenance ledger to turn already-received data into immediate operator value.

## Implementation guardrails for the first reliability tranche

| Concern | Guardrail | Acceptance signal |
|---|---|---|
| Transport churn | Preserve the last successful state with `observedAt`; show stale rather than silently showing “online.” | UI and `/metrics` report state age independently of TCP connection state. |
| Cloud loss | Do not purge a known printer or its history when account discovery fails. | Restart with failed auth still serves historical data and readiness explains degraded transport. |
| Local probing | Probes must be opt-in per printer and rate-limited; never scan arbitrary subnets. | A configuration record names the exact local endpoint and last probe result. |
| Raw payloads | Retain bounded redacted diagnostics, not indefinitely growing full MQTT blobs. | Debug capture excludes token/account material and has a TTL. |
| SQLite backup | Back up a consistent database snapshot, not a copied live WAL file. | Restore into an empty test path passes integrity check and row-count smoke test. |
| Migrations | Version migrations and create a pre-migration backup before destructive schema work. | Upgrade can be simulated twice with idempotent result. |
| Rollups | Compute aggregates transactionally and only delete raw rows after successful aggregate verification. | Re-running compaction does not double-count or create time gaps. |
| Metrics cardinality | Use printer IDs only from configured inventory; never label samples by task ID/file name. | `/metrics` remains bounded after many jobs. |
| HA republish | Use a distinct local broker/topic namespace and a read-only payload contract. | No message can cause a Bambuzle or printer command. |
| Authentication | Apply requester authentication before exposing raw diagnostics, backup actions, or commands. | An unauthenticated request receives no printer detail beyond a deliberate public health policy. |
| Audit trail | Log attempted as well as successful control actions, including authorization denial. | Operator can answer who/what/when/result for any command. |
| Camera | Terminate or proxy only explicitly configured local streams; do not weaken TLS globally. | Unsupported model shows an actionable capability reason, not a blank tile. |

### First-slice sequencing

1. Add BAM-19’s typed capability record and a read-only status endpoint; do not change printer control behavior.
2. Add BAM-20 health/readiness and test backup/restore against a representative database copy.
3. Add BAM-21 aggregation only after backup works, then point wide-range charts to rollups.
4. Add BAM-22 metrics and read-only local republish, documenting the stable payload contract.
5. Add BAM-23/24 views once the data lifecycle and access policy are explicit.

This order intentionally delivers operational confidence before more widgets. The existing application has a single process-level live-state map and in-memory sampling timestamps, so restart behavior and data recovery must be visible before it is trusted as an unattended appliance. `src/index.js:20-34` `src/index.js:291-300`

### Scope boundaries

- This research does not recommend reverse-engineering authorization, bypassing Bambu Connect, or enabling Developer Mode automatically.
- A “local-first” architecture means locally retained data and an adapter seam—not a claim that every printer/model exposes equivalent LAN telemetry or control.
- BAM-17 is intentionally not renamed as a smaller queue in this tranche; a read-only future-availability view is acceptable, but job dispatch inherits firmware authorization risk.
- Existing raw MQTT handling should be reviewed for field/schema drift per model before any field is used as a safety decision.
- No analytics-derived maintenance recommendation should be framed as predictive maintenance until a minimum history and false-positive review are agreed.

## Decision Recommended

> **Founder vote needed:** n/a

## Sources

- [Bambu Lab: Firmware Update Introducing New Authorization Control System (2025-01-16)](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/) — official authorization boundaries and monitoring/control distinction.
- [Bambu Lab: Updates and Third-Party Integration with Bambu Connect (2025-01-20)](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/) — optional LAN Developer Mode and Bambu Connect positioning.
- [Bambu Lab: Local Fleet Control with Bambu Farm Manager (2025-07-03)](https://blog.bambulab.com/bambu-lab-introduces-local-fleet-control-with-bambu-farm-manager/) — official local farm-management direction.
- [ha-bambulab LAN-mode issue #1584](https://github.com/greghesp/ha-bambulab/issues/1584) — 2025 field report of model/firmware-specific local MQTT failure.
- [ha-bambulab issue #1460](https://github.com/greghesp/ha-bambulab/issues/1460) — representative 2025 `push_status` payload field inventory.
- [Spoolman automatic usage tracking](https://github.com/Donkie/Spoolman/wiki/Automatic-Filament-Usage-Tracking) — self-hosted API-centric printer integration model.
- [SimplyPrint print-farm features](https://simplyprint.io/print-farms) and [analytics](https://simplyprint.io/features/statistics) — maintenance and quality/usage analytics precedent.
- `src/bambu/message-parser.js:47-145` — normalized current MQTT state and omitted fields.
- `src/bambu/mqtt-client.js:35-153` — cloud MQTT transport, merged raw state, and command path.
- `src/index.js:38-230` and `src/index.js:291-323` — server lifecycle, scheduled retention, state fan-out, and sampling.
- `src/db/database.js:23-173` — SQLite schema and migrations.
- `ROADMAP.md:37-178` — BAM-9 through BAM-18 scope and existing camera/filament designs.
