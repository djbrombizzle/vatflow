/**
 * Runway thresholds and SID -> runway data for taxi-time estimation.
 *
 * Two small lookups, both cached per airport and both optional — the estimator
 * degrades to a coarser tier rather than failing when either is missing.
 *
 *   SID index      data/nav/sid-runways.json (~38 KB, built from procedures.json
 *                  by scripts/build-sid-runways.mjs). Loaded once, whole.
 *
 *   Runway ends    data/nav/runways.json when it has been built, otherwise the
 *                  live OurAirports CSV — the same source and parse that
 *                  runway-balancer.html already uses.
 */
import { normalizeRunway, sidBase } from "./taxi-estimate.js";

const NAV_BASE = "data/nav";
const OURAIRPORTS_RUNWAYS = "https://davidmegginson.github.io/ourairports-data/runways.csv";

let sidIndex = null;
let sidLoading = null;
let builtEndsLoading = null;
let oaCsv = null;
let oaLoading = null;
const endsCache = new Map();
const endsLoading = new Map();

function base() {
  return (typeof window !== "undefined" && window.VATFLOW_NAV_BASE) || NAV_BASE;
}

/** SID -> [runway tokens] for every US airport. Resolves to {} if unavailable. */
export function loadSidRunways() {
  if (sidIndex) return Promise.resolve(sidIndex);
  if (sidLoading) return sidLoading;
  sidLoading = fetch(`${base()}/sid-runways.json`)
    .then(r => (r.ok ? r.json() : {}))
    .then(j => { sidIndex = j || {}; return sidIndex; })
    .catch(() => { sidIndex = {}; return sidIndex; });
  return sidLoading;
}

/** Synchronous view of the SID index for one airport — {} until loaded. */
export function sidRunwaysFor(icao) {
  if (!sidIndex) return {};
  return sidIndex[String(icao || "").toUpperCase()] || {};
}

/** CSV split that respects quoted fields — a naive split shifts every column. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse OurAirports runways.csv for one airport into runway ends.
 * Columns: id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,
 *          closed,le_ident,le_lat,le_lon,le_elev,le_heading,le_displaced,
 *          he_ident,he_lat,he_lon,he_elev,he_heading,he_displaced
 */
export function parseOurAirportsRunways(csv, icao) {
  const field = String(icao || "").toUpperCase();
  const ends = [];
  for (const line of String(csv || "").split("\n")) {
    if (!line.includes(',"' + field + '",')) continue;
    const c = splitCsvLine(line);
    if (c[2] !== field || c[7] === "1") continue;      // wrong field, or closed
    const lenFt = parseInt(c[3], 10) || 0;
    const push = (ident, lat, lon, hdg) => {
      const id = normalizeRunway(ident);
      const la = parseFloat(lat);
      const lo = parseFloat(lon);
      if (!id || !isFinite(la) || !isFinite(lo)) return;
      const h = parseFloat(hdg);
      ends.push({
        id, lat: la, lon: lo, lenFt,
        hdg: isFinite(h) ? Math.round(h) : (parseInt(id, 10) || 0) * 10,
      });
    };
    push(c[8], c[9], c[10], c[12]);       // low end
    push(c[14], c[15], c[16], c[18]);     // high end
  }
  return ends;
}

/**
 * The built threshold index, fetched once and shared.
 *
 * Memoizing the promise rather than a "tried" flag matters: ensureTaxiData()
 * asks for every scoped airport in one synchronous loop, so a flag set before
 * the fetch resolves handed null to every field after the first and sent them
 * all to the multi-megabyte CSV fallback instead.
 */
function loadBuiltEnds() {
  if (builtEndsLoading) return builtEndsLoading;
  builtEndsLoading = fetch(`${base()}/runways.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => j || null)
    .catch(() => null);
  return builtEndsLoading;
}

function loadOaCsv() {
  if (oaCsv != null) return Promise.resolve(oaCsv);
  if (oaLoading) return oaLoading;
  oaLoading = fetch(OURAIRPORTS_RUNWAYS)
    .then(r => (r.ok ? r.text() : ""))
    .then(t => { oaCsv = t || ""; return oaCsv; })
    .catch(() => { oaCsv = ""; return oaCsv; });
  return oaLoading;
}

/**
 * Runway ends for one airport: [{id, lat, lon, hdg, lenFt}].
 * Resolves to [] when neither source has the field — callers must cope.
 */
export function loadRunwayEnds(icao) {
  const field = String(icao || "").toUpperCase();
  if (!field) return Promise.resolve([]);
  if (endsCache.has(field)) return Promise.resolve(endsCache.get(field));
  if (endsLoading.has(field)) return endsLoading.get(field);
  const p = loadBuiltEnds()
    .then(built => {
      if (built && Array.isArray(built[field]) && built[field].length) {
        return built[field].map(([id, lat, lon, hdg, lenFt]) => ({
          id: normalizeRunway(id), lat, lon, hdg, lenFt: lenFt || 0,
        })).filter(e => e.id);
      }
      return loadOaCsv().then(csv => parseOurAirportsRunways(csv, field));
    })
    .then(ends => { endsCache.set(field, ends); endsLoading.delete(field); return ends; })
    .catch(() => { endsCache.set(field, []); endsLoading.delete(field); return []; });
  endsLoading.set(field, p);
  return p;
}

/** Synchronous view — [] until loadRunwayEnds has resolved for this field. */
export function runwayEndsFor(icao) {
  return endsCache.get(String(icao || "").toUpperCase()) || [];
}

/** Seed both lookups in tests or offline demo. */
export function seedTaxiRunwayData({ sids, ends } = {}) {
  if (sids) { sidIndex = sids; sidLoading = Promise.resolve(sidIndex); }
  if (ends) for (const [k, v] of Object.entries(ends)) endsCache.set(k.toUpperCase(), v);
}

/**
 * Every SID published at a field, by base name (BANNG3 and BANNG4 collapse to
 * BANNG). Drives the config drawer's catalog so a controller can pin a runway
 * before anyone files the procedure. [] until the index has loaded.
 */
export function sidNamesFor(icao) {
  return [...new Set(Object.keys(sidRunwaysFor(icao)).map(sidBase).filter(Boolean))].sort();
}

/**
 * Runway tokens published for a SID, accepting a base name — the union across
 * every revision at that field. [] when the field or SID is unknown.
 */
export function publishedRunwaysForSid(icao, nameOrBase) {
  const base = sidBase(nameOrBase);
  if (!base) return [];
  const idx = sidRunwaysFor(icao);
  const out = new Set();
  for (const [name, runways] of Object.entries(idx)) {
    if (sidBase(name) !== base) continue;
    for (const r of runways || []) out.add(r);
  }
  return [...out].sort();
}
