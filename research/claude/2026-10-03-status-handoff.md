# Bambuzle status: handoff (2026-10-03)

**Where things stand:**
- `main` is clean and pushed. Latest tag is **v0.11.0**, and CI passes on it, including the arm64 Docker smoke test.
- 206/206 tests pass.
- Steve's live dev server (`npm start` from this checkout, on :3000) runs 0.11.0 with all 3 printers connected over cloud.

## Shipped this session

| Version | What |
|---|---|
| v0.5.0 – v0.8.0 | Auth, diagnostics, Docker, health/backup, stats, push alerts, metrics, AMS humidity, controls UI, maintenance, export, themes, LAN transport, FTPS files, audit trail, mobile, triage, rollups, Home Assistant bridge, fleet table (see `research/claude/autonomous-log-2026-10-02.md`) |
| v0.9.0 | **BAM-16** user accounts: viewer / operator / admin roles, scrypt passwords, server-side sessions, one permission table (`src/server/permissions.js`) |
| v0.10.0 | **BAM-35** camera detection, **BAM-18** read-only smart-plug power tracking (job energy and cost, circuit alerts), **BAM-49** CI with an amd64 + arm64 Docker smoke test |
| v0.11.0 | **BAM-9** live camera over LAN. P1/A1 as MJPEG. X1/H2 via an RTSPS client → H.264 → fragmented MP4 → Media Source Extensions, with no ffmpeg or transcoding. LAN access codes are imported from the BambuLab account (code only; the transport doesn't change) |

Each release had an independent review; all findings were fixed. The records are in `code-review/2026-10-03-*.md`.

## Open — needs Steve / hardware

1. **Camera on the H2D (in progress).** Steve says the H2D is "live", but the printer still reports `ipcam.rtsp_url: "disable"` and port 322 is closed. Its `tutk_server` and `brtc_service` are enabled, which suggests cloud liveview is on, not the LAN stream.
   - Needed: the H2D's setting that enables the local RTSPS stream ("LAN Only Liveview" on X1). It may need a printer restart.
   - Once port 322 opens, Bambuzle re-probes within about 10 min (immediately if the printer reports the change). The card then shows **Cam live**.
   - Hardware check: does it play, and does the ~2 s start-up stall seen with the fake camera also happen here?
2. **Printer controls over LAN** (BAM-28/35): needs one printer on LAN with Developer Mode on.
3. **SD-card files** (BAM-44): open "SD files" on a LAN printer. FTPS may need Developer Mode.
4. **Smart plug** (BAM-18): readers are tested against each vendor's documented JSON only. Shelly Gen2+ device passwords (Digest auth) are not supported yet.
5. **arm64 on a real Pi** (BAM-49): CI builds and runs it under emulation. Still undecided: where to publish images.
6. **Waiting on others:**
   - BAM-48 SDK transport: Bambu SDK request drafted in `research/claude/2026-10-03-bambu-sdk-access-request-draft.md`, not yet submitted.
   - Spoolman (BAM-38): Francisco's decision.
   - BAM-17 print queue and BAM-14 G-code viewer: owner decisions; both recommended against.

## Known small items

- Alert rules don't re-arm while in cooldown, which affects AMS humidity and power alerts. Noted for an alert-engine pass.
- `cameraMonitor.forget()` isn't called when a printer is deleted. This is a tiny in-memory leak.
- For an admin with no BambuLab Cloud session, the cloud-login overlay is still the dashboard gate (by Steve's decision). Viewers and operators skip it.
- Merged local branches `auto/bam-*` can be deleted.

## Working notes for the next session

- **Safety rules:**
  - The repo is **public**: never commit real serials, IPs or hostnames. Grep the staged diff before every commit.
  - Sub-agents must never touch :3000 or 192.168.x.x, and must kill only the PIDs they started.
  - No history rewrites.
- **Restarting the live server:** stop the background `npm start`, then rerun it with the log at `<scratchpad>/bambuzle-live.log`. Check `/readyz` for 3/3 connected and the log for no `level:50` lines.
- **Headless browser on WSL:**
  - Install with `playwright-core` (full `chromium` build) into a scratch dir.
  - Video/MSE needs `channel: 'chromium'` with `--disable-gpu --disable-software-rasterizer`. The headless shell has no media support.
  - WebCodecs only exists on HTTPS or localhost pages, so it is unusable over `http://LAN-IP`.
- **Camera testing without hardware:** `test/support/fake-rtsps.js` and `test/support/h264-pcm.js` provide a real, decodable H.264 stream.
