# Code Review — bambuzle

> **Date:** 2026-03-01
> **Reviewer:** Codex
> **Scope:** Full repository

## Summary

The service architecture is clean and operationally practical, but API-side authorization is currently too permissive. The most serious issue is unauthenticated access to printer control endpoints. Additional findings focus on missing brute-force controls and unbounded query limits that can degrade API performance.

## Findings

### Critical

- [x] **Printer command endpoint lacks authentication/authorization** — src/server/routes/api.js:96 — Anyone with network access can issue pause/resume/stop/speed commands to printers.

### High

- [ ] **Operational telemetry APIs exposed without auth** — src/server/routes/api.js:15 — Full printer state/history/events are accessible without access control, leaking operational data.
- [ ] **Login and verification routes have no rate limiting** — src/server/routes/auth.js:20 — Credential and verification-code endpoints can be brute-forced without server-side throttling.

### Medium

- [ ] **User-controlled history limit is not capped** — src/server/routes/api.js:34 — Large `limit` values can trigger heavy DB reads and large JSON responses, increasing latency and memory use.
- [ ] **WebSocket broadcast lacks backpressure handling** — src/server/websocket.js:41 — Slow clients can increase send queue/memory since broadcasts do not gate on socket buffer state.

### Low

- [ ] **Config file JSON parse errors are silently ignored** — src/config.js:14 — Invalid config falls back silently, making misconfiguration hard to detect during incidents.

## Dependency Audit

- [ ] None found via static code review (automated npm audit not run in this pass).

## Positive Observations

- Query layer consistently uses parameterized SQL values.
- Shutdown path explicitly stops cron jobs, MQTT clients, WebSocket server, and DB.
