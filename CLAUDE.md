# Bambuzle — Claude Project Instructions

## Project Overview

Bambuzle is a self-hosted BambuLab 3D printer monitoring dashboard.
Stack: Node.js, Express, SQLite (better-sqlite3), MQTT, WebSocket, uPlot.

## Architecture

```
BambuLab Cloud (MQTT)
  └─> src/bambu/mqtt-client.js — per-printer MQTT connection
        └─> src/bambu/message-parser.js — deep-merge partial updates, extract state
              └─> src/index.js — job tracking, sampling, HMS errors, alert evaluation
                    ├─> src/db/queries.js — SQLite writes (samples, events, jobs)
                    └─> src/server/websocket.js — broadcast to dashboard clients

Browser
  └─> public/js/app.js — main entry, WebSocket handler, event table
        ├─> public/js/dashboard.js — printer cards
        ├─> public/js/charts.js — uPlot temperature/progress charts
        ├─> public/js/stats.js — Stats view (job totals, by printer/material/day)
        ├─> public/js/maintenance.js — Maintenance view (service tasks, repeat errors)
        ├─> public/js/alerts-ui.js — alert rules CRUD
        └─> public/js/audit.js — Audit view (operator audit trail, BAM-41)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/config.js` | Loads .env + optional config.json |
| `src/db/database.js` | SQLite schema, migrations (idempotent ALTER TABLE pattern) |
| `src/db/queries.js` | All SQL queries |
| `src/db/maintenance.js` | Maintenance ledger queries: print hours, task status, service log, repeat HMS, default task templates (BAM-39) |
| `src/db/backup.js` | Online SQLite backups (verify, sha256, prune, cron) |
| `scripts/restore.js` | Offline restore CLI (`npm run backup:restore`) |
| `src/bambu/mqtt-client.js` | Printer transport (kind `cloud` / `lan`): connect options incl. LAN TLS (Bambu CA bundle in `src/bambu/certs/`, identity pinned to serial), pushall, `sendCommandAwaitReply` — contract in `docs/architecture-transports.md` |
| `src/printers/transport-policy.js` | Which transport per printer + capability matrix (`control`: available / signature_required / unknown / offline) + input validation |
| `src/db/printer-connections.js` | Connection settings; the ONLY reader of `printers.lan_access_code` (secret, never returned by the API) |
| `src/printers/printer-files.js` | SD-card files over implicit FTPS (BAM-44): list/download, path allow-list, one session per printer, reuses LAN TLS policy |
| `src/server/routes/printer-files.js` | `/api/printers/:id/files[/download]` (private under public-read) |
| `src/server/routes/printer-connections.js` | Connection settings API, LAN connection test, hand-added LAN printers |
| `src/bambu/message-parser.js` | MQTT message parsing, `extractPrinterState()` |
| `src/bambu/diagnostics.js` | `state.diagnostics`: nozzles, firmware update, xcam AI-monitor *settings*, SD, IP, camera, AMS humidity, print_error, dev mode (BAM-32) |
| `src/bambu/mqtt-client.js` | Per-printer MQTT connection manager |
| `src/bambu/auth.js` | BambuLab Cloud authentication |
| `src/server/app.js` | Express app setup, static files, route mounting |
| `src/server/routes/api.js` | Printer/event REST endpoints |
| `src/server/routes/auth.js` | Login/verify/logout endpoints |
| `src/server/routes/alerts.js` | Alert rules CRUD endpoints |
| `src/server/routes/maintenance.js` | `/api/maintenance` — maintenance tasks CRUD, mark done, templates (BAM-39) |
| `src/server/routes/system.js` | `/healthz`, `/readyz`, `/api/system` |
| `src/server/websocket.js` | WebSocket broadcast to dashboard |
| `src/server/routes/metrics.js` | `GET /metrics` Prometheus exposition, admin-token guarded (BAM-37) |
| `src/integrations/ha-bridge.js` | Read-only Home Assistant MQTT discovery bridge (BAM-42); publish-only, never subscribes |
| `src/db/rollups.js` | Hourly telemetry rollups + tiered retention; `getHistory` (rollups + raw, bucketed to the limit) backs `/history` (BAM-36) |
| `src/db/ams-humidity.js` | AMS humidity history (self-creating table), recorded from `state.diagnostics.amsHumidity` (BAM-43) |
| `src/alerts/engine.js` | Alert condition evaluation (incl. `print_error`, BAM-15) |
| `src/alerts/notifiers/` | console, webhook, `push.js` (ntfy JSON-publish, Pushover, Telegram) |
| `src/index.js` | Main entry — orchestrates MQTT, sampling, jobs, alerts |
| `public/index.html` | Single-page dashboard HTML |
| `public/js/app.js` | Frontend entry — auth, WS, views, events |
| `public/js/dashboard.js` | Printer card rendering |
| `public/js/themes.js` | Theme engine (6 themes from HamTab), `themeVar()` for canvas/SVG colours, `bambuzle:themechange` event |
| `public/js/charts.js` | uPlot chart rendering |
| `public/js/stats.js` | Stats view — job statistics (`/api/stats`), Export CSV / JSON links |
| `src/server/routes/export.js` | `GET /api/export/jobs` CSV/JSON job export (BAM-46) |
| `src/db/export.js` | Export SQL + versioned column set; columns documented in `docs/export-data-dictionary.md` |
| `public/js/maintenance.js` | Maintenance view — tasks, due badges, service log, repeat errors (`/api/maintenance`) |
| `src/db/audit.js` | Operator audit trail (BAM-41): self-creating `audit_log` table, append-only (`insertAudit`, `queryAudit`, retention-only `deleteOldAudit`) |
| `src/server/audit.js` | `audit(req, { action, target, result, detail })` helper, throttled `auditThrottled` for denials, `attachAuditActor` (actor = `admin-token` / `session` / `anonymous`) |
| `src/server/routes/audit.js` | `GET /api/audit`, `GET /api/audit/export?format=csv` (BAM-41) |
| `public/js/audit.js` | Audit view — filterable trail (range / action category / result), Download CSV |
| `src/utils/material.js` | Active AMS tray → filament type/colour (job material capture) |

