# Operator audit trail (BAM-41)

An append-only record of **who did what, when, from where, and with what result** for every
security-relevant or state-changing operator action. Read it in the dashboard's **Audit** tab, via
`GET /api/audit`, or download it with `GET /api/audit/export?format=csv`.

## Storage

`audit_log` (created on first use by `src/db/audit.js`):

| Column | Notes |
|--------|-------|
| `id` | autoincrement |
| `ts` | ISO 8601 UTC with ms (`2026-10-03T12:00:00.000Z`) |
| `actor` | `admin-token` (Bearer), `session` (cookie) or `anonymous` |
| `source_ip` | `req.ip` — honours `BAMBUZLE_TRUST_PROXY` |
| `user_agent` | truncated to 200 chars |
| `action` | dotted, category first (see below) |
| `target` | e.g. `printer:<serial>`, `alert:12`, `maintenance_task:3`, a request path for denials |
| `result` | `ok` · `denied` (authN/authZ refused) · `rejected` (validation, state gate, printer said no) · `error` (failure, incl. unconfirmed commands) |
| `detail` | small JSON, **never secrets** |
| `request_id` | random UUID, also returned to the client as `X-Request-Id` |

The module exports no update or delete-by-id function. Rows only leave via retention pruning in the
daily 03:00 cleanup: `audit.retentionDays` in `config.json` / `BAMBUZLE_AUDIT_RETENTION_DAYS`, default
**365** days (independent of telemetry retention; `0` keeps forever).

## Recording

Routes call `audit(req, { action, target, result, detail })` (`src/server/audit.js`) on each exit. This is
deliberately not a blanket middleware: reads are never recorded. `attachAuditActor` (mounted right after
the `/api` admin guard) sets `req.auditActor` by validating which credential authorised the request; BAM-16
per-user accounts can set it to a user identity and every call site picks that up.

| Category | Actions |
|----------|---------|
| Dashboard session | `session.login` (ok / denied), `session.rate_limited` (throttled), `session.logout` |
| Admin guard | `access.denied` (401 on a mutating request), `access.cross_origin` (403) — throttled |
| BambuLab Cloud | `cloud.login` (email + stage only), `cloud.verify`, `cloud.logout` |
| Printers | `printer.connection.update` (mode / host from→to, `accessCodeChanged`), `printer.connection.test` (stage), `printer.add`, `printer.remove`, `printer.command` (outcome: confirmed / rejected / unconfirmed / not_sent / refused / error) |
| Alerts | `alert.create`, `alert.update` (+ changed field names), `alert.delete` — name, condition type, channel only |
| Maintenance | `maintenance.task.create/update/delete/done`, `maintenance.templates` |
| System | `system.backup` |

Printer commands keep their existing `command` rows in `events` as well.

**Flood control:** guard denials and rate-limit hits go through `auditThrottled` — at most one row per
source IP + action per minute; the next row that gets through carries `detail.suppressed: <n>`.

## Secrets

Never recorded: LAN access codes (only `accessCodeChanged` / `accessCodeCleared` / `accessCodeSupplied`),
the Cloud password and verification code (and Bambu's error text, which can echo input), the admin token
or session cookie, and alert `notify_config` (bot tokens, webhook URLs, Pushover keys). `test/audit.test.js`
drives every secret-bearing route with known values and asserts none appear in any row.

## Access

`/api/audit*` is admin-guarded and listed in `isPrivateRead` (`src/server/admin-auth.js`), so it stays
private with `BAMBUZLE_PUBLIC_READ=true`. Theme changes are client-only and not audited.
