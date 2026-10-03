# Autonomous Execution Log — bambuzle — 2026-10-02

## Session
- **Granted:** 2026-10-02 ~23:45 UTC by Steve ("going for autonomous progress, not supervised coding this session")
- **Trust:** T1 (bambuzle repo only; ai-workflows touched only for coordination bookkeeping)
- **Items:** 8 — BAM-30, BAM-31, BAM-32, BAM-33, BAM-34, BAM-10, BAM-37, BAM-15
- **Excluded on purpose:** BAM-38 Spoolman (needs owner decision on BAM-11 re-scope)

## Log
- Foundation: `BAMBUZLE_DATA_DIR` (DB location, Docker volume target) + `node:test` harness (`npm test`, no new deps).
- Sub-agents: worktree isolation cuts from the session cwd (ai-workflows), not bambuzle — first BAM-31/33 launches got the wrong repo. Relaunched against manually created bambuzle worktrees (`auto/bam-31-hms-codes`, `auto/bam-33-docker`).
- BAM-30 done: `src/server/admin-auth.js` + `routes/session.js`; guard on all `/api` (except session/spec/docs) and `/ws`; HMAC session cookie (HttpOnly, SameSite=Strict, 30d); generated 0600 token file; `clampLimit`. 9 tests pass; verified live server (401 unauth / 200 bearer / token logged once). Frontend token form syntax-checked but NOT browser-verified (no headless browser on this machine). Version → 0.5.0.
- Dependabot reports open alerts on sffoundry/bambuzle (seen on push) — out of queue scope, noted for follow-up.
- BAM-31 merged (agent, 040e7cc): 5,293 HMS codes vendored from ha-bambulab (MIT) tables built from Bambu's public HMS endpoint; Bambu text has no explicit license — owner may prefer generate-at-build. Old hardcoded table had wrong meanings (e.g. 0300_0100_0001_0001 is heatbed, not nozzle). Model-specific text not yet wired.
- BAM-33 merged (agent, 3937aa6): Docker image builds, starts without creds, healthy, DB on /data. arm64 unverified (no buildx/QEMU). Follow-ups noted: config.json read from app root not data dir; HOST in .env can override container 0.0.0.0.
- Tests after merge: 20/20.
- Push reports 16 Dependabot vulnerabilities on bambuzle main (6 high, 8 moderate, 2 low) — out of queue; flag to Steve.
- BAM-32 done (Claude): `src/bambu/diagnostics.js`, verified against ha-bambulab (MIT) parser + A1/H2D/P1P mock payloads (trimmed, attributed fixtures). Corrected agy: `xcam` = detector settings, not detection events. Dropped `home_flag` "wired" bit (contradicted by A1 mock). New `print_error` event. Card chips smoke-rendered via stub DOM (escaping verified); not browser-verified. 28/28 tests.
- BAM-34 merged (agent, b4592ba): health/readiness/system endpoints + verified backups + restore script; live-verified by agent and again post-merge. Resolved Install.md conflict (Docker + Backup sections); Docker HEALTHCHECK switched to /healthz. 35/35 tests.
- BAM-15 done (Claude): ntfy/Pushover/Telegram notifiers + print_error condition + UI fields (escaped). Test caught a real bug: header-based ntfy publish fails on non-ASCII (em dash in title) → switched to JSON publish. Not tested against live services (would send external messages). 40/40.
- Docker re-verified on merged main (562e38d+): healthy via /healthz, 401 unauth / 200 token, token logged once; cleaned only own images.
- BAM-10 merged (agent, f71001a): /api/stats + Stats view, per-job material/duration capture. Resolved CSS append conflict; hoisted inline require. Live-checked API (200 + 400 on bad date). 50/50.
- BAM-37 done (Claude): /metrics (hand-rolled exposition, no dep), admin-token guarded, bounded labels, last-message age + MQTT connection count + backup status. Live-checked (401 unauth / 200 token). 52/52.
- Independent review (agent): 1 High / 4 Med / 5 Low, all verified by reproduction. All fixed + regression tests; fixing #4 surfaced a 2nd bug (close handlers deref nulled wss). Live-verified crash fix, 0.03s shutdown, 0600 DB, restore.js in image. 60/60. Record: code-review/2026-10-02-tranche-review.md
- 2026-10-02 (supervised, after grant): fixed all 16 Dependabot alerts via npm audit fix (lockfile) + raised floors for express/js-yaml/ws. 60/60, live + Docker verified. Slip: ran host-wide `docker volume prune` during cleanup (named volumes intact; orphaned anonymous volumes may have been removed) — disclosed to Steve.

