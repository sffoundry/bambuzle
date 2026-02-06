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
        └─> public/js/alerts-ui.js — alert rules CRUD
```

## Key Files

| File | Purpose |
|------|---------|
| `src/config.js` | Loads .env + optional config.json |
| `src/db/database.js` | SQLite schema, migrations (idempotent ALTER TABLE pattern) |
| `src/db/queries.js` | All SQL queries |
| `src/bambu/message-parser.js` | MQTT message parsing, `extractPrinterState()` |
| `src/bambu/mqtt-client.js` | Per-printer MQTT connection manager |
| `src/bambu/auth.js` | BambuLab Cloud authentication |
| `src/server/app.js` | Express app setup, static files, route mounting |
| `src/server/routes/api.js` | Printer/event REST endpoints |
| `src/server/routes/auth.js` | Login/verify/logout endpoints |
| `src/server/routes/alerts.js` | Alert rules CRUD endpoints |
| `src/server/websocket.js` | WebSocket broadcast to dashboard |
| `src/alerts/engine.js` | Alert condition evaluation |
| `src/index.js` | Main entry — orchestrates MQTT, sampling, jobs, alerts |
| `public/index.html` | Single-page dashboard HTML |
| `public/js/app.js` | Frontend entry — auth, WS, views, events |
| `public/js/dashboard.js` | Printer card rendering |
| `public/js/charts.js` | uPlot chart rendering |

## API Endpoints

### Auth
- `GET /api/auth/status` — check auth state
- `POST /api/auth/login` — email/password login
- `POST /api/auth/verify` — verification code
- `POST /api/auth/logout`

### Printers
- `GET /api/printers` — list all printers with live state
- `GET /api/printers/:id/history` — sample history (query: from, to, limit)
- `GET /api/printers/:id/events` — events for printer (query: from, to, limit)
- `GET /api/printers/:id/jobs` — print job history
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
- Frontend uses `escapeHtml()` (via textContent) for all user-visible strings
- No eval, no innerHTML with raw data
- SQLite parameterized queries throughout

## Database Schema

Tables: `printers`, `print_jobs`, `samples`, `events`, `alert_rules`

H2D dual nozzle columns: `samples.nozzle2_temp`, `samples.nozzle2_target` (added via migration in v0.2.0)

## Version Scheme

Semver 0.x (pre-1.0). Bump minor for features, patch for fixes. Tag every release.
