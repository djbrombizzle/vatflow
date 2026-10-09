/**
 * Match live flights against the ZDC SOP crossing restriction tables
 * (shared/zdc-sop-data.js). Pure functions — no DOM, no fetch — so
 * scripts/test-zdc-sop-match.mjs can run them under node.
 */
import { ROWS, CONFIGS, DESCEND_VIA } from "./zdc-sop-data.js";
import { AIRCRAFT_ENGINE } from "./mit-monitor.js";

/** Airports within this distance of a "+"/SATS primary count as its satellites. */
export const SAT_RADIUS_NM = 35;

const AIRWAY_RE = /^[JQVTY]\d{1,4}$|^AR\d{1,3}$/;
const STAR_REV_RE = /^([A-Z]{3,5})\d[A-Z]?$/;
const FIX_RE = /^[A-Z]{2,5}$/;
const ANY_RE = /^(ANY|ALL TRANSITIONS|DIRECT)$/;

function icao(id) {
  const s = String(id || "").toUpperCase();
  return s.length === 3 ? "K" + s : s;
}

function haversineNm(a, b) {
  const R = 3440.065, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------------- "For" column ---------------- */

const CLASS_OF = {
  JET: ["jet"], J: ["jet"], TP: ["turboprop"], PN: ["piston"], PROP: ["turboprop", "piston"],
};

/**
 * "DCA+" → {airports:["KDCA"], plus:true}; "EWR SATS" → satsOnly;
 * "PHL N SAT" → satsOnly + dir N; "ISP E" → satsOnly + dir E;
 * "N90" / "CAPE APs" → area around the listed airports.
 */
export function parseFor(forStr, qualifier = "") {
  const s = String(forStr || "").trim();
  const q = String(qualifier || "").toUpperCase().split(/\s+/).filter(Boolean);
  const out = { airports: [], plus: false, area: false, satsOnly: false, dir: null, classes: null, overflight: false };
  for (const part of q) {
    if (part === "O/F") { out.overflight = true; continue; }
    const cls = part.split("/").flatMap(p => CLASS_OF[p] || []);
    if (cls.length) out.classes = [...new Set([...(out.classes || []), ...cls])];
  }
  if (s === "N90") { out.airports = ["KJFK", "KLGA", "KEWR"]; out.plus = true; out.area = true; return out; }
  if (s === "CAPE APs") { out.airports = ["KHYA"]; out.plus = true; out.area = true; return out; }
  const m = s.match(/^([A-Z/]+?)(\+)?(?: (N|S|E))?(?: (SATS?))?$/);
  if (!m) return out;
  out.airports = m[1].split("/").map(icao);
  out.plus = !!m[2];
  if (m[3]) out.dir = m[3];
  if (m[4] || m[3]) { out.satsOnly = true; out.plus = true; }
  return out;
}

/**
 * Does `dest` fall under a parsed For? `geo.ll(icao)` → [lat, lon] | null;
 * `geo.primaries` = every airport named in the tables, so an airport that has
 * its own rows (KADW, KHEF) is never treated as another field's satellite;
 * `geo.satPrimaries` = airports listed with "+"/SATS, and a satellite belongs
 * to the nearest of those.
 * @returns {null | {how: "exact"|"satellite"}}
 */
export function destMatches(pf, dest, geo = {}) {
  const d = icao(dest);
  if (!d) return null;
  if (!pf.satsOnly && pf.airports.includes(d)) return { how: "exact" };
  if (!pf.plus || !geo.ll) return null;
  if (pf.airports.includes(d) && pf.satsOnly) return null;
  if (geo.primaries && geo.primaries.has(d) && !pf.airports.includes(d)) return null;
  const dll = geo.ll(d);
  if (!dll) return null;
  for (const p of pf.airports) {
    const pll = geo.ll(p);
    if (!pll || haversineNm(pll, dll) > SAT_RADIUS_NM) continue;
    if (pf.dir === "N" && !(dll[0] > pll[0])) continue;
    if (pf.dir === "S" && !(dll[0] < pll[0])) continue;
    if (pf.dir === "E" && !(dll[1] > pll[1])) continue;
    // Nearest primary wins (an EWR satellite is not also an LGA satellite).
    if (geo.satPrimaries) {
      const dist = haversineNm(pll, dll);
      let closer = false;
      for (const other of geo.satPrimaries) {
        if (other === p) continue;
        const oll = geo.ll(other);
        if (oll && haversineNm(oll, dll) < dist) { closer = true; break; }
      }
      if (closer) continue;
    }
    return { how: "satellite" };
  }
  return null;
}

/** Every airport named in the For column (destMatches' geo.primaries). */
export function primaryAirports(rows = ROWS) {
  const set = new Set();
  for (const r of rows) parseFor(r[1], r[2]).airports.forEach(a => set.add(a));
  return set;
}

/** Airports listed with "+" or SATS (destMatches' geo.satPrimaries). */
export function satellitePrimaries(rows = ROWS) {
  const set = new Set();
  for (const r of rows) {
    const pf = parseFor(r[1], r[2]);
    if (pf.plus && !pf.area) pf.airports.forEach(a => set.add(a));
  }
  return set;
}

/* ---------------- "Routing" column ---------------- */

/**
 * "[HBUDA/THHMP] RAVNN# / ESL TIKEE#" →
 * {alternatives: [[{any:["HBUDA","THHMP"]}, {star:"RAVNN"}], [...]], notes, any, altBand, exceptVia}
 */
export function parseRouting(routing) {
  let s = String(routing || "").trim();
  const notes = [];
  let any = false, altBand = null, exceptVia = null;

  s = s.replace(/\(([^)]*)\)/g, (_, inner) => {
    const t = inner.trim().toUpperCase();
    if (ANY_RE.test(t)) { any = true; return " "; }
    const ex = t.match(/^ANY EXCEPT VIA ([A-Z]+)$/);
    if (ex) { any = true; exceptVia = ex[1]; return " "; }
    notes.push(inner.trim());
    if (/^DIRECT/.test(t)) any = true;
    return " ";
  });

  s = s.replace(/\[([^\]]*)\]/g, (_, inner) => {
    const t = inner.trim().toUpperCase();
    if (ANY_RE.test(t)) { any = true; return " "; }
    const band = t.match(/^(\d{3})?(-|\+)(\d{3})?$/);
    if (band) {
      altBand = band[2] === "+" ? { min: +band[1] * 100, max: null }
        : { min: band[1] ? +band[1] * 100 : null, max: band[3] ? +band[3] * 100 : null };
      if (band[2] === "-" && band[1] && !band[3]) altBand = { min: null, max: +band[1] * 100 };
      notes.push(`Filed ${inner.trim()}`);
      return " ";
    }
    const fixes = t.split(/\s*\/\s*/);
    if (fixes.every(f => /^[A-Z]{3,5}$/.test(f)) && !fixes.some(f => /^Z[A-Z]{2}$/.test(f)) && t !== "NE" && t !== "SW" && t !== "S" && t !== "A2") {
      return ` ${fixes.join("/")} `;
    }
    notes.push(inner.trim());
    return " ";
  });

  const alternatives = s.split(/\s\/\s/).map(alt => alt.trim().split(/\s+/).filter(Boolean).map(tok => {
    const opts = tok.split("/").filter(Boolean).map(o => {
      if (o.endsWith("#")) return { star: o.slice(0, -1) };
      const rev = o.match(STAR_REV_RE);
      if (rev && /^[A-Z]{3,5}\d$/.test(o)) return { star: rev[1] };
      if (AIRWAY_RE.test(o)) return { airway: o };
      return { fix: o };
    });
    return opts;
  })).filter(a => a.length);

  return { alternatives, notes, any: any && !alternatives.length ? true : any, altBand, exceptVia };
}