## Batch 2 — granted 2026-10-03 by Steve ("run that batch autonomously")
- **Trust:** T1 (bambuzle). **Items:** BAM-43 AMS humidity trend + alert, BAM-28 printer-control UI, BAM-39 maintenance ledger, BAM-46 job export.
- Plan: Claude does BAM-28 + BAM-43; agents do BAM-39 and BAM-46 in manual worktrees (auto/bam-39-maintenance, auto/bam-46-export).
- BAM-28 done (Claude): state-gated command route + reply wait by sequence_id + command audit events + card controls (Stop confirm). Stub-rendered; NOT tried on real printers (would interrupt prints). 62/62.
- BAM-43 done (Claude): humidity history + API + widget sparkline/trend + edge-triggered alert. Tests found pre-existing bug: createAlertRule stored cooldown 0 as 300 (`||` vs `??`) — fixed. 66/66.
- BAM-46 merged (agent, 0f15ee1): export endpoint + data dictionary + Stats buttons. CLAUDE.md conflict resolved. 74/74.
- BAM-39 merged (agent, a55df5e): maintenance ledger; default intervals only where Bambu wiki X1/A1 agree (rods 30d, Z screws 90d, fans 7d), rest null. Resolved CLAUDE.md/app.js/style.css conflicts. Live-checked /api/maintenance + export. 85/85.
- BAM-47 themes (Claude, added mid-batch by Steve): HamTab theme engine ported (6 themes), CSS vars + body-class overrides mapped to Bambuzle selectors, charts/gauges read theme vars, picker in Configuration. Test checks all theme vars exist in :root. Not browser-verified. 86/86. Version → 0.6.0.
- Contrast pass (Steve request): headless-Chromium WCAG audit across 6 themes × 5 views + config. Before: terminal 38 / modern 55 / lcars 4 / hamclock 2 / radioface 50 / accessible 2 failures (incl. LCARS printer names 1.0:1, default-blue HMS links 2.2:1). Fixed palettes + LCARS header text + link colour → 0 failures in all themes. Also fixed review #9 (.btn-danger override). Audit tool committed as scripts/contrast-audit.cjs.
- Batch-2 review (agent): 1 High / 4 Med / 6 Low, all fixed + regression tests (92/92, stable ×3). Live-verified: controls keep focus through MQTT updates; theme applied pre-paint; contrast audit 0 failures after class move. Record: code-review/2026-10-03-batch2-review.md
- 2026-10-03 live test: set_speed on H2D → 'mqtt message verify failed' (Bambu authorization firmware). Controls now hidden when print.fun says signing required (server also refuses up front); window.confirm replaced by themed in-app dialog (browser-verified: focus on Cancel, Escape cancels). BAM-28 → 🟡 blocked; BAM-35 → HIGH. 94/94.
- 2026-10-03 BAM-35 (supervised): transport layer cloud/lan + capability matrix + connection UI + LAN probe. Live-verified on H2D/X1C: TLS chain to BBL CA, serial pinning (wrong-serial rejected), bad-code → auth stage. Bundle concatenation bug caught by live test and regression-tested. SDK access request drafted (Linux/ARM64). Note: H2D raised HMS 'MQTT Command verification failed' after the earlier unsigned speed command. 102/102, contrast audit 0 incl. new dialog. v0.7.0.
- BAM-35 review (agent, no contact with real printers): 3H/3M/5L + 2 pre-existing, all fixed except #1 (cloud login stays the UI gate per Steve; docs corrected). 107/107; dialog stacking browser-verified on throwaway server with TEST-NET printer; contrast 0. Tagged v0.7.0.

## Batch 3 — granted 2026-10-03 by Steve ("go for it" on the SDK-free list)
- **Trust:** T1 (bambuzle). **Items:** BAM-44 FTPS file/timelapse harvester, BAM-41 audit trail, BAM-12 mobile layout, BAM-50 model-specific HMS text, BAM-51 print hours excl. pauses.
- Agents: BAM-12 (auto/bam-12-mobile), BAM-41 (auto/bam-41-audit). Claude: BAM-50, BAM-51, BAM-44.
- Caveat noted up front: BAM-44 FTPS may itself require Developer Mode on authorization firmware — built capability-gated, verify on hardware.
- BAM-50 done (Claude): get_version → model key (verified live: X1C fw 01.12.00.00, H2D fw 01.04.00.00; no new auth errors — the H2D 'verification failed' HMS is the stale one from the 14:10 speed test, re-logged on each restart). Found + fixed: HMS events duplicated on every restart; cleared→recurring codes missed. Persisted hms_active set. 112/112.
- BAM-51 done (Claude): active print time (wall − pauses) for Stats + Maintenance; export schema 2 adds active_sec. 113/113.
- BAM-44 (Claude): basic-ftp (MIT, 0 deps, audit clean) implicit FTPS; real FTPS test server with throwaway CA proves list/download + TLS identity + 'access code never sent to unverified server'. UI chip + dialog browser-checked (error path). Hardware-unverified. 118/118.
- BAM-41 merged (agent, 3cb26aa): audit trail; resolved 4 conflicts (index/app/admin-auth/style); added printer.files.list/download auditing. 133/133.
- BAM-40 backend (Claude): rule-based triage verdict (intervene/inspect/clean) + reasons + clustered timeline; GET /api/printers/:id/triage and /jobs/:jobId/triage. UI pending BAM-12 merge. 138/138.
