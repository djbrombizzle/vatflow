/**
 * Shared My Dashboard / IDST position filters.
 * Same localStorage keys as Airport TMU My Dashboard so tower/APP/center
 * scopes stay in sync across pages.
 *
 * ARTCC matching uses fca-metering depMatchesArtcc (local ARTCC boundaries).
 * Approach matching uses approach-sector-data.js globals (seed via setApproachData).
 */
import { depMatchesArtcc, airportCodesMatch, getAirport, isPctField, pctDepartureMatch } from "./fca-metering.js";

export const LS_AIRPORTS = "vatflow_my_airports";
export const LS_ARTCCS = "vatflow_my_artccs";
export const LS_APPROACH = "vatflow_my_approach";

export const MAX_AIRPORTS = 20;
export const MAX_ARTCCS = 10;
export const MAX_APPROACH = 10;

/** My Dashboard polygon overrides (ARTCC → include/exclude airports). */
export const MYDASH_ARTCC_OVERRIDES = {
  ZJX: { include: ["KMCO"], exclude: ["KTPA"] },
  ZMA: { include: ["KTPA"], exclude: ["KMCO"] },
};

let airports = [];
let artccs = [];
let approachSectors = [];
let traconPrefixMap = null;
let vatspyApproach = null;

function loadJson(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved) || fallback;
  } catch (_) {}
  return fallback;
}

function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
}

export function loadFilters() {
  airports = loadJson(LS_AIRPORTS, []);
  artccs = loadJson(LS_ARTCCS, []);
  approachSectors = loadJson(LS_APPROACH, []);
  return getFilters();
}

export function getFilters() {
  return {
    airports: airports.slice(),
    artccs: artccs.slice(),
    approachSectors: approachSectors.slice(),
  };
}

export function hasFilters() {
  return airports.length > 0 || artccs.length > 0 || approachSectors.length > 0;
}

export function normArtcc(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validArtcc(v) {
  const s = normArtcc(v);
  return /^[A-Z][A-Z0-9]{2,4}$/.test(s);
}

export function normApproachSector(v) {
  return normArtcc(v);
}

export function validApproachSector(v) {
  const s = normApproachSector(v);
  return /^[A-Z][A-Z0-9]{1,4}$/.test(s);
}

export function normAirport(v) {
  let s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 3) s = "K" + s;
  return s;
}

export function validAirport(v) {
  const s = normAirport(v);
  return /^[A-Z][A-Z0-9]{2,3}$/.test(s);
}

export function addAirport(icao) {
  const v = normAirport(icao);
  if (!validAirport(v) || airports.length >= MAX_AIRPORTS || airports.includes(v)) return false;
  airports.push(v);
  saveJson(LS_AIRPORTS, airports);
  return true;
}

export function removeAirport(icao) {
  const v = normAirport(icao);
  airports = airports.filter(a => a !== v);
  saveJson(LS_AIRPORTS, airports);
}

export function addArtcc(id) {
  const v = normArtcc(id);
  if (!validArtcc(v) || artccs.length >= MAX_ARTCCS || artccs.includes(v)) return false;
  artccs.push(v);
  saveJson(LS_ARTCCS, artccs);
  return true;
}

export function removeArtcc(id) {
  const v = normArtcc(id);
  artccs = artccs.filter(a => a !== v);
  saveJson(LS_ARTCCS, artccs);
}

export function addApproach(id) {
  const v = normApproachSector(id);
  if (!validApproachSector(v) || approachSectors.length >= MAX_APPROACH || approachSectors.includes(v)) return false;
  approachSectors.push(v);
  saveJson(LS_APPROACH, approachSectors);
  return true;
}

export function removeApproach(id) {
  const v = normApproachSector(id);
  approachSectors = approachSectors.filter(a => a !== v);
  saveJson(LS_APPROACH, approachSectors);
}

export function scopeLabel() {
  const parts = [];
  if (airports.length) parts.push("your airports");
  if (artccs.length) parts.push("your ARTCCs");
  if (approachSectors.length) parts.push("your approach sectors");
  if (!parts.length) return "your filters";
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/**
 * Seed approach lookup tables from approach-sector-data.js globals.
 * @param {Record<string, string[]>|null} prefixMap
 * @param {Record<string, string>|null} approachMap
 */
export function setApproachData(prefixMap, approachMap) {
  traconPrefixMap = prefixMap || null;
  vatspyApproach = approachMap || null;
}

export function approachDataReady() {
  return !!(traconPrefixMap && vatspyApproach);
}

/** True when any approach filter needs VATSpy/TRACON tables (PCT uses PCT_AIRPORTS). */
export function approachFiltersNeedSectorData() {
  return approachSectors.some(s => !isPctField(s));
}

/**
 * VATSpy approach LID sometimes differs from TRACON_PREFIX_MAP tokens
 * (KDCA → WAS while PCT lists DCA).
 */
const APPROACH_PREFIX_ALIASES = {
  WAS: ["DCA", "PCT", "WAS"],
};

export function airportInApproachSector(depIcao, sector) {
  if (!sector) return false;
  const id = normApproachSector(sector);
  // Potomac TRACON — use the same airport list as Release Board / FCA PCT mode.
  // VATSpy maps KDCA→WAS, which is not in TRACON_PREFIX_MAP["PCT"], so prefix
  // matching alone misses DCA departures.
  if (isPctField(id)) return pctDepartureMatch(depIcao);

  if (!traconPrefixMap || !vatspyApproach) return false;
  const prefixes = traconPrefixMap[id];
  if (!prefixes || !prefixes.length) return false;
  const dep = (depIcao || "").toUpperCase();
  const appr = vatspyApproach[dep]
    || (dep.length === 4 && dep[0] === "K" ? vatspyApproach[dep.slice(1)] : null);
  if (!appr) return false;
  if (prefixes.includes(appr)) return true;
  const aliases = APPROACH_PREFIX_ALIASES[appr];
  return !!(aliases && aliases.some(a => prefixes.includes(a)));
}

/** ARTCC match with My Dashboard include/exclude overrides, else fca-metering. */
export function airportInMyDashArtcc(depIcao, artcc) {
  const dep = (depIcao || "").toUpperCase();
  const id = normArtcc(artcc);
  const ovr = MYDASH_ARTCC_OVERRIDES[id];
  if (ovr) {
    if (ovr.exclude && ovr.exclude.includes(dep)) return false;
    if (ovr.include && ovr.include.includes(dep)) return true;
  }
  return depMatchesArtcc({ dep, lat: null, lon: null }, id);
}

/** True when departure airport matches any active filter (OR across types). */
export function depMatchesFilters(depIcao) {
  const dep = (depIcao || "").toUpperCase();
  if (!dep) return false;
  if (!hasFilters()) return false;
  if (airports.some(a => airportCodesMatch(dep, a))) return true;
  if (artccs.length) {
    for (const a of artccs) {
      if (airportInMyDashArtcc(dep, a)) return true;
    }
  }
  if (approachSectors.length) {
    for (const s of approachSectors) {
      // PCT does not need approach-sector-data.js (uses PCT_AIRPORTS).
      if (isPctField(s) || approachDataReady()) {
        if (airportInApproachSector(dep, s)) return true;
      }
    }
  }
  return false;
}

/** Convenience: ensure airport coords resolve for ARTCC polygon checks. */
export function ensureAirportDbTouched() {
  return typeof getAirport === "function";
}
