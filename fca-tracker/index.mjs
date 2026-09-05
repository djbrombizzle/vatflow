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
const NAV_BASE = process.env.VATFLOW_NAV_BASE || "https://vatflow.io/data/nav";
const SITE_BASE = (process.env.VATFLOW_SITE_BASE || "https://vatflow.io/").replace(/\/?$/, "/");
const POLL_MS = Math.max(10000, parseInt(process.env.POLL_MS, 10) || 20000);
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
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
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

async function loadCompletedKeys() {
  const rows = await sb("fca_crossings", { query: "?select=fca_id,flight_key" }) || [];
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

async function persist(fcaId, { upserts, crossings, lost }) {
  for (const c of crossings) {
    await sb("fca_crossings", {
      method: "POST",
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
  let nCross = 0, nOpen = 0, nLost = 0;
  for (const fca of fcas) {
    if (!tracksByFca.has(fca.id)) tracksByFca.set(fca.id, new Map());
    if (!completedByFca.has(fca.id)) completedByFca.set(fca.id, new Set());
    const result = processFcaPoll(
      fca,
      pilots,
      tracksByFca.get(fca.id),
      completedByFca.get(fca.id),
      nowMs,
    );
    await persist(fca.id, result);
    nCross += result.crossings.length;
    nLost += result.lost.length;
    nOpen += tracksByFca.get(fca.id).size;
  }
  log(`poll fcas=${fcas.length} pilots=${pilots.length} open=${nOpen} crossings=${nCross} lost=${nLost}`);
}

async function main() {
  if (!SERVICE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is required");
    process.exit(1);
  }
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

  const tick = async () => {
    try { await poll(); }
    catch (e) { log("poll error:", e.message || e); }
  };
  await tick();
  setInterval(tick, POLL_MS);
}

process.on("SIGINT", () => { if (windTimer) clearInterval(windTimer); process.exit(0); });
process.on("SIGTERM", () => { if (windTimer) clearInterval(windTimer); process.exit(0); });

main().catch(err => {
  console.error(err);
  process.exit(1);
});
