// ATC Preferred Routes (APR) for the EDST Route Menu (ERAM TI 6110.101 3.2.1.2, Figures 3-26 / 3-27), from the
// FAA National Preferred Routes database (data/prd/to-<DEST>.json, built by scripts/build-prd-data.mjs).
// ERAM's APRs are facility-adapted; the FAA preferred routes are the closest public data.
// "All": routes to the flight's destination that it can join (they start at its departure airport or at a fix
// still ahead on its route). "Eligible": the ones that also pass the altitude, aircraft class, equipment and
// hours checks. Tests: node scripts/test-edst-apr.mjs

import { AIRCRAFT_ENGINE } from "./mit-monitor.js";
import { equipSuffix, shortApt } from "./edst-acl-route.js";

const RNAV = new Set(["G", "L", "Z", "I", "C", "Y", "V", "S"]);

/** "jet" | "turboprop" | "piston" | null, from a type like "B738/L" or "H/B744/L". */
function flightClass(type) {
  const p = String(type || "").toUpperCase().split("/");
  const base = p.length > 1 && /^[LMHJS]$/.test(p[0]) ? p[1] : p[0];
  return AIRCRAFT_ENGINE[base] || null;
}

/** "FL240" / "240" / "10000" / "050" -> hundreds of feet. */
function hundreds(s) {
  const n = parseInt(String(s).replace(/^FL/, ""), 10);
  if (!Number.isFinite(n)) return null;
  return n >= 1000 ? Math.round(n / 100) : n;
}

/**
 * The Altitude column -> {min, max} (hundreds of feet, either may be null), {classes: {J: 100, M: 80, ...}}
 * for the TEC aircraft class codes (J jet, M turboprop / special, P non-jet 190 kt or more, Q non-jet under
 * 190 kt), or null when it says nothing we can check.
 */
export function parseAltitude(text) {
  const s = String(text || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^(?:[JMPQ]+\d{2,3})+$/.test(s) || /^[JMPQ]+(?:\d{2,3}[JMPQ]+)*\d{2,3}$/.test(s)) {
    const classes = {};
    let pend = [];
    for (const m of s.matchAll(/([JMPQ])|(\d{2,3})/g)) {
      if (m[1]) pend.push(m[1]);
      else { pend.forEach((c) => { classes[c] = +m[2]; }); pend = []; }
    }
    return { classes };
  }
  const num = "(FL ?\\d{2,3}|\\d{2,5})";
  let m;
  if ((m = s.match(new RegExp(`^${num} ?(?:-|TO) ?${num}`)))) return { min: hundreds(m[1].replace(" ", "")), max: hundreds(m[2].replace(" ", "")) };
  if ((m = s.match(new RegExp(`^(?:AOA|AT OR ABOVE) ${num}$`))) || (m = s.match(new RegExp(`^${num} AND ABOVE$`))))
    return { min: hundreds(m[1].replace(" ", "")), max: null };
  if ((m = s.match(new RegExp(`^(?:AOB|AT OR BELOW) ${num}$`))) || (m = s.match(new RegExp(`^${num} AND BELOW$`))))
    return { min: null, max: hundreds(m[1].replace(" ", "")) };
  if ((m = s.match(new RegExp(`^${num}(?: ?(?:OR|/) ?${num})*$`)))) {
    const all = [...s.matchAll(/FL ?\d{2,3}|\d{2,5}/g)].map((x) => hundreds(x[0].replace(" ", "")));
    return { min: null, max: Math.max(...all) };
  }
  return null;
}

/** TEC class letter for a flight: J, M, P, Q, or null (unknown). */
export function tecClass(type, tas) {
  const c = flightClass(type);
  if (c === "jet") return "J";
  if (c === "turboprop") return "M";
  if (c === "piston") return tas >= 190 ? "P" : "Q";
  return null;
}

function inHours(hours, now) {
  const spans = String(hours || "").match(/\d{4}-\d{4}/g);
  if (!spans) return true;
  const d = new Date(now), t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return spans.some((sp) => {
    const [a, b] = sp.split("-").map((x) => (+x.slice(0, 2)) * 60 + (+x.slice(2)));
    return a <= b ? t >= a && t <= b : t >= a || t <= b;
  });
}

/**
 * Why a route doesn't fit the flight ([] = eligible).
 * flight: {type, tas, alt (hundreds of feet: requested or assigned)}
 */
