# Precomputed ATC Staffing Historical Data (StatSim USA)

Built by `node scripts/build-staffing-hist.mjs` (GitHub Actions every Monday at 06:15 UTC).

The Historical Data tab loads from Supabase `public.staffing_hist` first, then falls back to these JSON files.

## Refresh locally

```bash
STAFFING_HIST_SKIP_DB=1 node scripts/build-staffing-hist.mjs
# or with upsert:
# SUPABASE_SERVICE_ROLE_KEY=... node scripts/build-staffing-hist.mjs thisweek thismonth thisyear
```

## GitHub Actions

Workflow: `.github/workflows/staffing-hist.yml`

Add repo secret `SUPABASE_SERVICE_ROLE_KEY` so Monday runs upsert into Supabase. Without it, the workflow still commits updated JSON here.