## API Endpoints

### Health (public, outside the /api guard — BAM-34)
- `GET /healthz` — liveness (SQLite `SELECT 1`); 200 / 503
- `GET /readyz` — readiness; 503 only if the DB is down, otherwise 200 `ok` or `degraded` (no Bambu login, no printers connected, last backup failed). Coarse counts only, no device IDs

### System (guarded)
- `GET /api/system` — version, uptime, data dir, DB size + row counts, backup schedule + last result
- `POST /api/system/backup` — run a verified online backup now (`src/db/backup.js`; restore: `npm run backup:restore -- <file>`)

### Session (dashboard admin token, BAM-30)
- `GET /api/session` — is the token required / is this client signed in
- `POST /api/session` — exchange token for HttpOnly cookie
- `DELETE /api/session` — sign out

Every other `/api/*` route and `/ws` is guarded by `src/server/admin-auth.js` (Bearer token or session cookie).

### Auth (server's BambuLab Cloud login)
- `GET /api/auth/status` — check auth state
- `POST /api/auth/login` — email/password login
- `POST /api/auth/verify` — verification code
- `POST /api/auth/logout`

### Printers
- `GET /api/printers` — list all printers with live state
- `GET /api/printers/:id/history` — sample history (query: from, to, limit)
- `GET /api/printers/:id/events` — events for printer (query: from, to, limit)
- `GET /api/printers/:id/jobs` — print job history
- `GET|PUT /api/printers/:id/connection` — connection mode / LAN host / access code (write-only), `POST /api/printers/:id/connection/test` — LAN probe with stage (BAM-35)
- `POST /api/printers`, `DELETE /api/printers/:id` — hand-added LAN printers only
- `GET /api/printers/:id/ams-humidity` — humidity history per AMS unit (default 7 days)
- `POST /api/printers/:id/command` — pause/resume/stop/set_speed; state-gated (`src/server/printer-commands.js`), waits for the printer's reply, audited as `command` events (BAM-28)

### Stats
- `GET /api/stats` — print job statistics: totals, success rate, by printer / material / day (query: printer, from, to; default last 30 days; bad dates → 400)

### Export (BAM-46)
- `GET /api/export/jobs` — job history download, one row per job (query: format=csv|json, printer, from, to; default all time; cap 50k rows → `X-Bambuzle-Truncated`; CSV formula-injection guarded). Columns: `docs/export-data-dictionary.md` (BAM-46)

### Maintenance (BAM-39)
- `GET /api/maintenance` — per-printer summary: total print hours, task counts (due / due soon / ok / unscheduled)
- `GET /api/maintenance/:deviceId` — tasks with status + hours/days since last done, recent service log, repeat HMS / print_error codes (30d), templates
- `POST /api/maintenance/:deviceId/tasks` — create task (name 1–100, `intervalHours` and/or `intervalDays`, notes, optional `lastDoneAt`)
- `PUT /api/maintenance/tasks/:id` / `DELETE /api/maintenance/tasks/:id` (log cascades)
- `POST /api/maintenance/tasks/:id/done` — log + reset (optional `note`)
- `POST /api/maintenance/:deviceId/templates` — add the recommended task set (idempotent by name)

