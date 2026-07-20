# Precomputed ATC Staffing Historical Data (StatSim USA)

Built by `node scripts/build-staffing-hist.mjs` (GitHub Actions every Monday at 06:15 UTC).

The Historical Data tab loads from Supabase `public.staffing_hist` first, then falls back to these JSON files.

## Why the API key is required

StatSim’s country HTML pages now often return **empty** Departed/Arrived tables to
datacenter / GitHub Actions IPs (Blazor shell with `Departed (0)`). The Monday job
therefore uses the official StatSim REST API:

- Endpoint: `GET /api/Flights/Icao` per US airport (not `/Flights/Dates`, which truncates)
- Docs: https://api.statsim.net  
- Create a key: https://statsim.net/api-keys (VATSIM login)  
- Repo secret name: `STATSIM_API_KEY`

## Refresh locally

```bash
STATSIM_API_KEY=... STAFFING_HIST_SKIP_DB=1 node scripts/build-staffing-hist.mjs thisweek
# or with upsert:
# STATSIM_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/build-staffing-hist.mjs thisweek thismonth thisyear
```

## GitHub Actions

Workflow: `.github/workflows/staffing-hist.yml`

Required secrets:

1. `STATSIM_API_KEY` — StatSim API access (required)
2. `SUPABASE_SERVICE_ROLE_KEY` — upsert into Supabase (optional; without it the workflow still commits JSON here)

After changing secrets, re-run the workflow from the Actions tab (**Run workflow** on branch `main`).
