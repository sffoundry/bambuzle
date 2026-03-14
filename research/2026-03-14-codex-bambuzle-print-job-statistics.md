# Bambuzle Roadmap Research — Print Job Statistics

> **Date:** 2026-03-14

## Summary

| Focus | Recommendation |
|---|---|
| First value | Aggregate time, success/failure, and material views before more complex forecasting |
| Design rule | Build on normalized job history rather than ad hoc dashboard counters |
| Risk | Filament and stats work should share one job-history model, not diverge |

## Recommendation

- Define a stable print-job analytics layer first.
- Start with total hours, success/failure, average duration, and per-printer summaries.
- Reuse that same model for later filament and notification features.

## Sources

- `ROADMAP.md:31`
