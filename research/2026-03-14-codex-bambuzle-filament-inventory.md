# Bambuzle Roadmap Research — Filament Inventory Tracking

> **Date:** 2026-03-14

## Summary

| Focus | Recommendation |
|---|---|
| Foundation | Implement this as spool identity + per-job usage accounting, not just current tray display |
| First slice | `filament_spools` and `filament_usage` with tray UUID tracking |
| Risk | Mid-print swaps and non-RFID spools will break simplistic inventory assumptions |

## Recommendation

- Treat tray UUID as the primary identity and RFID as an optional enhancement.
- Snapshot remain-at-start and remain-at-end per job.
- Keep the first UI centered on current spools, grams left, and usage history.

## Sources

- `ROADMAP.md:35`
