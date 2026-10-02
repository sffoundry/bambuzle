# Bambuzle Enhancement Discovery: Xval Merge

> **From:** Claude (Steve-claude pair)
> **Date:** 2026-10-02
> **Inputs:** CODEX-SF371 (`research/codex/2026-10-02-codex-bambuzle-enhancement-discovery.md`, 204 lines) × AGY-SF002 (`research/agy/2026-10-02-agy-bambuzle-enhancement-discovery.md`, 336 lines). The prompt was identical and each partner worked blind.
> **Verification:** I re-checked the repo claims against the source and the firmware/policy claims against Bambu's own posts (see § Verification).

## Verdict

1. **The cloud-MQTT foundation is safe for monitoring and unsafe for control.** Bambu's Jan-2025 authorization post explicitly leaves "MQTT status push for tools like HomeAssistant" unaffected. It gates print start, motion, temperature, fans, AMS, video and firmware. Pause/resume/stop isn't listed either way. **Codex's framing is correct. agy overstated the threat:** "mandatory Cloud 2FA" and "commands systematically rejected (HMS_0500-0500-0001-0007)" don't appear in Bambu's posts and are unverified.
2. **Both partners independently reached the same strategy:** turn Bambuzle into a reliable, local-first *observability* appliance, not a control or queue suite. Specifically: reliability infrastructure (health, backup, retention, metrics), surface the MQTT data already received, integrate with Spoolman instead of building inventory, block BAM-17, and promote auth.
3. **The most urgent item is auth.** The gap is wider than either partner scoped (see `code-review/2026-10-02-manual-review.md`). Any LAN client can stop a print, re-point or log out the server's Bambu Cloud session, and add webhook rules that exfiltrate telemetry.

## Agreement map

