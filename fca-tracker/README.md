# FCA crossing tracker

Unattended poller that watches FCAs with **Record crossings** enabled, freezes each matching aircraft’s first profile ETA, and writes the interpolated actual line-crossing to Supabase.

The VATFLOW site (FCA Accuracy) only *reads* completed rows. History accumulates only while this process is running.

## What it stores

- `public.fca_crossing_tracks` — open / lost in-progress freezes (last position only)
- `public.fca_crossings` — planned vs actual events (`delta_sec` = actual − planned; negative = early)

Schema: [schema.sql](schema.sql). Anon clients can SELECT; writes use the service role.

## Run locally

```bash
SUPABASE_URL=https://qoaipsfcidpymboojfwa.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=… \
VATFLOW_NAV_BASE=https://vatflow.io/data/nav \
VATFLOW_SITE_BASE=https://vatflow.io/ \
node fca-tracker/index.mjs
```

Optional: `POLL_MS` (default 20000). Nav/ARTCC files can also be loaded from a local checkout by pointing `VATFLOW_NAV_BASE` at `data/nav` via a file server, or use the production URLs above.

## Railway

Add a **second service** on the same project as vatflow-hub, built from this repo:

- Dockerfile path: `fca-tracker/Dockerfile`
- Root directory: repository root (the Dockerfile copies `shared/` and `fca-tracker/`)

Environment:

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Same secret as the staffing GitHub Action |
| `SUPABASE_URL` | no | Defaults to the VATFLOW project |
| `VATFLOW_NAV_BASE` | no | Defaults to `https://vatflow.io/data/nav` |
| `VATFLOW_SITE_BASE` | no | Defaults to `https://vatflow.io/` |
| `POLL_MS` | no | Default 20000 |

Do not put the service-role key in the static site or the GitHub Pages build.
