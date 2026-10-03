# Code Review: 2026-10-02 (v0.5.0 autonomous tranche, 78c782d..93f1fcc)

> **Reviewer:** independent review agent (Claude), findings verified by reproduction; fixes by Claude
> **High:** 1 | **Medium:** 4 | **Low:** 5
> **Status:** resolved 2026-10-02 (all 10 verified findings, plus 1 unverified hardening and 1 bug found by the new tests)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | High | Malformed `%` escape in any cookie made `decodeURIComponent` throw. On the WebSocket upgrade path that crashed the process (an unauthenticated one-request DoS, a restart loop in Docker). | `parseCookies` keeps the raw value on decode errors. Test plus live repro: 401, server stays up. |
| 2 | Med | With `BAMBUZLE_PUBLIC_READ`, unauthenticated GETs exposed notifier secrets (`/api/alerts`), paths (`/api/system`) and raw MQTT (`/debug/mqtt`). | These stay private under public read; the check is case-insensitive. Tested. |
| 3 | Med | A user cancel (FAILED + print_error 50348044) was stored as FAILED, counted as a failure in stats, and logged at error severity. | New `src/utils/job-state.js` stores it as `CANCELLED`; stats count `IDLE` or `CANCELLED` as cancelled, and the event is logged at info severity. Tested. |
| 4 | Med | Shutdown hung while a dashboard WebSocket was open (`wss.close()` doesn't terminate clients), so `docker stop` always ended in SIGKILL. | `closeWebSocket` terminates clients. **The new test then found a second bug:** close handlers dereferenced the nulled `wss`. They now use a local reference. Live check: SIGTERM with a client open exits in 0.03s. |
| 5 | Med | The Docker image lacked `scripts/`, so `npm run backup:restore` was unavailable in the container. | Dockerfile copies `scripts/`; Install.md documents a Docker restore. |
| 6 | Low | `escapeHtml` (textContent→innerHTML) doesn't escape quotes, so `value="…"` attributes in the alert form were injectable (stored self-XSS, admin-only). | All three frontend helpers now escape `& < > " '`. |
| 7 | Low | Same-site CSRF: other ports on the same host could POST bodyless writes (logout, backup) with the session cookie. | Cookie-authenticated writes must have an Origin matching Host. Bearer requests and requests with no Origin are unaffected. Tested. |
| 8 | Low | Behind a reverse proxy, every user shared one throttle bucket and the cookie was never `Secure`. Successful sign-ins counted toward the lockout, and the attempts map was unbounded. | `BAMBUZLE_TRUST_PROXY`; only failures count; the map is pruned. Tested. |
| 9 | Low | Live DB/WAL files were world-readable even though they contain the Bambu Cloud token. | `umask 077` and chmod 0600 on open (this also fixes existing DBs). Tested. |
| 10 | Low | The `/metrics` state family omitted `SLICING`. | It now uses every `GCODE_STATE` value. |
| 11 | (unverified) | Material may read "Unknown" when PREPARE runs before the AMS has loaded. | Material is filled once the job is RUNNING if still null (`setJobMaterial`, never overwrites). Tested. |
