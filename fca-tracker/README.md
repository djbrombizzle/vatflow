# FCA crossing tracker

Unattended poller that watches FCAs with **Record crossings** enabled, freezes each matching aircraft’s first profile ETA, and writes the interpolated actual line-crossing to Supabase.

The VATFLOW site (FCA Accuracy) only *reads* completed rows. **Nothing is recorded unless this poller is running somewhere.**

## What it stores

- `public.fca_crossing_tracks` — open / lost in-progress freezes (last position only)
- `public.fca_crossings` — planned vs actual events (`delta_sec` = actual − planned; negative = early)

Schema: [schema.sql](schema.sql). Anon clients can SELECT; writes use the service role.

## How it runs in production (GitHub Actions)

[`.github/workflows/fca-tracker.yml`](../.github/workflows/fca-tracker.yml) runs hourly and polls for ~58 minutes, so coverage is effectively continuous with no always-on server. It reuses the `SUPABASE_SERVICE_ROLE_KEY` repo secret that the staffing workflow already uses.

In-progress freezes live in Supabase, so a gap between runs only loses that gap — an aircraft still airborne is picked back up on the next run.

Two knobs via **Run workflow**: `run_seconds` and `poll_ms`.

## Poll cadence and accuracy

The actual crossing time is interpolated between the two position samples that straddle the line, so the poll interval bounds the precision. At 20 s a jet moves ~2.5 nm between samples, which is a few seconds of interpolation error — well inside the minutes-scale error being measured. Do not raise `POLL_MS` much beyond a minute.

## Dry run (no writes)

Useful to check matching and freezing without touching the archive. Reads FCAs with the public anon key:

```bash
DRY_RUN=1 RUN_SECONDS=300 node fca-tracker/index.mjs
```

Logs a `FREEZE` line per new track, `CROSS` with the delta, and `LOST` for flights that never crossed.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (unless `DRY_RUN=1`) | Same secret as the staffing workflow |
| `SUPABASE_URL` | no | Defaults to the VATFLOW project |
| `SUPABASE_ANON_KEY` | no | Read key for `DRY_RUN` |
| `VATFLOW_NAV_BASE` | no | Defaults to `https://vatflow.io/data/nav` |
| `VATFLOW_SITE_BASE` | no | Defaults to `https://vatflow.io/` |
| `POLL_MS` | no | Default 20000 |
| `RUN_SECONDS` | no | Exit after N seconds (0 = forever). The hourly job sets 3480. |
| `DRY_RUN` | no | `1` = log only, never write |

Do not put the service-role key in the static site or any client bundle.

## Alternative: always-on Railway service

If you would rather run it continuously instead of hourly, add a **second service** on the same Railway project as vatflow-hub:

- Dockerfile path: `fca-tracker/Dockerfile`
- Root directory: repository root (the Dockerfile copies `shared/` and `fca-tracker/`)
- Set `SUPABASE_SERVICE_ROLE_KEY`, leave `RUN_SECONDS` unset

Disable the GitHub workflow if you do this, so two pollers do not write the same flights.

## Planned time: air vs ground

`planned_from` records which model produced the freeze:

- **`air`** — the aircraft was already flying, so the error is essentially the transit/wind model.
- **`gnd`** — frozen before wheels-up, so the error also contains however long the pilot actually sat on the ground. A filed departure time is only trusted up to `MAX_GROUND_OFF_SEC` (6 h) ahead, because a bare HHMM snaps to the nearest ±12 h and a stale filed time would otherwise anchor the freeze most of a day out.

FCA Accuracy can filter on this.
