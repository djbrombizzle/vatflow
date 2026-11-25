// ACL Route field (ERAM TI 6110.101 3.x, Figure 3-21): the route in ERAM dotted form, the remarks
// indicator and remarks text, and Flight Ineligible for Route (FIFR) coding. Pure text helpers; the page
// (vusalink/edst/index.html) does the HTML. Tests: node scripts/test-edst-acl-route.mjs

import { eramRoute } from "./edst-plans.js";

/** ERAM shows US airports by their 3-letter id: KRDU -> RDU. */
export function shortApt(id) {
  const s = String(id || "").trim().toUpperCase();
  return /^K[A-Z]{3}$/.test(s) ? s.slice(1) : s;
}

/**
 * The ACL route: "RDU..ROA..EKN..IHD.NEST03.PIT".
 * body: the route between the airports (spaces or dots). direct: the route was amended to start at the
 * aircraft's present position (a direct-to), shown ERAM style as "DEP./.FIX..".
 */
export function aclRouteText({ dep, body, arr, direct } = {}) {
  const d = shortApt(dep), a = shortApt(arr);
  let b = String(body || "").trim().toUpperCase();
  // The route may still carry the airports (manual strips, raw routes).
  const t = b.split(/[\s.]+/).filter(Boolean);
  if (dep && t[0] === String(dep).toUpperCase()) t.shift();
  if (arr && t[t.length - 1] === String(arr).toUpperCase()) t.pop();
  b = t.join(" ");
  if (direct) {
    const rest = eramRoute([b, a].filter(Boolean).join(" "));
    return (d ? d + "./." : "./.") + rest;
  }
  return eramRoute([d, b, a].filter(Boolean).join(" "));
}

/** FAA equipment suffix from a type like "B739/L" or "H/B744/L" ('' when there is none). */
export function equipSuffix(type) {
  const m = String(type || "").trim().toUpperCase().match(/\/([A-Z])$/);
  if (!m) return "";
  // "H/B744" has a wake prefix, not a suffix.
  return /^[A-Z]\/[A-Z0-9]{2,4}$/.test(String(type).trim().toUpperCase()) ? "" : m[1];
}

// FAA suffixes (AIM Table 5-1-3): RNAV capable (with or without GNSS), and GNSS capable.
const RNAV = new Set(["G", "L", "Z", "I", "C", "Y", "V", "S"]);
const GNSS = new Set(["G", "L", "V", "S"]);

/**
 * Flight Ineligible for Route: the route uses RNAV airways the equipment can't fly.
 * Q and Y routes need RNAV, T routes need GNSS. Returns null when eligible, else
 * {qual: suffix or "-", need: "RNAV" | "GNSS", airway}.
 */
export function fifrCheck(route, type) {
  const toks = String(route || "").toUpperCase().split(/[\s.]+/).filter(Boolean);
  const q = equipSuffix(type);
  for (const x of toks) {
    let need = null;
    if (/^[QY]\d{1,3}$/.test(x)) need = "RNAV";
    else if (/^T\d{1,3}$/.test(x)) need = "GNSS";
    if (!need) continue;
    const ok = need === "RNAV" ? RNAV.has(q) : GNSS.has(q);
    if (!ok) return { qual: q || "-", need, airway: x };
  }
  return null;
}

const NOISE = new Set(["TCAS", "SIMBRIEF", "SBRIEF"]);
function clean(s) {
  return String(s || "").replace(/\/[VRT]\//g, " ")
    .split(/\s+/).filter((x) => x && !NOISE.has(x)).join(" ").trim();
}

/**
 * Remarks for the ACL: {sts, rmk}. An ICAO item 18 string ("PBN/A1B1 DOF/251125 STS/MEDEVAC RMK/HEART PATIENT")
 * gives STS/ (ICAO Reason for Special Handling) and RMK/; a plain string is all remarks. Voice tags (/V/) and
 * TCAS / SIMBRIEF are dropped: they're on most VATSIM plans and aren't remarks for the controller.
 */
export function remarksOf(text) {
  const s = String(text || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s) return { sts: "", rmk: "" };
  const tagRe = /(?:^|\s)([A-Z]{3,4})\/(?!\/)/g;
  const tags = [];
  let m;
  while ((m = tagRe.exec(s))) {
    if (/^(?:STS|RMK|PBN|NAV|COM|DAT|SUR|DEP|DEST|DOF|REG|EET|SEL|TYP|CODE|DLE|OPR|ORGN|PER|ALTN|RALT|TALT|RIF|RVR|EUR)$/.test(m[1]))
      tags.push({ k: m[1], at: m.index + m[0].length - m[1].length - 1 });
  }
  if (!tags.length) return { sts: "", rmk: clean(s) };
  const val = (k) => tags.map((t, i) => (t.k !== k ? "" : s.slice(t.at + k.length + 1, i + 1 < tags.length ? tags[i + 1].at : s.length)))
    .filter(Boolean).join(" ");
  // Text before the first tag (e.g. "/V/ ...") counts as remarks too.
  const lead = s.slice(0, tags[0].at);
  return { sts: clean(val("STS")), rmk: clean([lead, val("RMK")].join(" ")) };
}

/** Short stable key for "this remark has been viewed". */
export function remarksKey(r) {
  return r && (r.sts || r.rmk) ? (r.sts + "|" + r.rmk) : "";
}

/**
 * Route Menu keyboard input: typed text goes in front of the current route (ERAM inserts keyboard input at the
 * beginning of the field). value: the field; def: the current route it started with. When the typed part ends
 * at a fix of the current route, the route continues from there: "ILM..XYZ..LDN" + "ILM..FAK..LDN.J134.FLM"
 * -> "ILM XYZ LDN J134 FLM". A field edited anywhere else is taken as the whole new route.
 * Returns the new route with spaces, or '' when nothing changed.
 */
export function mergeTypedRoute(value, def) {
  const v = String(value || "").toUpperCase().trim(), d = String(def || "").toUpperCase().trim();
  if (!v || v === d) return "";
  const tok = (s) => s.split(/[\s.]+/).filter(Boolean);
  if (d && v.endsWith(d) && v.length > d.length) {
    const typed = tok(v.slice(0, v.length - d.length));
    const base = tok(d);
    const last = typed[typed.length - 1];
    const i = base.indexOf(last);
    return (i >= 0 ? [...typed, ...base.slice(i + 1)] : [...typed, ...base]).join(" ");
  }
  return tok(v).join(" ");
}

/**
 * The ATC intended route box: ERAM dotted route split into parts so the page can underline, in coral, the airways
 * the flight's equipment can't fly. [{sep: '' | '.' | '..', tok, bad}]
 */
export function intendedRouteParts(route, type) {
  const text = eramRoute(String(route || ""));
  const parts = [];
  for (const m of text.matchAll(/(\.{0,2})([^.]+)/g)) {
    const tok = m[2];
    parts.push({ sep: m[1], tok, bad: !!fifrCheck(tok, type) });
  }
  return parts;
}
