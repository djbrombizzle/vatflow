/**
 * Match live flights against the vZDC SOP / LOA reference items
 * (shared/zdc-reference-data.js) and search them. Pure functions — no DOM,
 * no fetch — so scripts/test-zdc-reference.mjs can run them under node.
 */
import { flightRoutePoints, engineClass, cruiseFeet } from "./zdc-sop-match.js";

/** Helicopter type designators (AIRCRAFT_ENGINE has none). */
const HELI = new Set([
  "A109", "A119", "A139", "A169", "AS32", "AS50", "AS55", "AS65", "B06", "B105", "B212", "B407", "B412", "B429",
  "B505", "EC20", "EC30", "EC35", "EC45", "EC55", "EC75", "H47", "H53", "H60", "H64", "MI8", "R22", "R44", "R66",
  "S61", "S70", "S76", "S92", "UH1", "V22",
]);

function icao(id) {
  const s = String(id || "").toUpperCase().trim();
  return s.length === 3 ? "K" + s : s;
}

function baseType(type) {
  const parts = String(type || "").toUpperCase().split("/");
  return parts.length > 1 && /^[LMHJS]$/.test(parts[0]) ? parts[1] : parts[0];
}

/** "jet" | "turboprop" | "piston" | "heli" | null. */
export function flightClass(type) {
  if (HELI.has(baseType(type))) return "heli";
  return engineClass(type);
}

const ACFT_CLASSES = {
  jet: ["jet"], prop: ["turboprop", "piston"], tp: ["turboprop"], pn: ["piston"], heli: ["heli"],
};

/** Does an item's aircraft limit fit? → {ok, unknown}. */
export function acftFits(acft, cls) {
  const want = ACFT_CLASSES[String(acft || "").toLowerCase()];
  if (!want) return { ok: true, unknown: false };
  if (!cls) return { ok: acft !== "heli", unknown: acft !== "heli" };
  return { ok: want.includes(cls), unknown: false };
}

/** "ZID" / "ZDC" → that ARTCC id; terminal facilities ("PCT", "IAD ATCT") → null. */
export function artccId(fac) {
  const s = String(fac || "").toUpperCase();
  return /^Z[A-Z]{2}$/.test(s) ? s : null;
}

/** Route tokens a flight can match on: filed tokens, SID/STAR base names, expanded fixes. */
export function routeTokenSet(route, extraFixes = []) {
  const fp = flightRoutePoints(route, extraFixes);
  return new Set([...fp.points.keys(), ...fp.stars]);
}

/**
 * Items that apply to one flight.
 * @param {{dep, arr, route, type, altitude, rules?}} flight  rules: VATSIM flight_rules "I"/"V"
 * @param {object[]} items  REF_ITEMS (only `live` items are considered)
 * @param {{extraFixes?: string[], viaArtcc?: (id: string) => boolean|null}} [opts]
 *   viaArtcc: does the flight's route pass through that ARTCC (null = unknown).
 *   Gates LOA rules on the ARTCCs they name: a "ZID → ZDC" rule needs a route
 *   through both ZID and ZDC.
 * @returns {Array<{item, role:"dep"|"arr"|"over", hits:string[], typeUnknown:boolean}>}
 */
export function matchReference(flight, items, opts = {}) {
  const dep = icao(flight.dep), arr = icao(flight.arr);
  const tokens = routeTokenSet(flight.route, opts.extraFixes || []);
  const cls = flightClass(flight.type);
  const cruise = cruiseFeet(flight.altitude);
  const fr = { I: "IFR", V: "VFR" }[String(flight.rules || "").toUpperCase()] || "";
  const out = [];
  for (const item of items) {
    if (!item.live) continue;
    const deps = item.dep || [], arrs = item.arr || [], fixes = item.fixes || [];
    const depHit = deps.includes(dep), arrHit = arrs.includes(arr);
    if (item.both ? !(depHit && arrHit) : (deps.length || arrs.length) && !depHit && !arrHit) continue;
    if (item.fr && fr && item.fr !== fr) continue;
    if (!deps.length && !arrs.length && !fixes.length) continue;
    const hits = fixes.filter(f => tokens.has(f));
    if (fixes.length && (item.fixMode === "all" ? hits.length < fixes.length : !hits.length)) continue;
    const role = depHit ? "dep" : arrHit ? "arr" : "over";
    if (opts.viaArtcc && [item.from, item.to].some(fac => artccId(fac) && opts.viaArtcc(artccId(fac)) === false)) continue;
    const fit = acftFits(item.acft, cls);
    if (!fit.ok) continue;
    if (cruise != null && ((item.minAlt != null && cruise < item.minAlt) || (item.maxAlt != null && cruise > item.maxAlt))) continue;
    out.push({ item, role, hits, typeUnknown: fit.unknown });
  }
  return out;
}

/** Lower-case search text for an item (title, rule, refs, airports, fixes, keywords). */
export function itemHaystack(item, doc) {
  return [
    item.title, item.text, item.restr, item.ref, item.cat, item.from, item.to, item.flow,
    ...(item.dep || []), ...(item.arr || []), ...(item.fixes || []), ...(item.kw || []),
    ...(item.dep || []).concat(item.arr || []).map(a => a.replace(/^K/, "")),
    doc ? doc.title : "", doc ? doc.id : "", doc ? doc.number : "",
  ].filter(Boolean).join(" ").toUpperCase();
}

/** Every whitespace-separated word of `q` appears in `hay` (both upper-case). */
export function matchesQuery(hay, q) {
  const words = String(q || "").toUpperCase().split(/\s+/).filter(Boolean);
  return words.every(w => hay.includes(w));
}

/**
 * ZDC SOP crossing rows (shared/zdc-sop-data.js) as reference items, so the
 * Rules view searches them next to the LOAs and tower SOPs.
 */
export function sopRowsAsItems(rows, sectors, sectorRef) {
  return rows.map(r => {
    const giver = sectors[r[0]] ? `${r[0]} ${sectors[r[0]]}` : r[0];
    const recv = sectors[r[5]] ? `${r[5]} ${sectors[r[5]]}` : r[5];
    return {
      doc: "ZDC-SOP", ref: sectorRef[r[0]] || "Ch 4", cat: "Handoff",
      title: `${r[1]}${r[2] ? " " + r[2] : ""} via ${r[3]}`.slice(0, 80),
      text: `Sector ${giver} to ${recv}: traffic for ${r[1]}${r[2] ? ` (${r[2]})` : ""} routed ${r[3]} — ${r[4]}.`,
      restr: r[4], from: r[0], to: r[5], dep: [], arr: [], fixes: [], live: false, sop: true,
    };
  });
}