export function aprProblems(row, flight, now = Date.now()) {
  const [, , type, altText, acft, hours] = row;
  const out = [];
  const alt = flight.alt || 0;
  const cls = flightClass(flight.type);
  const pa = parseAltitude(altText);
  if (pa && pa.classes) {
    const k = tecClass(flight.type, flight.tas || 0);
    if (k && pa.classes[k] == null) out.push("AIRCRAFT CLASS");
    else if (k && alt && alt > pa.classes[k]) out.push("ALTITUDE");
  } else if (pa && alt) {
    if ((pa.min != null && alt < pa.min) || (pa.max != null && alt > pa.max)) out.push("ALTITUDE");
  } else if (alt) {
    if ((type === "H" || type === "SHD" || type === "HPD") && alt < 180) out.push("ALTITUDE");
    if ((type === "L" || type === "SLD" || type === "TEC") && alt >= 180) out.push("ALTITUDE");
  }
  const a = String(acft || "");
  if (/RNAV|GPS|DME\/DME/.test(a) && !RNAV.has(equipSuffix(flight.type))) out.push("EQUIPMENT");
  if (/NON[- ]?JET|PROP|PISTON|SINGLE ENGINE/.test(a)) { if (cls === "jet") out.push("AIRCRAFT CLASS"); }
  else if (/JET/.test(a) && cls && cls !== "jet") out.push("AIRCRAFT CLASS");
  if (!inHours(hours, now)) out.push("TIME");
  return out;
}

/**
 * The APR list for a flight.
 * f: {dep, arr, type, tas, alt, airborne, ahead: [fix names still ahead, nearest first]}
 * rows: data/prd/to-<shortApt(arr)>.json
 * Returns [{route, orig, type, dir, area, eligible, problems, key}], eligible first, then in order of join point.
 */
export function aprList(f, rows, now = Date.now()) {
  const dep = shortApt(f.dep), depIcao = String(f.dep || "").toUpperCase();
  const ahead = (f.ahead || []).map((x) => String(x).toUpperCase());
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const [orig, route, type, , , , dir, area, seq] = row;
    let join;
    if (!f.airborne && (orig === dep || orig === depIcao)) join = -1;
    else {
      join = ahead.indexOf(orig);
      if (join < 0) continue;
    }
    if (seen.has(route)) continue;
    seen.add(route);
    const problems = aprProblems(row, f, now);
    out.push({ route, orig, type, dir, area, seq, join, eligible: !problems.length, problems });
  }
  const pref = (f.alt || 0) >= 180 ? ["H", "SHD", "HPD", "NAR"] : ["TEC", "L", "SLD", "H"];
  const rank = (t) => { const i = pref.indexOf(t); return i < 0 ? 9 : i; };
  out.sort((a, b) => (b.eligible - a.eligible) || (a.join - b.join) || (rank(a.type) - rank(b.type)) || (a.seq - b.seq));
  return out;
}

/** ERAM form of an APR: "LDN.J134.FLM..DQN.MIZAR3.DTW" (the route as listed, airports in 3 letters). */
export function aprText(route) {
  const t = String(route || "").split(/\s+/).filter(Boolean);
  const path = (x) => /^[A-Z]{1,2}\d{1,4}$/.test(x) || /^[A-Z]{3,6}\d{1,2}[A-Z]?$/.test(x);
  return t.map((x, i) => (i === 0 ? x : ((path(x) || path(t[i - 1])) ? "." : "..") + x)).join("");
}

/**
 * The flight's new route with an APR applied: what is flown before the APR's start, then the APR, ending at the
 * filed destination. base: the route being replaced (spaces or dots, without the airports or with them).
 */
export function applyApr(base, apr, dep, arr) {
  const depI = String(dep || "").toUpperCase(), arrI = String(arr || "").toUpperCase();
  const toks = String(base || "").toUpperCase().split(/[\s.]+/).filter(Boolean);
  const at = String(apr.route || "").toUpperCase().split(/\s+/).filter(Boolean);
  if (!at.length) return toks.join(" ");
  const orig = at[0];
  let head = [];
  if (orig === shortApt(depI) || orig === depI) head = depI ? [depI] : [];
  else {
    const i = toks.indexOf(orig);
    head = i >= 0 ? toks.slice(0, i) : toks.filter((x) => x === depI);
  }
  const tail = at.slice(head.length && (orig === shortApt(depI) || orig === depI) ? 1 : 0);
  if (tail.length && (tail[tail.length - 1] === shortApt(arrI) || tail[tail.length - 1] === arrI)) tail[tail.length - 1] = arrI;
  else if (arrI) tail.push(arrI);
  return [...head, ...tail].join(" ");
}
