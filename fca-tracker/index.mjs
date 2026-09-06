#!/usr/bin/env node
/**
 * 24/7 FCA crossing poller. Freeze first profile ETA, interpolate actual
 * crossings from VATSIM positions, persist to Supabase.
 *
 * Env:
 *   SUPABASE_URL                 default: production VATFLOW project
 *   SUPABASE_SERVICE_ROLE_KEY    required
 *   VATFLOW_NAV_BASE             default: https://vatflow.io/data/nav
 *   VATFLOW_SITE_BASE            default: https://vatflow.io/
 *   POLL_MS                      default: 20000
 *   DRY_RUN                      1 = log only, never write (uses SUPABASE_ANON_KEY to read)
 *   SUPABASE_ANON_KEY            read key for DRY_RUN
 */
import { loadAirports, getAirport } from "../shared/fca-metering.js";
import { loadNavData } from "../shared/route-engine.js";
import { fetchArtccBoundaries } from "../shared/artcc-scope.js";
import { bindWindAirportLookup, fetchWinds } from "../shared/winds-aloft.js";
import {
  isTrackableFca,
  processFcaPoll,
  vatsimToTrackPilot,
} from "./crossing-track.js";

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://qoaipsfcidpymboojfwa.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79";
const READ_KEY = DRY_RUN ? ANON_KEY : SERVICE_KEY;
const NAV_BASE = process.env.VATFLOW_NAV_BASE || "https://vatflow.io/data/nav";
const SITE_BASE = (process.env.VATFLOW_SITE_BASE || "https://vatflow.io/").replace(/\/?$/, "/");
const POLL_MS = Math.max(10000, parseInt(process.env.POLL_MS, 10) || 20000);
/** Exit cleanly after this many seconds (0 = run forever). Used by the hourly CI runner. */
const RUN_SECONDS = Math.max(0, parseInt(process.env.RUN_SECONDS, 10) || 0);
const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";

