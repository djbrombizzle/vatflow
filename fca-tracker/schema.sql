-- FCA planned vs actual crossing archive.
-- Applied to the VATFLOW Supabase project (anon SELECT; service-role writes).

create table if not exists public.fca_crossing_tracks (
  id uuid primary key default gen_random_uuid(),
  fca_id text not null,
  flight_key text not null,
  callsign text not null,
  cid bigint,
  logon_time timestamptz,
  dep text,
  arr text,
  route text,
  planned_at timestamptz not null,
  planned_from text not null check (planned_from in ('air', 'gnd')),
  dist_nm_at_plan real,
  first_seen_at timestamptz not null,
  last_lat real,
  last_lon real,
  last_alt integer,
  last_gs integer,
  last_hdg integer,
  last_seen_at timestamptz not null,
  last_phase text,
  status text not null default 'open' check (status in ('open', 'lost')),
  created_at timestamptz not null default now(),
  unique (fca_id, flight_key)
);

create table if not exists public.fca_crossings (
  id uuid primary key default gen_random_uuid(),
  fca_id text not null,
  fca_name text,
  artcc text,
  flight_key text not null,
  callsign text not null,
  cid bigint,
  dep text,
  arr text,
  planned_at timestamptz not null,
  actual_at timestamptz not null,
  delta_sec integer not null,
  planned_from text not null check (planned_from in ('air', 'gnd')),
  dist_nm_at_plan real,
  cross_lat real,
  cross_lon real,
  cross_alt integer,
  cross_gs integer,
  created_at timestamptz not null default now(),
  unique (fca_id, flight_key)
);

create index if not exists fca_crossings_fca_actual_idx
  on public.fca_crossings (fca_id, actual_at desc);
create index if not exists fca_crossings_actual_idx
  on public.fca_crossings (actual_at desc);
create index if not exists fca_crossing_tracks_status_idx
  on public.fca_crossing_tracks (status, last_seen_at);

alter table public.fca_crossing_tracks enable row level security;
alter table public.fca_crossings enable row level security;

create policy "anon read fca_crossing_tracks"
  on public.fca_crossing_tracks for select using (true);
create policy "anon read fca_crossings"
  on public.fca_crossings for select using (true);

grant select on public.fca_crossing_tracks to anon, authenticated;
grant select on public.fca_crossings to anon, authenticated;