/* ---------------- flight side ---------------- */

/**
 * Filed route → {tokens, stars (STAR base names), points (name → order, filed
 * tokens then `extraFixes` from route expansion), filed (filed tokens only)}.
 */
export function flightRoutePoints(route, extraFixes = []) {
  const raw = String(route || "").toUpperCase().replace(/[\n\r]/g, " ").split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const t of raw) {
    for (const part of t.split(".")) {
      const tok = part.split("/")[0].replace(/[^A-Z0-9]/g, "");
      if (tok && tok !== "DCT") tokens.push(tok);
    }
  }
  const stars = new Set();
  const points = new Map();
  tokens.forEach((t, i) => {
    const rev = t.match(STAR_REV_RE);
    if (rev) stars.add(rev[1]);
    if (!points.has(t)) points.set(t, i);
  });
  const filed = new Set(points.keys());
  let n = tokens.length;
  for (const f of extraFixes) {
    const k = String(f || "").toUpperCase();
    if (k && !points.has(k)) points.set(k, n++);
  }
  return { tokens, stars, points, filed };
}

/** "B738" / "H/B744/L" → "jet" | "turboprop" | "piston" | null. */
export function engineClass(type) {
  const parts = String(type || "").toUpperCase().split("/");
  const base = parts.length > 1 && /^[LMHJS]$/.test(parts[0]) ? parts[1] : parts[0];
  return AIRCRAFT_ENGINE[base] || null;
}

