# Research Prompt: Bambuzle Enhancement Discovery (beyond BAM-18)

> **Date:** 2026-10-02
> **From:** Claude (Steve-claude pair)
> **To:** Codex (CODEX-SF371) and agy (AGY-SF002) — **identical prompt, blind xval pair**
> **Repo:** `sffoundry/bambuzle`
> **Analytic mode:** divergent discovery → convergent ranking

Do **not** read the other partner's output. Each deliverable must stand on its own; Claude merges them afterwards.

---

## Background (already verified, so don't re-derive it)

Bambuzle is a self-hosted monitoring dashboard for BambuLab printers: Node.js + Express + better-sqlite3 + uPlot, vanilla-JS frontend, v0.4.1, about 4.9K LOC. It connects to **BambuLab Cloud MQTT**, stores telemetry in SQLite and pushes live state over WebSocket.

**Already shipped:**
- BAM-1..8: status cards, history charts, event log, webhook alert rules, multi-printer, H2D dual-nozzle, cloud MQTT, SQLite.
- Shipped Feb 2026 but **not on the roadmap**: anomaly capture (layer transitions, temp anomalies, job pauses: `src/anomaly/detector.js`), 6 extra MQTT chart types, progress gauges, AMS widget, Swagger at `/api/docs`, printer commands (pause/resume/stop/speed: `src/bambu/commands.js`), and login rate limiting.

**SQLite tables:** printers, print_jobs, samples, events, layer_transitions, temp_anomalies, job_pauses, auth_tokens, alert_rules.

**Already planned (don't re-propose; you may critique them):**
- BAM-9: live camera (LAN)
- BAM-10: job statistics
- BAM-11: filament inventory
- BAM-12: mobile layout
- BAM-13: timelapse
- BAM-14: G-code viewer
- BAM-15: push channels
- BAM-16: multi-user auth
- BAM-17: print queue
- BAM-18: power tracking

The specs for these are in `ROADMAP.md` § Detailed specs. Prior research (`research/2026-03-14-codex-bambuzle-*.md`) is thin, one paragraph per item.

**Known security gap:** the dashboard has no requester authentication. The `/api/printers/:id/command` "auth check" only verifies that the *server* is logged into Bambu Cloud, so any LAN client can stop a print. Telemetry APIs are open and the history `limit` is uncapped. Treat this as context. It's input to BAM-16 prioritization, not something for you to fix.

**Sibling project:** `sffoundry/bambu-farm-card`, a Home Assistant card that ports Bambuzle algorithms. Integration ideas that touch it are in scope.

## Questions

1. **Ecosystem shifts since early 2025.** What changed in how third-party tools may talk to Bambu printers? Cover the authorization firmware, Bambu Connect, LAN-only and Developer Mode, cloud MQTT stability and rate limits, and any ToS or enforcement events. For each change, state which current or planned Bambuzle features it threatens or enables. **This is the most important question.** If the cloud-MQTT foundation is at risk, say so first.
2. **Competitive and adjacent tools.** What do comparable tools offer that Bambuzle lacks? Include Bambu Handy, Bambu Studio's device/farm views, Bambu Farm Manager, ha-bambulab, OctoEverywhere/Obico (AI failure detection), SimplyPrint, Printago, Spoolman, BambuBoard, and anything newer you find. For each tool, list only the deltas worth stealing for a **self-hosted, single-operator-to-small-farm** user.
3. **Unused data.** Which MQTT report fields does Bambuzle receive but ignore? Check `src/bambu/message-parser.js` against the full `push_status` payload. Look at HMS detail, xcam/AI flags, nozzle type and diameter, chamber/aux fans, firmware/upgrade state, SD/storage, and network RSSI. For each field, what feature does it unlock cheaply?
4. **Operability.** What does it take to run this for months unattended? Consider Docker/Compose packaging, data retention and downsampling for `samples`, backup, health endpoint, Prometheus/OpenTelemetry export, MQTT re-publish to Home Assistant, and upgrade/migration safety.
5. **Critique of BAM-9..18.** Which planned items are mis-sized, mis-prioritized, blocked by Q1 findings, or should be merged or split? Name the IDs explicitly.

## Deliverable shape (stop rule)

Produce **exactly one markdown file of 200–350 lines** containing:

1. A 5-line **executive summary**. The Q1 risk verdict goes first.
2. **Exactly 12 ranked new-enhancement candidates** in roadmap-row format:
   `| Proposed ID (BAM-N?) | Feature | Priority (HIGH/MED/LOW) | Effort (XS–XL per ROADMAP legend) | Depends on | Evidence (URL or file:line) |`
   Then add 2–4 sentences per candidate on why it matters and the first slice.
3. A **BAM-9..18 critique table** with columns `ID | Verdict (keep / resize / reprioritize / merge / drop / blocked) | Reason`.
4. An **Outlier ledger** of 3–6 weird, adjacent or contrarian ideas, kept separate from the ranked 12. Examples of the kind of thing: a different product framing, or dropping cloud MQTT entirely.
5. **Sources**: every external claim needs a URL, and every repo claim needs a `file:line`.

Don't draft a larger hidden inventory to cut down later. Hold to 12 + ledger.

## Workflow guardrails

- **Three passes, no backtracking.** Pass 1: one bounded skim of `ROADMAP.md`, `repo-context.json`, `src/bambu/*` and `src/db/database.js`, then use only grep and line-ranged reads. Pass 2: external capture, issuing **parallel targeted queries per cluster** (one cluster each for firmware/auth, competitors, MQTT fields and ops). No combined mega-queries. Pass 3: rank and write.
- **Keep the outlier ledger running throughout** instead of re-scanning broad context at the end.
- **Tag dates on fast-moving claims.** Bambu firmware and policy change frequently, so date every claim about them and prefer primary sources (Bambu wiki/blog/forum staff posts, GitHub issues on ha-bambulab and similar projects).

## Output and registration

- Codex writes to `bambuzle/research/codex/2026-10-02-codex-bambuzle-enhancement-discovery.md`.
- agy writes to `bambuzle/research/agy/2026-10-02-agy-bambuzle-enhancement-discovery.md`.

**Registration happens after the research is done.** When the deliverable is finished, run `aiw research submit <your ID>` (CODEX-SF371 / AGY-SF002) and commit and push the file. Don't work on registration problems while you are researching.
