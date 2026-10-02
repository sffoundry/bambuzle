# Code Review: 2026-10-02 (manual, auth surface)

> **Reviewer:** Claude (Steve-claude pair)
> **Scope:** HTTP/WebSocket access control, `src/server/**`
> **High:** 2 | **Medium:** 3 | **Low:** 0
> **Status:** resolved 2026-10-02 by BAM-30 (H1, H2, M1, M2, M3). M2 reopens only if an operator opts into `BAMBUZLE_PUBLIC_READ=true`, which is read-only by design.

## Context

The server binds to `0.0.0.0` by default (`src/config.js:40`). No middleware authenticates the *requester* on any route (`src/server/app.js:42-44`). The only "auth" anywhere is the server's own Bambu Cloud session.

Codex's 2026-03-01 review (`planning/codex/CODE_REVIEW.md`) ticked off "Printer command endpoint lacks authentication" after `273a9fb`. That fix doesn't close the issue: see H1.

## High Severity

- **H1: Printer control is open to any LAN client.** `src/server/routes/api.js:97-104`. The check is `getAuthStatus() !== 'authenticated'`, which reports whether the *server* is logged into Bambu Cloud. Once an operator has logged in, any unauthenticated client on the network can `POST /api/printers/:id/command {"action":"stop"}` and kill a running print.
- **H2: Bambu Cloud session can be hijacked or dropped by any LAN client.** `src/server/routes/auth.js:38-84`. `/api/auth/login` and `/verify` let a caller re-point the server at a different Bambu account. `/api/auth/logout` clears the stored token (`queries.js:222`) with no auth, which is a one-request denial of service for monitoring.

## Medium Severity

- **M1: Alert rules (including webhook URLs) are writable without auth.** `src/server/routes/alerts.js:23-63`, `src/alerts/notifiers/webhook.js:13-26`. Anyone on the LAN can add a rule that makes the server POST printer telemetry to an arbitrary URL, from the server's network position.
- **M2: Raw MQTT state and all telemetry are unauthenticated.** `src/server/routes/api.js:16-145` (incl. `/printers/:id/debug/mqtt` at `:132`), plus the WebSocket broadcast (`src/server/websocket.js:15`). This was carried from the 2026-03-01 review as High and is still open.
- **M3: History and event `limit` are uncapped.** `src/server/routes/api.js:35`, `:46`. `?limit=100000000` forces a full-table read and serialization. Also carried from 2026-03-01 and still open.

## Recommendation

Fixing the root cause is roadmap item BAM-16 (requester auth). An interim fix of size S would cover H1, H2 and M1: a single shared admin token or password, set in `.env`, enforced by middleware on every mutating route (`/command`, `/auth/*` except `status`, `/alerts` writes). Capping `limit` (M3) is an XS one-liner. Ship both before any new control features (camera, queue, power switching).
