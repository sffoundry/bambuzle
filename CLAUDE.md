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
        └─> public/js/alerts-ui.js — alert rules CRUD
```

## Key Files

| File | Purpose |
|------|---------|
| `src/config.js` | Loads .env + optional config.json |
| `src/db/database.js` | SQLite schema, migrations (idempotent ALTER TABLE pattern) |
| `src/db/queries.js` | All SQL queries |
| `src/db/backup.js` | Online SQLite backups (verify, sha256, prune, cron) |
| `scripts/restore.js` | Offline restore CLI (`npm run backup:restore`) |
| `src/bambu/message-parser.js` | MQTT message parsing, `extractPrinterState()` |
| `src/bambu/diagnostics.js` | `state.diagnostics`: nozzles, firmware update, xcam AI-monitor *settings*, SD, IP, camera, AMS humidity, print_error, dev mode (BAM-32) |
| `src/bambu/mqtt-client.js` | Per-printer MQTT connection manager |
| `src/bambu/auth.js` | BambuLab Cloud authentication |
| `src/server/app.js` | Express app setup, static files, route mounting |
| `src/server/routes/api.js` | Printer/event REST endpoints |
| `src/server/routes/auth.js` | Login/verify/logout endpoints |
| `src/server/routes/alerts.js` | Alert rules CRUD endpoints |
| `src/server/routes/system.js` | `/healthz`, `/readyz`, `/api/system` |
| `src/server/websocket.js` | WebSocket broadcast to dashboard |
| `src/server/routes/metrics.js` | `GET /metrics` Prometheus exposition, admin-token guarded (BAM-37) |
| `src/alerts/engine.js` | Alert condition evaluation (incl. `print_error`, BAM-15) |
| `src/alerts/notifiers/` | console, webhook, `push.js` (ntfy JSON-publish, Pushover, Telegram) |
| `src/index.js` | Main entry — orchestrates MQTT, sampling, jobs, alerts |
| `public/index.html` | Single-page dashboard HTML |
| `public/js/app.js` | Frontend entry — auth, WS, views, events |
| `public/js/dashboard.js` | Printer card rendering |
| `public/js/charts.js` | uPlot chart rendering |
| `public/js/stats.js` | Stats view — job statistics (`/api/stats`), Export CSV / JSON links |
| `src/server/routes/export.js` | `GET /api/export/jobs` CSV/JSON job export (BAM-46) |
| `src/db/export.js` | Export SQL + versioned column set; columns documented in `docs/export-data-dictionary.md` |
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

### Stats
- `GET /api/stats` — print job statistics: totals, success rate, by printer / material / day (query: printer, from, to; default last 30 days; bad dates → 400)
- `GET /api/export/jobs` — job history download, one row per job (query: format=csv|json, printer, from, to; default all time; cap 50k rows → `X-Bambuzle-Truncated`; CSV formula-injection guarded). Columns: `docs/export-data-dictionary.md` (BAM-46)
- `POST /api/printers/:id/command` — send command to printer via MQTT

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
- CSS: HamClock theme (green-on-black, monospace, `var(--text)` / `var(--accent)`)
- Database migrations: idempotent `ALTER TABLE` wrapped in try/catch

## Security Notes

- BambuLab credentials stored in `.env` (gitignored)
- Dashboard requester auth: shared admin token (`BAMBUZLE_ADMIN_TOKEN` or generated `<data dir>/admin-token`); env `BAMBUZLE_PUBLIC_READ`, `BAMBUZLE_AUTH=off`. Never add an `/api` route outside the guard without a reason.
- `?limit=` params are clamped (`clampLimit` in `routes/api.js`)
- Frontend uses `escapeHtml()` (via textContent) for all user-visible strings
- No eval, no innerHTML with raw data
- SQLite parameterized queries throughout

## Database Schema

Tables: `printers`, `print_jobs`, `samples`, `events`, `alert_rules`

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