### Audit (BAM-41) — private even under `BAMBUZLE_PUBLIC_READ`
- `GET /api/audit` — operator audit trail, newest first (query: from, to, action = exact or category prefix, result = ok|denied|rejected|error, limit ≤ 2000; default last 30 days)
- `GET /api/audit/export?format=csv` — same filters, CSV (formula-injection guarded, cap 50k rows). Design: `docs/audit-trail.md`

### Events
- `GET /api/events` — recent events across all printers (query: limit)

### Alerts
- `GET /api/alerts` — list all alert rules
- `GET /api/alerts/:id` — get one rule
- `POST /api/alerts` — create rule
- `PUT /api/alerts/:id` — update rule
- `DELETE /api/alerts/:id` — delete rule

## Code Conventions

- Backend: CommonJS (`require`), strict mode
- Frontend: ES modules (`import/export`)
- Naming: camelCase in JS, snake_case in SQL columns
- CSS: theme-driven — colours ONLY via CSS variables (`var(--text)`, `var(--accent)`, `var(--on-accent)` …) defined per theme in `public/js/themes.js` (ported from HamTab); never hardcode colours. Default theme `terminal` = the original green-on-black. Every theme must pass WCAG AA — run `scripts/contrast-audit.cjs` after any colour/theme change (0 failures across all 6 themes as of 2026-10-03)
- Database migrations: idempotent `ALTER TABLE` wrapped in try/catch

## Security Notes

- BambuLab credentials stored in `.env` (gitignored)
- Dashboard requester auth: shared admin token (`BAMBUZLE_ADMIN_TOKEN` or generated `<data dir>/admin-token`); env `BAMBUZLE_PUBLIC_READ`, `BAMBUZLE_AUTH=off`. Never add an `/api` route outside the guard without a reason.
- `?limit=` params are clamped (`clampLimit` in `routes/api.js`)
- **Audit trail (BAM-41): every new state-changing or security-relevant route must call `audit(req, { action, target, result, detail })` from `src/server/audit.js`** on each exit (ok / rejected / error). `detail` must never hold secret values — record field names or flags (`accessCodeChanged: true`), never access codes, passwords, verification codes, tokens or notifier config. Don't audit plain reads. Retention: `audit.retentionDays` / `BAMBUZLE_AUDIT_RETENTION_DAYS` (default 365, separate from telemetry)
- Frontend uses `escapeHtml()` (via textContent) for all user-visible strings
- No eval, no innerHTML with raw data
- SQLite parameterized queries throughout

## Database Schema

Tables: `printers`, `print_jobs`, `samples`, `events`, `alert_rules`, `maintenance_tasks`, `maintenance_log`, `audit_log` (BAM-41, self-created by `src/db/audit.js`; append-only, ISO-8601 `ts`)

Maintenance (BAM-39): `maintenance_tasks` (interval_hours / interval_days, last_done_at), `maintenance_log` (ON DELETE CASCADE from its task). Print hours reuse the `getJobStats` duration fallback (`JOB_DURATION_SQL`); running jobs excluded. Due at ≥ 100% of either interval, due soon at ≥ 90%.

Job stats columns (BAM-10): `print_jobs.material`, `print_jobs.material_color`, `print_jobs.duration_sec` (nullable; added via migration).

H2D dual nozzle columns: `samples.nozzle2_temp`, `samples.nozzle2_target` (added via migration in v0.2.0)

## Version Scheme

Semver 0.x (pre-1.0). Bump minor for features, patch for fixes. Tag every release.

## Coordination CLI

Use the `aiw` CLI for coordination operations (preferred over manual bash commands):

```bash
aiw work claim <project> "<desc>" [branch]   # Claim work
aiw work release "<search>"                   # Release claim
aiw research register <PREFIX> "<summary>" --project <proj>  # Register research
aiw quality log <ID> <partner> <type> <outcome> <score> <rework>  # Log quality
aiw session start                             # Pre-flight checklist
aiw session end                               # Post-flight cleanup
```

Install: `pip install -e ~/sffoundry/ai-workflows/tools/aiw`
Full reference: `aiw --help` or `~/sffoundry/ai-workflows/tools/aiw/README.md`

