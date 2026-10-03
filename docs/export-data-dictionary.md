# Job export — data dictionary

`GET /api/export/jobs?format=csv|json&printer=&from=&to=` (Stats view → **Export CSV** / **Export JSON**) returns one row per print job. This page describes every column of **export schema version 2** (v2 added `active_sec`, v0.8.0).

## The file

- **Rows:** jobs whose `started_at` falls inside `[from, to]`, oldest first. The default window is all time up to now. A bare date for `to` means the end of that UTC day. `printer` limits the export to one device ID.
- **Row cap:** 50,000. When more jobs match, the export keeps the **newest** 50,000, sets the response header `X-Bambuzle-Truncated: true` and, in JSON, `truncated: true`. Narrow the window to get the rest.
- **Versioning:** `schema_version` is in the JSON body and in the `X-Bambuzle-Export-Schema` header. Renaming, removing, re-ordering or redefining a column bumps the version, and so does adding one.
- **Time:** every timestamp is UTC, ISO 8601, with a `Z` suffix (`2026-09-01T10:00:00Z`). Bambuzle stores times at one-second resolution.
- **CSV:** RFC 4180 (comma separator, `"` quoting, `""` escapes, CRLF line endings), UTF-8 with a byte-order mark so Excel detects the encoding, and a header row. An empty cell means null.
- **Formula-injection guard (CSV only):** text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`, so spreadsheet apps show them as text instead of running them as formulas. A job named `=HYPERLINK(…)` exports as `'=HYPERLINK(…)`, and a job named `-2` exports as `'-2`. Numeric columns are never prefixed, so a negative temperature stays a number. Strip the leading `'` if you load the CSV into something other than a spreadsheet. JSON values are raw and never prefixed.
- **JSON:** `{ schema_version, generated_at, window: { from, to, printer }, truncated, max_rows, columns: [{ name, type, unit? }], jobs: [ {…} ] }`. The keys of each job follow the `columns` order. Nulls are JSON `null`.

## Retention caveat

Some columns come from per-job values on `print_jobs` and are kept forever. That now includes `sample_count` and the nozzle and bed temperature avg/max, which are snapshotted when the job ends (v0.8.0); older jobs were backfilled on upgrade. `events` and `layer_transitions` are deleted after `retention.days` (default 90). Raw `samples` are rolled into hourly averages after `retention.rawDays` (default 14). Columns still computed from those tables (`hms_error_count`, `print_error_count`, `layer_count`) read `0` or empty for jobs older than that. The **Source** column below marks them as *telemetry*.

## Columns

| Column | Type | Unit | Source | Meaning and caveats |
|---|---|---|---|---|
| `job_id` | integer | — | job | Bambuzle's internal job ID (`print_jobs.id`). Unique within one Bambuzle database. |
| `device_id` | string | — | job | Printer serial / device ID. |
| `printer_name` | string | — | printer | The printer's name **now** (not at print time). Empty if the printer row is gone. |
| `printer_model` | string | — | printer | The printer's model **now**, e.g. `X1C`, `P1S`, `H2D`. |
| `task_id` | string | — | job | Bambu Cloud task ID, if the printer reported one. |
| `subtask_name` | string | — | job | Job / plate name as sent by the slicer. User-controlled text (see the formula guard). |
| `gcode_file` | string | — | job | G-code file name reported by the printer. User-controlled text. |
| `started_at` | string | ISO 8601 UTC | job | When Bambuzle saw the job start. This is the column the `from` / `to` window filters on. |
| `ended_at` | string | ISO 8601 UTC | job | When Bambuzle saw the job end. Empty while the job is running. |
| `end_state` | string | — | job | Raw end state: `FINISH`, `FAILED`, `CANCELLED` (user cancel), `IDLE` (cancellations recorded by older versions), or empty while running. |
| `outcome` | string | — | derived | Normalized result: `finished` (FINISH), `failed` (FAILED), `cancelled` (CANCELLED or IDLE), `running` (no `ended_at`), or `unknown` (ended with any other state). Matches the Stats view's buckets. |
| `duration_sec` | integer | seconds | job | **Wall-clock** time from start to end, **pauses included**. Rows from before this field existed fall back to `ended_at − started_at`, the same fallback the Stats view uses. Rounded to whole seconds. Empty while running. |
| `active_sec` | integer | seconds | job | Printing time **excluding pauses**: `duration_sec − pause_total_sec`, floored at 0. This is what Stats "print hours" and Maintenance hours use (since v0.8.0, schema 2). Empty while running. |
| `progress_pct` | number | % (0–100) | job | Progress when the job ended. Empty while running or if the printer did not report it. |
| `material` | string | — | job | Filament type, e.g. `PLA` or `PETG`, of the **active AMS tray** when the job started. If no tray was active then, it is the active tray at the first `RUNNING` state. This is one material per job: multi-material prints record only that tray. Empty for external spools, unknown trays and jobs from before this field existed. |
| `material_color` | string | RRGGBBAA hex | job | Colour of that tray as reported by the AMS, e.g. `FF0000FF`. |
| `pause_count` | integer | count | job | Number of pauses during the job, whether user, HMS or filament runout. |
| `pause_total_sec` | number | seconds | job | Total paused time, rounded to 0.1 s. A pause that is still open (job paused now, or ended while paused) is not counted. |
| `temp_anomaly_count` | integer | count | job | Temperature anomalies the detector flagged during the job (`print_jobs.anomaly_count`). |
| `total_layers` | integer | layers | job | Total layer count the printer reported for the file. Empty if it was never reported. |
| `layer_count` | integer | layers | telemetry | Highest layer number Bambuzle saw during the job: the max from `layer_transitions`, or from `samples` when there are no transitions. For an ended job, compare with `total_layers` to see how far it got. |
| `hms_error_count` | integer | count | telemetry | `hms_error` events tied to the job. Each one is a new HMS code appearing, not a repeat report. |
| `hms_codes` | string | — | job | Distinct HMS codes seen during the job, space-separated, e.g. `0300_0100_0001_0007 0500_0200_0002_0001`. This column is kept forever, so it is a lasting record even after `hms_error_count` has been pruned. |
| `print_error_count` | integer | count | telemetry | `print_error` events tied to the job: non-zero `print_error` codes, excluding the user-cancel code. |
| `sample_count` | integer | count | telemetry | Telemetry samples recorded for the job. `0` means the temperature columns below are empty. |
| `nozzle_temp_avg` | number | °C | telemetry | Mean nozzle temperature over the job's samples, rounded to 0.1. Main nozzle only (H2D's second nozzle is not included). Includes heat-up and cool-down. |
| `nozzle_temp_max` | number | °C | telemetry | Maximum nozzle temperature over the job's samples. |
| `bed_temp_avg` | number | °C | telemetry | Mean bed temperature over the job's samples, rounded to 0.1. |
| `bed_temp_max` | number | °C | telemetry | Maximum bed temperature over the job's samples. |

## Notes for analysis

- **Success rate** as the Stats view computes it: `finished / (finished + failed + cancelled)`. Running jobs are excluded.
- **Print time without pauses:** use `active_sec` (schema 2+). It's approximate where pause tracking missed a pause (see `pause_total_sec`).
- **Job boundaries** come from Bambuzle's own MQTT observations. If Bambuzle was offline when a job started or ended, the job may be missing, or its times may be off by the length of the outage.
- **Formula guard in a script:** a CSV text cell that begins with `'` followed by `=`, `+`, `-`, `@`, a tab or a CR was prefixed by the export.
