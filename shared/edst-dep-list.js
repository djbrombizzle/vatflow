/**
 * EDST Departure List — proposed deps for the staffed ARTCC.
 *
 * Sources VATSIM prefiles + connected ground traffic. Filters by:
 *   - departure airport inside the staffed ARTCC boundary (airport overrides)
 *   - proposal time in [now − 30 min, now + 2 h]
 *   - not airborne (gs ≤ 60 or alt ≤ 300)
 *
 * "A" (active) = callsign currently connected on VATSIM.
 */
import { fetchArtccBoundaries } from "./artcc-scope.js";
import {
  loadAirports,
  airportArtcc,
  ptimeToMs,
  parseAlt,
  fpFields,
} from "./fca-metering.js";

export const DEP_PAST_MS = 30 * 60 * 1000;
export const DEP_FUTURE_MS = 2 * 60 * 60 * 1000;
export const VATSIM_DATA_URL = "https://data.vatsim.net/v3/vatsim-data.json";

const AIR_GS = 60;
const AIR_ALT = 300;

let ready = false;
let readyP = null;

function normArtcc(id) {
  return (id || "").toUpperCase().replace(/^K(?=Z)/, "");
}

function isAirborne(gs, alt) {
  return (gs || 0) > AIR_GS && (alt || 0) > AIR_ALT;
}

function inTimeWindow(etdMs, nowMs) {
  if (etdMs == null || !Number.isFinite(etdMs)) return false;
  return etdMs >= nowMs - DEP_PAST_MS && etdMs <= nowMs + DEP_FUTURE_MS;
}

function depBelongsToArtcc(depIcao, artcc) {
  const art = normArtcc(artcc);
  if (!art || !depIcao) return false;
  const owner = airportArtcc(depIcao);
  return !!owner && owner === art;
}

function shortCid(cid) {
  const s = String(cid || "").replace(/\D/g, "");
  if (!s) return "---";
  return s.slice(-3).padStart(3, "0");
}

function fmtType(fp) {
  const raw = (fp && (fp.aircraft_short || fp.aircraft_faa || fp.aircraft)) || "";
  return String(raw).trim() || "----";
}

function cruiseFl(fp) {
  const ft = parseAlt(fp && fp.altitude);
  if (!ft) return "";
  return String(Math.round(ft / 100)).padStart(3, "0");
}

function routeText(fp, dep, arr) {
  const r = ((fp && fp.route) || "").trim();
  return [dep, r, arr].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Load airports + ARTCC boundaries once (idempotent).
 * @param {string} [baseUrl] repo root for local boundary geojson (e.g. "../../")
 */
export function prepareDepListData(baseUrl = "") {
  if (ready) return Promise.resolve(true);
  if (readyP) return readyP;
  readyP = Promise.all([
    loadAirports(),
    fetchArtccBoundaries(baseUrl),
  ]).then(() => {
    ready = true;
    return true;
  }).catch(err => {
    readyP = null;
    throw err;
  });
  return readyP;
}

export function isDepListReady() {
  return ready;
}

/**
 * Build departure-list rows for one ARTCC from a VATSIM v3 payload.
 * @returns {{ items: object[], count: number, artcc: string, nowMs: number }}
 */
export function buildDepList(artcc, vatsim, nowMs = Date.now()) {
  const art = normArtcc(artcc);
  const items = [];
  const byCs = new Map();
  const pilots = (vatsim && vatsim.pilots) || [];
  const prefiles = (vatsim && vatsim.prefiles) || [];

  const online = new Map();
  for (const p of pilots) {
    const cs = (p.callsign || "").toUpperCase();
    if (cs) online.set(cs, p);
  }

  function upsert(row) {
    const prev = byCs.get(row.cs);
    if (!prev || (row.active && !prev.active)) byCs.set(row.cs, row);
  }

  for (const pf of prefiles) {
    const fp = pf.flight_plan || {};
    const fields = fpFields(fp);
    if (!depBelongsToArtcc(fields.dep, art)) continue;
    const etdMs = ptimeToMs(fields.deptime);
    if (!inTimeWindow(etdMs, nowMs)) continue;
    const cs = (pf.callsign || "").toUpperCase();
    if (!cs) continue;
    const live = online.get(cs);
    if (live && isAirborne(live.groundspeed, live.altitude)) continue;
    upsert({
      cs,
      cid: shortCid(pf.cid || (live && live.cid)),
      rawCid: pf.cid || (live && live.cid) || "",
      type: fmtType(fp),
      alt: cruiseFl(fp),
      squawk: (live && live.transponder) || "",
      route: routeText(fp, fields.dep, fields.arr),
      dep: fields.dep,
      arr: fields.arr,
      deptime: fields.deptime || "",
      etdMs,
      edct: "",
      active: !!live,
      source: live ? "active" : "proposed",
    });
  }

  // Connected ground traffic with a filed plan (may have left prefiles).
  for (const p of pilots) {
    const fp = p.flight_plan;
    if (!fp) continue;
    if (isAirborne(p.groundspeed, p.altitude)) continue;
    const fields = fpFields(fp);
    if (!depBelongsToArtcc(fields.dep, art)) continue;
    let etdMs = ptimeToMs(fields.deptime);
    if (etdMs == null) etdMs = nowMs; // ready-now ground: treat as current proposal
    if (!inTimeWindow(etdMs, nowMs)) continue;
    const cs = (p.callsign || "").toUpperCase();
    if (!cs) continue;
    upsert({
      cs,
      cid: shortCid(p.cid),
      rawCid: p.cid || "",
      type: fmtType(fp),
      alt: cruiseFl(fp),
      squawk: p.transponder || "",
      route: routeText(fp, fields.dep, fields.arr),
      dep: fields.dep,
      arr: fields.arr,
      deptime: fields.deptime || "",
      etdMs,
      edct: "",
      active: true,
      source: "active",
    });
  }

  const list = [...byCs.values()];
  sortDepItems(list, "time");
  return { items: list, count: list.length, artcc: art, nowMs };
}

/**
 * Sort DEP strips in place.
 * @param {object[]} items
 * @param {'time'|'dest'|'dep'|'cs'} mode
 */
export function sortDepItems(items, mode) {
  const m = String(mode || "time").toLowerCase();
  const list = Array.isArray(items) ? items : [];
  list.sort((a, b) => {
    if (m === "dest") {
      const aa = String(a.arr || "").toUpperCase();
      const bb = String(b.arr || "").toUpperCase();
      if (aa !== bb) return aa < bb ? -1 : 1;
    } else if (m === "dep") {
      const aa = String(a.dep || "").toUpperCase();
      const bb = String(b.dep || "").toUpperCase();
      if (aa !== bb) return aa < bb ? -1 : 1;
    } else if (m === "cs") {
      const aa = String(a.cs || "").toUpperCase();
      const bb = String(b.cs || "").toUpperCase();
      if (aa !== bb) return aa < bb ? -1 : 1;
    } else {
      // time (default) — proposed P-time ascending
      const at = a.etdMs != null ? a.etdMs : Number.MAX_SAFE_INTEGER;
      const bt = b.etdMs != null ? b.etdMs : Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
    }
    return String(a.cs || "").localeCompare(String(b.cs || ""));
  });
  return list;
}

/** Fetch VATSIM data.json (browser CORS). */
export async function fetchVatsimData() {
  const res = await fetch(VATSIM_DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("VATSIM HTTP " + res.status);
  return res.json();
}
