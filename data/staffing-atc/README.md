# Precomputed StatSim ATC combined-time hours

Built by `node scripts/build-staffing-atc.mjs` (GitHub Actions every Monday after pilot staffing data).

The Historical Data tab's **ATC** row loads from Supabase `public.staffing_atc` first, then falls back to these JSON files.

## Why precompute?

StatSim's **This year** ATC page is ~900 KB with thousands of position rows. Browser CORS proxies return 401, timeout, or truncated bodies. The build job fetches the HTML directly (or monthly custom chunks for `thisyear`) and stores grouped position hours.

## Refresh locally

```bash
STAFFING_ATC_SKIP_DB=1 node scripts/build-staffing-atc.mjs thisyear
STAFFING_ATC_SKIP_DB=1 node scripts/build-staffing-atc-trends.mjs
# or with Supabase upsert:
# SUPABASE_SERVICE_ROLE_KEY=... node scripts/build-staffing-atc.mjs thisweek thismonth thisyear
```

## GitHub Actions

Workflow: `.github/workflows/staffing-hist.yml` (runs after each pilot period build).

Also builds `data/staffing-atc/trends.json` (2020–2026 calendar-year hours for the **ATC hours trend** tab; 2026 through Aug 31 only).

Optional secret:

- `SUPABASE_SERVICE_ROLE_KEY` — upsert into `staffing_atc` (without it, JSON is still committed)

Create the table once in Supabase (SQL editor):

```sql
create table if not exists public.staffing_atc (
  period text primary key,
  computed_at timestamptz not null,
  source_label text,
  position_groups integer,
  total_seconds bigint,
  range jsonb,
  data jsonb not null
);
alter table public.staffing_atc enable row level security;
create policy "anon read staffing_atc" on public.staffing_atc for select using (true);
```
