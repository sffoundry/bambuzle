# Code Review: 2026-10-03 (v0.6.0 batch 2, 1aeb946..8cc0bd6)

> **Reviewer:** independent review agent (Claude), findings verified by reproduction or reading the code path; fixes by Claude
> **High:** 1 | **Medium:** 4 | **Low:** 6
> **Status:** resolved 2026-10-03 (all 11; regression tests added)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | High | `{"command":"toString"}` (inherited prototype key) or `["pause"]` threw inside an async Express handler. That caused an unhandled rejection, and Node 20 exits on those. `["stop"]` while RUNNING really sent a stop. | String-only, `Object.hasOwn` lookup; handler wrapped in try/catch; process-level `unhandledRejection` logger. Tested over HTTP. |
| 2 | Med | No stale-UI guard: the card re-renders and Pause↔Resume swap places, so a click meant for Pause could land on Resume after a filament-runout pause. A Stop dialog for job A could cancel job B. | Client sends `expectState` and `expectTaskId`; server returns 409 on mismatch. Tested. |
| 3 | Med | `ORDER BY ts ASC LIMIT 20000` returned the *oldest* rows, so the humidity sparkline and 24h trend went stale on busy sensors. | DESC + limit, then reversed. Tested with 20,100 rows. |
| 4 | Med | A humidity crossing during cooldown was lost permanently (prev state advanced while the rule was skipped). No hysteresis, so a sensor wobbling at the limit re-alerted. | Each rule now keeps its own last-evaluated state, so cooldown no longer swallows edges. Per-unit arming, re-armed 3 % below the threshold. Tested. |
| 5 | Med | Maintenance "last done": the bare date was treated as UTC midnight, so it showed a day early in the US and was rejected as "future" in Sydney. | Client sends local midnight as ISO and displays/edits a local date. Round-trip checked in Chicago, Sydney and UTC. |
| 6 | Low-Med | The speed dropdown was destroyed by every MQTT re-render, and arrow keys could send a speed change. | Card split into a persistent controls container (re-rendered only when its markup changes) and the body. Speed change asks for confirmation. Verified live: the dropdown keeps focus through updates. |
| 7 | Low | Double-send after "sent, unconfirmed"; no lock against two tabs. | Client keeps the buttons locked until the printer's state changes (max 10 s). Server allows one command in flight per printer, returning 429 otherwise. Tested. |
| 8 | Low | The Origin (CSRF) check was skipped with `BAMBUZLE_AUTH=off`. | Always applied. Tested. |
| 9 | Low | A BAM-28 `.btn-danger` rule restyled every delete button. | Scoped to `.ctl-btn`. |
| 10 | Low | The saved theme was applied after first paint, causing a green flash. | `theme-boot.js` (classic script in `<head>`) applies the cached theme pre-paint; theme class moved to `<html>`. Verified with app.js blocked. |
| 11 | Low | Duplicate `JOB_DURATION_SQL` export; API docs filed under Stats. | Cleaned up. |

Also fixed while verifying: a flaky maintenance test that asserted exactly on the due boundary.