/** "35000" / "FL350" / "350" → feet, or null. */
export function cruiseFeet(alt) {
  const s = String(alt || "").toUpperCase().replace(/^FL/, "").replace(/[^0-9]/g, "");
  if (!s) return null;
  const n = +s;
  return n < 1000 ? n * 100 : n;
}

/* ---------------- restriction side ---------------- */

/** "J: BUBBI @ 150" / "AOB FL230 DSDG 210 (J)" → class limit from the restriction text. */
function restrictionClasses(restr) {
  const s = String(restr || "").toUpperCase();
  if (/^J:|\(J\)\s*$/.test(s)) return ["jet"];
  if (/^P:|\(P\)\s*$/.test(s)) return ["turboprop", "piston"];
  return null;
}

/** The crossing fix a restriction names ("BUBBI @ 150" → BUBBI), if any. */
export function restrictionFix(restr) {
  const s = String(restr || "").toUpperCase().replace(/^[JP]:\s*/, "");
  const m = s.match(/^(?:BDRY \()?(?:\d+\s*(?:NM)?\s*[NSEW]\s+)?([A-Z]{3,5})(?:\/[A-Z]{3,5})?\)?\s+(?:@|AOB|AT|ABEAM)/);
  if (!m || ["BDRY", "AOB", "DSDG", "ABEAM"].includes(m[1])) return null;
  return m[1];
}

/** Hide rows handed between two sectors one controller owns in this plan. */
export function rowVisibleInConfig(row, configKey) {
  const cfg = CONFIGS[configKey];
  if (!cfg || !cfg.groups) return true;
  const from = ownerOf(row[0], configKey), to = ownerOf(row[5], configKey);
  return !(to && from === to);
}

/** Owning sector of a sector in a plan ("54" in 3-way → "12"), or null for non-sectors. */
export function ownerOf(sector, configKey) {
  const s = /^\d$/.test(sector) ? "0" + sector : sector;
  if (!/^\d\d$/.test(s)) return null;
  const cfg = CONFIGS[configKey];
  if (!cfg || !cfg.groups) return s;
  for (const [owner, list] of Object.entries(cfg.groups)) if (list.includes(s)) return owner;
  return s;
}

/* ---------------- matching ---------------- */

const parsedCache = new WeakMap();
function parsedRow(row) {
  let p = parsedCache.get(row);
  if (!p) { p = { pf: parseFor(row[1], row[2]), rt: parseRouting(row[3]) }; parsedCache.set(row, p); }
  return p;
}

function scoreAlternative(alt, fp) {
  let matched = 0, filedHits = 0, starReq = 0, starOk = 0, starConflict = false, firstIdx = Infinity;
  for (const opts of alt) {
    let hit = false;
    for (const o of opts) {
      if (o.star) {
        if (fp.stars.has(o.star)) {
          hit = true;
          filedHits++;
          const i = fp.tokens.findIndex(t => (t.match(STAR_REV_RE) || [])[1] === o.star);
          if (i >= 0) firstIdx = Math.min(firstIdx, i);
        }
      } else {
        const k = o.fix || o.airway;
        if (fp.points.has(k)) {
          hit = true;
          if (fp.filed.has(k)) filedHits++;
          firstIdx = Math.min(firstIdx, fp.points.get(k));
        }
      }
      if (hit) break;
    }
    const isStar = opts.some(o => o.star);
    if (isStar) { starReq++; if (hit) starOk++; }
    if (hit) matched++;
  }
  // A different STAR filed into the same field rules the row out.
  if (starReq && !starOk && fp.stars.size) starConflict = true;
  return { matched, filedHits, total: alt.length, starReq, starOk, starConflict, firstIdx };
}

/**
 * All restriction rows that apply to one flight.
 * @param {{callsign, dep, arr, route, type, altitude}} flight
 * @param {{ll, primaries, satPrimaries, config, extraFixes, rows}} ctx
 * @returns {Array<{row, index, quality:"full"|"partial", how, notes:string[], typeUnknown:boolean, order:number, fix:string|null}>}
 */
