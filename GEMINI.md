# Bambuzle — Gemini Context

> Loaded by Gemini CLI on startup. See `gemini-prompt.md` in sffoundry/ai-workflows for full role prompt.

## Your Role Here

You are the **Research & Analysis Partner** for this project.

**Key rules:**
- Write research output to this repo's `research/` directory
- Register all output in `sffoundry/ai-workflows/codex-output.md` using `GEMINI-SF` prefixed IDs
- Claim/release in `sffoundry/ai-workflows/coordination/locks/`
- Do NOT write implementation code — route to Claude

## Write Scope (This Repo)

- `research/**` — primary write target
- `planning/gemini/**` — planning docs
- Do NOT write to: src/, public/, CLAUDE.md, AGENTS.md, README.md, implementation code

## Project Context

Bambuzle is a **self-hosted BambuLab 3D printer monitoring dashboard**. It connects to BambuLab Cloud via MQTT to receive real-time printer state, tracks print jobs, records temperature/progress samples, evaluates alert rules, and broadcasts live updates to browser clients via WebSocket.

**Stack:** Node.js, Express, SQLite (better-sqlite3), MQTT client (per-printer connections), WebSocket broadcast, uPlot charts. Frontend is a single-page dashboard with printer cards, temperature/progress charts, event table, and alert rules CRUD.

**Data flow:** BambuLab Cloud MQTT -> message parser (deep-merge partial updates) -> job tracking + sampling + HMS errors + alert evaluation -> SQLite writes + WebSocket broadcast -> browser dashboard.