| Theme | Codex | agy | Merged → |
|---|---|---|---|
| Health/readiness + metrics | BAM-20, 22 | BAM-29 | BAM-34, BAM-37 |
| Retention rollups | BAM-21 | BAM-20 | BAM-36 (agy's volume figures corrected: see below) |
| Spoolman instead of bespoke BAM-11 | BAM-27 | BAM-21 | BAM-38 |
| Maintenance ledger | BAM-23 | BAM-28 | BAM-39 |
| Unused MQTT fields (xcam, nozzle, upgrade, net) | BAM-24 | BAM-23 | BAM-32 |
| HA MQTT bridge (read-only) | BAM-22 | BAM-30 | BAM-42 |
| BAM-16 split/promote | reprioritize + split | split 16A/16B | BAM-30 (interim) + BAM-16 (full) |
| BAM-17 queue | blocked | blocked | blocked: Bambu Farm Manager (free, local, has queueing) already covers it |

**Codex only:** backup/restore, operator audit trail, anomaly-triage timeline, power circuit policy, job export, capability-gated camera.
**agy only:** full HMS dictionary (verified: only 25 codes hardcoded, `src/utils/hms-codes.js`), Docker packaging (verified: none in repo), FTPS SD-card timelapse harvester, AMS humidity tracker, compact fleet matrix view.

## Disagreements resolved

| # | Topic | Codex | agy | Resolution |
|---|---|---|---|---|
| D1 | Severity of the cloud risk | Monitoring OK, control gated | "Existential", commands rejected | **Codex.** Matches Bambu's primary source. |
| D2 | Local LAN path | Detect capability first; don't assume | LAN MQTT failover via Developer Mode | **Codex first, agy as opt-in adapter.** Developer Mode is explicitly "not officially supported" (Bambu, 2025-01-20), so it can't be the default path. BAM-35 capability matrix comes before any LAN/FTPS/camera work. |
| D3 | BAM-10 statistics | Merge into ledger/export | Promote to HIGH, size S | **Keep standalone, size S.** It's the shared query layer that BAM-39, BAM-46 and the dashboard all need. |
| D4 | BAM-13 timelapse | Blocked on camera | Drop; harvest the printer's own MP4s over FTPS | **agy's approach is better**, but FTPS needs the LAN access code, so it's gated on BAM-35 → BAM-44. |
| D5 | BAM-15 push channels | Merge into the event model | Elevate to HIGH | **Elevate, built on one normalized alert event.** Ship ntfy first; webhook already exists. |
| D6 | BAM-12 mobile / BAM-14 G-code | MED / LOW | HIGH / drop | **Owner call.** No evidence either way beyond opinion. |
| D7 | Fleet matrix (agy BAM-25) | — | Includes "emergency pause/stop buttons" | **Accept view, reject buttons** until BAM-30 lands. As written it would put an unauthenticated stop button on every LAN screen. |

## Findings neither partner made (Claude)

- **Auth scope:** `/api/auth/login|verify|logout` and `/api/alerts` writes are open too (H2, M1 in the code review). The server binds `0.0.0.0` by default (`src/config.js:40`).
- **Account-ban exposure:** Bambu has temporarily banned accounts holding more than 50 concurrent cloud MQTT connections ([forum](https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440)). Bambuzle holds one per printer and destroys old clients on re-auth (`src/index.js:128-132`), so the risk is low today. BAM-34/37 should still expose the connection count, and reconnect storms should back off.
- **agy's volume claim corrected:** sampling is every 5 s while printing and every 30 s idle (`src/config.js:28-29`), not every 1–2 s. That's about 17K rows per printer per printing day, not 50K. Rollups still matter for multi-month use but aren't urgent → MED, not HIGH.

## Merged candidates (proposed IDs; BAM-19..29 are now the shipped-work backfill)

| ID | Feature | Priority | Effort | Depends on | Source |
|---|---|---|---|---|---|
| BAM-30 | Interim requester auth (admin token on mutating routes) + query `limit` caps | HIGH | S | — | both + Claude |
| BAM-31 | Full HMS code dictionary with wiki links | HIGH | S | — | agy |
| BAM-32 | Surface unused MQTT fields: xcam AI flags, nozzle type/diameter, upgrade state, network | HIGH | M | — | both |
| BAM-33 | Docker/Compose packaging (amd64 + arm64) | HIGH | S | — | agy |
| BAM-34 | Health/readiness endpoints + SQLite backup & restore | HIGH | M | — | Codex (+agy) |
| BAM-35 | Per-printer connection capability matrix (cloud / LAN / Dev Mode / camera) | MED | M | — | Codex |
| BAM-36 | Telemetry rollups and tiered retention | MED | L | BAM-34 | both |
| BAM-37 | Prometheus `/metrics` (incl. MQTT connection count, last-message age) | MED | S | BAM-34 | both |
| BAM-38 | Spoolman integration (supersedes bespoke BAM-11 inventory) | MED | M | — | both |
| BAM-39 | Maintenance ledger (print hours, service intervals, repeat HMS) | MED | M | BAM-10 | both |
| BAM-40 | Print-failure triage timeline (anomalies + xcam + HMS) | MED | M | BAM-32 | Codex |
| BAM-41 | Operator audit trail (auth, config, command attempts) | MED | M | BAM-30 | Codex |
| BAM-42 | Home Assistant MQTT discovery bridge (read-only) | LOW | M | BAM-34 | both |
| BAM-43 | AMS humidity / desiccant trend + alert | LOW | S | — | agy |
| BAM-44 | SD-card timelapse/file harvester over FTPS (replaces BAM-13 approach) | LOW | M | BAM-35 | agy |
| BAM-45 | Compact fleet matrix view (read-only) | LOW | M | — | agy |
| BAM-46 | Job data export (CSV/JSON + data dictionary) | LOW | S | BAM-10 | Codex |

**Folded, not separate:** Codex's power-circuit safety policy goes into BAM-18 as "advisory only; no plug switching before BAM-16". The outlier ledgers (sovereign LAN appliance, multi-vendor fleet via Moonraker/PrusaLink, cost/quoting engine, TUI, external-camera correlation) stay in the partner docs as "revisit if" triggers.

## Suggested first tranche

1. **BAM-30** (S) + reopen of H1/H2/M1/M3: before any other feature.
2. **BAM-31 + BAM-32** (S + M): immediate operator value from data already arriving.
3. **BAM-33 + BAM-34** (S + M): make it safe to leave running.
4. **BAM-10 at size S, then BAM-38**: replaces the stalled BAM-11 XL spec.

Everything that touches LAN, camera or FTPS waits behind BAM-35.

## Owner decisions needed (Francisco)

- Adopt the tranche order above, and BAM-16 → BAM-30 interim split?
- Re-scope BAM-11 → BAM-38 (Spoolman), and mark BAM-17 ➖ given Bambu Farm Manager?
- D6: BAM-12 mobile and BAM-14 G-code priorities.

## Verification

- [Bambu, Authorization Control System (2025-01-16)](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/): status push unaffected; print start/motion/temp/fans/AMS/video/firmware gated; no mention of 2FA or Developer Mode.
- [Bambu, Bambu Connect & third-party integration (2025-01-20)](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/): Developer Mode leaves MQTT, live stream and FTP open but is "not officially supported".
- [Bambu Farm Manager](https://blog.bambulab.com/bambu-lab-introduces-local-fleet-control-with-bambu-farm-manager/): free, local, Windows; monitoring, batch control, queueing, staggered power-up.
- [Bambu forum, MQTT limitations](https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440): bans for more than 50 concurrent connections.
- Repo checks: `src/config.js:28-29,40`; `src/utils/hms-codes.js` (25 codes); `src/bambu/message-parser.js:125-145` (no xcam/nozzle/upgrade; raw `ams` passed through); no Dockerfile; `src/index.js:128-132`.