export function matchFlight(flight, ctx = {}) {
  const rows = ctx.rows || ROWS;
  const fp = flightRoutePoints(flight.route, ctx.extraFixes || []);
  const cls = engineClass(flight.type);
  const cruise = cruiseFeet(flight.altitude);
  const geo = { ll: ctx.ll, primaries: ctx.primaries, satPrimaries: ctx.satPrimaries };
  const out = [];

  // Pass 1: rows whose destination, aircraft class and altitude band fit.
  const cands = [];
  rows.forEach((row, index) => {
    if (ctx.config && !rowVisibleInConfig(row, ctx.config)) return;
    const { pf, rt } = parsedRow(row);
    let how = "exact";
    if (!pf.overflight) {
      const dm = destMatches(pf, flight.arr, geo);
      if (!dm) return;
      how = dm.how;
    }
    const classes = restrictionClasses(row[4]) || pf.classes;
    let typeUnknown = false;
    if (classes) {
      if (cls && !classes.includes(cls)) return;
      if (!cls) typeUnknown = true;
    }
    if (rt.altBand && cruise != null) {
      if (rt.altBand.min != null && cruise < rt.altBand.min) return;
      if (rt.altBand.max != null && cruise > rt.altBand.max) return;
    }
    if (rt.exceptVia && fp.points.has(rt.exceptVia)) return;
    cands.push({ row, index, pf, rt, how, typeUnknown });
  });

  // Pass 2: route fit. A partial match must hit at least one of the fixes that
  // set its routing apart from the other rows on the same STAR (OXMAN vs WOZEE
  // into LINNG#), so a shared STAR alone never pulls in a sibling routing.
  const starAlts = [];
  for (const c of cands) for (const alt of c.rt.alternatives) {
    const stars = alt.flat().filter(o => o.star).map(o => o.star);
    if (stars.length) starAlts.push({ c, alt, stars });
  }
  const names = opts => opts.map(o => o.star || o.fix || o.airway);
  const hasAny = (alt, list) => alt.some(g => names(g).some(n => list.includes(n)));

  for (const c of cands) {
    const { row, index, pf, rt, how, typeUnknown } = c;
    let quality = null, order = Infinity;
    if (!rt.alternatives.length) {
      if (pf.overflight) continue;
      quality = "full";
      order = fp.tokens.length;
    } else {
      let best = null;
      for (const alt of rt.alternatives) {
        const sc = scoreAlternative(alt, fp);
        if (sc.starConflict) continue;
        const ratio = sc.matched / sc.total;
        // A partial match needs at least one hit on the route as filed, not
        // only on fixes picked up by expanding its airways and STAR.
        let q = sc.matched === sc.total ? "full" : sc.filedHits > 0 && ratio >= 0.5 ? "partial" : null;
        if (q === "partial") {
          const stars = alt.flat().filter(o => o.star).map(o => o.star);
          const sibs = stars.length ? starAlts.filter(s => s.alt !== alt && s.stars.some(x => stars.includes(x))) : [];
          if (sibs.length) {
            const distinct = alt.filter(g => !sibs.every(s => hasAny(s.alt, names(g))));
            if (distinct.length && !distinct.some(g => names(g).some(n => fp.points.has(n) || fp.stars.has(n)))) q = null;
          }
        }
        if (!q) continue;
        if (!best || (q === "full" && best.q !== "full") || (q === best.q && ratio > best.ratio)) {
          best = { q, ratio, idx: sc.firstIdx };
        }
      }
      if (!best) continue;
      if (pf.overflight && best.q !== "full") continue;
      quality = best.q;
      order = best.idx;
    }
    const fix = restrictionFix(row[4]);
    if (fix && fp.points.has(fix)) order = Math.max(order, fp.points.get(fix));
    out.push({ row, index, quality, how, notes: [...rt.notes], typeUnknown, order, fix });
  }

  out.sort((a, b) => (a.order - b.order) || (a.quality === b.quality ? 0 : a.quality === "full" ? -1 : 1) || a.index - b.index);
  return out;
}

/** Descend-via bottom altitude rows (Ch 5 Sec 2) for the STAR the flight filed. */
export function descendViaFor(flight) {
  const fp = flightRoutePoints(flight.route);
  const arr = icao(flight.arr);
  return DESCEND_VIA.filter(d => {
    if (d.apt !== arr || !fp.stars.has(d.star)) return false;
    if (!d.via) return true;
    const vias = d.via.split("/");
    const hasAnyVia = DESCEND_VIA.some(o => o !== d && o.apt === d.apt && o.star === d.star);
    if (!hasAnyVia) return true;
    return vias.some(v => fp.points.has(v));
  });
}