const tracksByFca = new Map();
const completedByFca = new Map();
let windTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function sb(path, { method = "GET", body, prefer, query } = {}) {
  const url = SUPABASE_URL + "/rest/v1/" + path + (query || "");
  const headers = {
    apikey: READ_KEY,
    Authorization: "Bearer " + READ_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`supabase ${method} ${path} ${r.status}: ${t.slice(0, 400)}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

function toIso(ms) {
  if (ms == null) return null;
  if (typeof ms === "string") return ms;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function msOf(v) {
  if (v == null) return null;
  if (typeof v === "number" && isFinite(v)) return v;
  const n = Date.parse(v);
  return isNaN(n) ? null : n;
}

function trackToRow(t) {
  return {
    fca_id: t.fca_id,
    flight_key: t.flight_key,
    callsign: t.callsign,
    cid: t.cid,
    logon_time: toIso(t.logon_time) || t.logon_time || null,
    dep: t.dep,
    arr: t.arr,
    route: t.route,
    planned_at: toIso(t.planned_at),
    planned_from: t.planned_from,
    dist_nm_at_plan: t.dist_nm_at_plan,
    first_seen_at: toIso(t.first_seen_at),
    last_lat: t.last_lat,
    last_lon: t.last_lon,
    last_alt: t.last_alt != null ? Math.round(t.last_alt) : null,
    last_gs: t.last_gs != null ? Math.round(t.last_gs) : null,
    last_hdg: t.last_hdg != null ? Math.round(t.last_hdg) : null,
    last_seen_at: toIso(t.last_seen_at),
    last_phase: t.last_phase,
    status: t.status,
  };
}

function crossingToRow(c) {
  return {
    fca_id: c.fca_id,
    fca_name: c.fca_name,
    artcc: c.artcc,
    flight_key: c.flight_key,
    callsign: c.callsign,
    cid: c.cid,
    dep: c.dep,
    arr: c.arr,
    planned_at: toIso(c.planned_at),
    actual_at: toIso(c.actual_at),
    delta_sec: c.delta_sec,
    planned_from: c.planned_from,
    dist_nm_at_plan: c.dist_nm_at_plan,
    cross_lat: c.cross_lat,
    cross_lon: c.cross_lon,
    cross_alt: c.cross_alt != null ? Math.round(c.cross_alt) : null,
    cross_gs: c.cross_gs != null ? Math.round(c.cross_gs) : null,
  };
}

function rowToTrack(r) {
  return {
    ...r,
    planned_at: msOf(r.planned_at),
    first_seen_at: msOf(r.first_seen_at),
    last_seen_at: msOf(r.last_seen_at),
    logon_time: r.logon_time || null,
  };
}

async function loadOpenTracks() {
  const rows = await sb("fca_crossing_tracks", { query: "?status=eq.open&select=*" }) || [];
  for (const r of rows) {
    if (!tracksByFca.has(r.fca_id)) tracksByFca.set(r.fca_id, new Map());
    tracksByFca.get(r.fca_id).set(r.flight_key, rowToTrack(r));
  }
  return rows.length;
}

/**
 * Recently completed crossings, so a restart does not re-open a track for a
 * flight already recorded. Bounded because the unique (fca_id, flight_key)
 * constraint is the real duplicate guard — this is only an optimization, and a
 * flight_key carries its logon time so old keys cannot collide with new flights.
 */
async function loadCompletedKeys() {
  const sinceIso = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const rows = await sb("fca_crossings", {
    query: "?select=fca_id,flight_key&actual_at=gte." + encodeURIComponent(sinceIso),
  }) || [];
  for (const r of rows) {
    if (!completedByFca.has(r.fca_id)) completedByFca.set(r.fca_id, new Set());
    completedByFca.get(r.fca_id).add(r.flight_key);
  }
  return rows.length;
}

async function loadFcas() {
  const rows = await sb("fcas", { query: "?select=id,data" }) || [];
  return rows.map(r => {
    const data = r.data && typeof r.data === "object" ? r.data : {};
    if (!data.id) data.id = r.id;
    return data;
  }).filter(isTrackableFca);
}

/**
 * PostgREST resolves an upsert against the primary key unless on_conflict names
 * the constraint. Both tables key on a surrogate uuid, so without on_conflict
 * every re-upsert of an already-open track raised 23505 and killed the poll.
 */
const ON_CONFLICT = "?on_conflict=fca_id,flight_key";

async function persist(fcaId, { upserts, crossings, lost }) {
  if (DRY_RUN) return;
  for (const c of crossings) {
    await sb("fca_crossings", {
      method: "POST",
      query: ON_CONFLICT,
      body: crossingToRow(c),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
    await sb("fca_crossing_tracks", {
      method: "DELETE",
      query: `?fca_id=eq.${encodeURIComponent(fcaId)}&flight_key=eq.${encodeURIComponent(c.flight_key)}`,
    });
  }
  const rows = [...upserts, ...lost].map(trackToRow);
  if (rows.length) {
    await sb("fca_crossing_tracks", {
      method: "POST",
      query: ON_CONFLICT,
      body: rows,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
}

async function fetchVatsim() {
  const r = await fetch(VATSIM_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("VATSIM HTTP " + r.status);
  return r.json();
}

async function poll() {
  const nowMs = Date.now();
  const [fcas, feed] = await Promise.all([loadFcas(), fetchVatsim()]);
  const pilots = (feed.pilots || []).map(vatsimToTrackPilot).filter(Boolean);
  if (!pilots.length) {
    log("poll skip expire — VATSIM returned 0 connected pilots");
    return;
  }
  let nCross = 0, nOpen = 0, nLost = 0, nNew = 0;
  for (const fca of fcas) {
    if (!tracksByFca.has(fca.id)) tracksByFca.set(fca.id, new Map());
    if (!completedByFca.has(fca.id)) completedByFca.set(fca.id, new Set());
    const before = new Set(tracksByFca.get(fca.id).keys());
    const result = processFcaPoll(
      fca,
      pilots,
      tracksByFca.get(fca.id),
      completedByFca.get(fca.id),
      nowMs,
    );
    await persist(fca.id, result);
    for (const t of result.upserts) {
      if (before.has(t.flight_key)) continue;
      nNew++;
      log(`  FREEZE ${t.callsign} ${t.dep}->${t.arr} ${fca.name} planned=${toIso(t.planned_at)} from=${t.planned_from} dist=${Math.round(t.dist_nm_at_plan || 0)}nm`);
    }
    for (const c of result.crossings) {
      log(`  CROSS  ${c.callsign} ${c.dep}->${c.arr} ${fca.name} planned=${toIso(c.planned_at)} actual=${toIso(c.actual_at)} delta=${c.delta_sec}s`);
    }
    for (const l of result.lost) log(`  LOST   ${l.callsign} ${fca.name}`);
    nCross += result.crossings.length;
    nLost += result.lost.length;
    nOpen += tracksByFca.get(fca.id).size;
  }
  log(`poll${DRY_RUN ? " [dry-run]" : ""} fcas=${fcas.length} pilots=${pilots.length} new=${nNew} open=${nOpen} crossings=${nCross} lost=${nLost}`);
}

async function main() {
  if (!SERVICE_KEY && !DRY_RUN) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is required (or set DRY_RUN=1 to log without writing)");
    process.exit(1);
  }
  if (DRY_RUN) log("DRY RUN — reading with the anon key, no writes");
  bindWindAirportLookup(icao => getAirport(icao));
  log("loading airports / nav / ARTCC / winds…");
  await Promise.all([
    loadAirports(),
    loadNavData(NAV_BASE),
    fetchArtccBoundaries(SITE_BASE),
  ]);
  try {
    const w = await fetchWinds();
    log("winds", w.status, w.count);
  } catch (e) {
    log("winds failed (still-air fallback):", e.message || e);
  }
  windTimer = setInterval(() => {
    fetchWinds().catch(err => log("winds refresh:", err.message || err));
  }, 30 * 60 * 1000);

  const [nOpen, nDone] = await Promise.all([loadOpenTracks(), loadCompletedKeys()]);
  log(`restored open=${nOpen} completed=${nDone}`);

  let polls = 0, pollErrors = 0;
  const tick = async () => {
    try { await poll(); polls++; }
    catch (e) { pollErrors++; log("poll error:", e.message || e); }
  };
  await tick();
  const pollTimer = setInterval(tick, POLL_MS);

  if (RUN_SECONDS) {
    log(`will exit after ${RUN_SECONDS}s`);
    setTimeout(() => {
      clearInterval(pollTimer);
      if (windTimer) clearInterval(windTimer);
      log(`shutting down — polls=${polls} errors=${pollErrors}`);
      // A run that errored more often than it polled recorded next to nothing,
      // even if one early cycle got through. Fail loudly rather than look green.
      process.exit(polls > 0 && pollErrors < polls ? 0 : 1);
    }, RUN_SECONDS * 1000);
  }
}

process.on("SIGINT", () => { if (windTimer) clearInterval(windTimer); process.exit(0); });
process.on("SIGTERM", () => { if (windTimer) clearInterval(windTimer); process.exit(0); });

main().catch(err => {
  console.error(err);
  process.exit(1);
});
