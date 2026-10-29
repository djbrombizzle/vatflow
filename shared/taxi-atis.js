/**
 * Runways in use for a field, read from whatever ATIS is available.
 *
 * Two sources, in order:
 *   1. VATSIM ATIS from the live feed (KIAD_ATIS, and the split KIAD_D_ATIS /
 *      KIAD_A_ATIS when a field runs separate departure and arrival ATIS).
 *      Free — the feed is already being polled — and it is what the controllers
 *      working the field actually published.
 *   2. The real-world FAA D-ATIS, fetched only when no VATSIM ATIS names any
 *      runway. Useful when nobody is staffing the field but the flow should
 *      still match what the airport is really doing.
 *
 * Deliberately read-only and client-side. Every client derives the same answer
 * from the same ATIS, so the shared config does not need one of them to win a
 * race to push runways to the hub.
 *
 * The parsing itself is shared/atis-runways.js, the same reading VATSMART uses.
 */
import { runwaysFromAtis } from "./atis-runways.js";
import { fetchDatis } from "./datis-fetch.js";
import { atisInfo } from "./datis-parse.js";

/** Re-fetch the real-world D-ATIS at most this often, per field. */
const DATIS_TTL_MS = 5 * 60000;

/** @type {Array<{callsign: string, code: string, text: string}>} */
let vatsimAtis = [];
/** ICAO -> { entries, at, state } for the FAA fallback. */
const datisCache = new Map();

function icaoOf(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Keep the ATIS stations from a VATSIM data-feed poll.
 * Call once per feed update with `d.atis`.
 */
export function setVatsimAtis(list) {
  vatsimAtis = (list || [])
    .filter(a => a && /_ATIS$/.test(a.callsign || ""))
    .map(a => ({
      callsign: a.callsign,
      code: a.atis_code || "",
      text: Array.isArray(a.text_atis) ? a.text_atis.join(" ").trim() : String(a.text_atis || "").trim(),
    }))
    .filter(a => a.text);
}

/**
 * VATSIM ATIS stations for one field, tagged with what they cover.
 * A field running one combined ATIS gets "both"; KIAD_D_ATIS is departures only.
 */
export function vatsimAtisFor(icao) {
  const field = icaoOf(icao);
  if (!field) return [];
  return vatsimAtis
    .filter(a => a.callsign.startsWith(field + "_"))
    .map(a => ({
      ...a,
      kind: /_D_ATIS$/.test(a.callsign) ? "dep" : /_A_ATIS$/.test(a.callsign) ? "arr" : "both",
    }));
}

/** Merge several ATIS stations into one arrival / departure runway reading. */
export function runwaysFromStations(list, known) {
  const arr = new Set();
  const dep = new Set();
  for (const a of list || []) {
    const r = runwaysFromAtis(a.text, known);
    // A departure ATIS never contributes arrival runways, and vice versa.
    if (a.kind !== "dep") r.arr.forEach(x => arr.add(x));
    if (a.kind !== "arr") r.dep.forEach(x => dep.add(x));
  }
  return { arr: [...arr].sort(), dep: [...dep].sort() };
}

/**
 * Runways in use for a field, from the best ATIS available right now.
 *
 * Synchronous: it reads the VATSIM feed already in hand and whatever D-ATIS has
 * been fetched. Call ensureDatis() alongside to keep that fallback warm.
 *
 * @returns {{ arr: string[], dep: string[], source: "vatsim"|"faa"|"none",
 *             label: string, code: string, stations: string[] }}
 */
export function atisRunways(icao, known) {
  const field = icaoOf(icao);
  const stations = vatsimAtisFor(field);
  const live = runwaysFromStations(stations, known);
  if (live.arr.length || live.dep.length) {
    const letters = stations.map(s => s.code).filter(Boolean);
    return {
      ...live,
      source: "vatsim",
      label: "VATSIM ATIS",
      code: letters.length ? [...new Set(letters)].join("/") : "",
      stations: stations.map(s => s.callsign),
    };
  }

  const cached = datisCache.get(field);
  const faaEntries = (cached && cached.entries) || [];
  if (faaEntries.length) {
    const faa = runwaysFromStations(faaEntries, known);
    if (faa.arr.length || faa.dep.length) {
      return {
        ...faa,
        source: "faa",
        label: "FAA D-ATIS",
        code: faaEntries.map(e => e.code).filter(Boolean).join("/"),
        stations: faaEntries.map(e => e.callsign),
      };
    }
  }

  return {
    arr: [], dep: [], source: "none",
    label: stations.length ? "ATIS has no runways" : "no ATIS",
    code: "", stations: stations.map(s => s.callsign),
  };
}

/**
 * Keep the FAA D-ATIS fallback warm for a field, but only while the VATSIM ATIS
 * is not already naming runways — no point spending a cross-origin fetch on a
 * field whose controllers have published a usable ATIS.
 *
 * Resolves to true when something was fetched. Never rejects.
 */
export function ensureDatis(icao, known) {
  const field = icaoOf(icao);
  if (!field) return Promise.resolve(false);

  /* Without the field's runway ends nothing can be validated, so a VATSIM ATIS
     that does name runways still reads as empty — and fetching here would hit
     the network on every feed tick while the ends are still loading. Wait. */
  if (!known || !known.length) return Promise.resolve(false);

  const live = runwaysFromStations(vatsimAtisFor(field), known);
  if (live.arr.length || live.dep.length) return Promise.resolve(false);

  const cached = datisCache.get(field);
  if (cached && cached.state === "wait") return Promise.resolve(false);
  if (cached && Date.now() - cached.at < DATIS_TTL_MS) return Promise.resolve(false);

  datisCache.set(field, { entries: (cached && cached.entries) || [], at: Date.now(), state: "wait" });
  return fetchDatis(field)
    .then(list => {
      const entries = (list || []).map(d => ({
        callsign: "FAA D-ATIS" + (d.type === "arr" ? " ARR" : d.type === "dep" ? " DEP" : ""),
        code: atisInfo(d.datis).letter || "",
        text: d.datis,
        kind: d.type === "arr" ? "arr" : d.type === "dep" ? "dep" : "both",
      }));
      datisCache.set(field, { entries, at: Date.now(), state: "ok" });
      return true;
    })
    .catch(() => {
      // No D-ATIS for this field (most non-US airports) — remember the miss so
      // the TTL throttles retries instead of hammering on every feed tick.
      datisCache.set(field, { entries: [], at: Date.now(), state: "bad" });
      return false;
    });
}

/** Seed both sources in tests or offline demo. */
export function seedAtis({ vatsim, faa } = {}) {
  if (vatsim) setVatsimAtis(vatsim);
  if (faa) {
    for (const [icao, entries] of Object.entries(faa)) {
      datisCache.set(icaoOf(icao), { entries, at: Date.now(), state: "ok" });
    }
  }
}

/** Forget everything — tests. */
export function resetAtis() {
  vatsimAtis = [];
  datisCache.clear();
}
