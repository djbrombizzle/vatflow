/**
 * EDST ground traffic for the Sort → SHOW GROUND A/C filter.
 *
 * The hub ACL feed carries the enroute picture: an aircraft parked at a gate or
 * taxiing is not in it, so filtering that feed by ground speed can only ever
 * return what the hub already decided to send. This module builds ACL board rows
 * straight from the VATSIM pilot feed (the same payload the DEP list fetches),
 * which is what lets a controller raise an aircraft on the ground via CPDLC.
 *
 * Selection is by departure airport, never by the frequency the pilot is tuned
 * to — aircraft on the ground are on a tower/ground frequency, not ours.
 */
import { fpFields, depMatchesArtcc } from "./fca-metering.js";

/** At or above this ground speed the aircraft is rolling/airborne, not "on the ground". */
export const GROUND_GS_KT = 60;

function normArtcc(id) {
  return (id || "").toUpperCase().replace(/^K(?=Z)/, "");
}

/** Free-typed airport box → normalised ICAO list ("katl, kmco" → ["KATL","KMCO"]). */
export function parseApts(txt) {
  if (Array.isArray(txt)) {
    return txt.map((t) => String(t || "").toUpperCase().trim()).filter(Boolean);
  }
  return String(txt || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/** A 3-letter entry (ATL) matches the 4-letter ICAO (KATL). */
export function aptMatches(dep, want) {
  const d = String(dep || "").toUpperCase();
  if (!d) return false;
  return want.some(
    (w) => d === w || (w.length === 3 && d.length === 4 && d.slice(1) === w),
  );
}

function flOf(altFt) {
  const ft = Number(altFt);
  if (!Number.isFinite(ft) || ft <= 0) return 0;
  return Math.round(ft / 100);
}

function shortType(fp) {
  const raw = (fp && (fp.aircraft_short || fp.aircraft_faa || fp.aircraft)) || "";
  return String(raw).trim() || "----";
}

/**
 * Build ACL rows for aircraft on the ground.
 *
 * @param {string} artcc staffed ARTCC ("ZTL" / "KZTL"); used when no airport is typed
 * @param {object} vatsim VATSIM v3 data.json payload
 * @param {{ apts?: string|string[] }} [opts] departure airports typed in the Sort box
 * @returns {{ items: object[], count: number, artcc: string, apts: string[] }}
 */
export function buildGroundList(artcc, vatsim, opts = {}) {
  const art = normArtcc(artcc);
  const want = parseApts(opts.apts);
  const items = [];
  const seen = new Set();
  // No airport typed and no ARTCC to fall back on — we cannot say which ground
  // traffic is ours, and showing every airport on the network would be worse
  // than showing none.
  if (!want.length && !art) return { items, count: 0, artcc: art, apts: want };

  for (const p of (vatsim && vatsim.pilots) || []) {
    const cs = (p.callsign || "").toUpperCase();
    if (!cs || seen.has(cs)) continue;
    const gs = Number(p.groundspeed) || 0;
    if (gs >= GROUND_GS_KT) continue;
    const fp = p.flight_plan || null;
    const f = fpFields(fp);
    if (want.length) {
      if (!aptMatches(f.dep, want)) continue;
    } else if (!depMatchesArtcc({ dep: f.dep, lat: p.latitude, lon: p.longitude }, art)) {
      continue;
    }
    seen.add(cs);
    const route = f.route || "";
    items.push({
      cs,
      type: shortType(fp),
      alt: flOf(p.altitude),
      hs: "/" + Math.round(gs),
      cid: String(p.cid || ""),
      squawk: p.transponder || "",
      assignedSquawk: "",
      hdg: Math.round(Number(p.heading) || 0),
      gs,
      lat: p.latitude,
      lon: p.longitude,
      cruise: f.fpAlt ? String(Math.round(f.fpAlt / 100)).padStart(3, "0") : "",
      route: [f.dep, route, f.arr].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
      _routeRaw: route,
      routeFixes: null,
      cat: "DEP",
      dep: f.dep,
      arr: f.arr,
      source: "ground",
      onFreq: false,
    });
  }
  items.sort((a, b) => a.cs.localeCompare(b.cs));
  return { items, count: items.length, artcc: art, apts: want };
}

/**
 * Merge ground rows into the board list, keeping the hub's own row when both
 * carry the same callsign (it has the CPDLC / frequency annotations).
 */
export function mergeGroundRows(list, groundRows) {
  const out = Array.isArray(list) ? list.slice() : [];
  const have = new Set(out.map((a) => String((a && a.cs) || "").toUpperCase()));
  for (const g of groundRows || []) {
    const cs = String((g && g.cs) || "").toUpperCase();
    if (!cs || have.has(cs)) continue;
    have.add(cs);
    out.push(g);
  }
  return out;
}
