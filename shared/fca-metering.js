/**
 * Shared FCA metering — geometry, ETA engine, and sequencing (FCA Builder + Tower Departures).
 *
 * v2 clean slate. Core rules:
 *  - Inclusion: filed route (expanded via route-engine when nav data is loaded) must cross the FCA line.
 *  - ETAs come from a climb-profile model, never raw taxi groundspeed:
 *      250 kt below 10,000 ft, 290 kt from 10,000 to filed cruise, filed TAS at cruise,
 *      with winds aloft (AWC FB tables) applied to the cruise segment when available.
 *  - Airborne aircraft are FIXED constraints ordered by ETA. They are never delayed by the tool.
 *    If two airborne aircraft violate the constraint between themselves, they are flagged
 *    (`conflict`) for the controller — the timeline is not rewritten to pretend they'll comply.
 *  - Ground aircraft slot into real gaps between committed crossings. Air always wins.
 *  - "Ready now" releases: markReady() freezes an EDCT/CTA into fca.releases (synced with the FCA
 *    object). Non-ready ground traffic is advisory only and holds no slot, so a ready aircraft
 *    naturally claims any slot an unready one was projected into.
 *  - Frozen releases only move if the pilot misses the CFR window (-2/+1 min) or an airborne
 *    aircraft newly encroaches (bumped later, never earlier).
 */
import {
  bindAirports as bindRouteAirports,
  buildRoutePathLLs,
  isNavReady,
} from "./route-engine.js";
import { routeHeadwind, effectiveGs } from "./winds-aloft.js";
import { pointInArtcc } from "./artcc-scope.js";

bindRouteAirports(
  icao => getAirport(icao),
  icao => hasAirport(icao),
);

export const NM_PER_DEG = 60;
export const LOOKAHEAD_NM = 2500;
/** Per-FCA route lookahead (nm). */
export function fcaLookaheadNm(fca) {
  const v = fca && parseFloat(fca.lookaheadNm);
  return (isFinite(v) && v > 50) ? v : LOOKAHEAD_NM;
}
export const DEMAND_WINDOW_MIN = 60;
export const DIR_LABEL = { any: "any dir", N: "NB", S: "SB", E: "EB", W: "WB" };

/* ---- operational constants ---- */
/** Legacy fallback groundspeed (kept for exports/back-compat only). */
export const DEFAULT_GROUND_GS = 250;
/** Minutes from "release issued" to realistic wheels-up. */
export const READY_BUFFER_SEC = 180;
/** CFR release window: -2/+1 minutes. Past +1 still on the ground = stale, recompute. */
export const COMPLIANCE_EARLY_MS = 2 * 60000;
export const COMPLIANCE_LATE_MS = 1 * 60000;
/** Climb profile. */
export const SPD_BELOW_10K = 250;      // kt below 10,000 ft
export const SPD_CLIMB = 290;          // kt from 10,000 ft to cruise
export const CLIMB_FPM_LOW = 2000;     // fpm below 10,000 ft
export const CLIMB_FPM_HIGH = 1500;    // fpm 10,000 ft -> cruise
/** Groundspeed threshold separating taxi from flight. */
export const AIR_MIN_GS = 50;
/** Encroachment tolerance before a frozen release is bumped (sec). */
const FREEZE_TOL_SEC = 30;

const AIRPORTS = new Map();
let airportsReady = false;

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

/* ============================================================
   AIRPORT DATABASE
   ============================================================ */
export function getAirport(icao) {
  if (!icao) return null;
  return AIRPORTS.get(("" + icao).toUpperCase()) || null;
}
export function hasAirport(icao) {
  return AIRPORTS.has(("" + icao).toUpperCase());
}
export function isAirportsReady() { return airportsReady; }
export function seedAirports(map) {
  if (!map) return;
  Object.entries(map).forEach(([k, v]) => AIRPORTS.set(k, v));
}

export function loadAirports(onReady) {
  const url = "https://cdn.jsdelivr.net/gh/vatsimnetwork/vatspy-data-project@master/VATSpy.dat";
  return fetch(url)
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(txt => {
      let inApt = false, n = 0;
      txt.split(/\r?\n/).forEach(line => {
        if (line.startsWith("[")) { inApt = /\[Airports\]/i.test(line); return; }
        if (!inApt || !line || line.startsWith(";")) return;
        const c = line.split("|");
        if (c.length >= 4) {
          const ic = c[0].trim().toUpperCase(), la = parseFloat(c[2]), lo = parseFloat(c[3]);
          if (ic && !isNaN(la) && !isNaN(lo)) { AIRPORTS.set(ic, [la, lo]); n++; }
        }
      });
      airportsReady = true;
      if (onReady) onReady(n);
      return n;
    });
}

/* ============================================================
   GEOMETRY
   ============================================================ */
export function haversineNm(la1, lo1, la2, lo2) {
  const R = 3440.065, dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(la1, lo1, la2, lo2) {
  const y = Math.sin(toRad(lo2 - lo1)) * Math.cos(toRad(la2));
  const x = Math.cos(toRad(la1)) * Math.sin(toRad(la2)) - Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(toRad(lo2 - lo1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function gcLine(a, b) {
  const lat1 = toRad(a[0]), lon1 = toRad(a[1]), lat2 = toRad(b[0]), lon2 = toRad(b[1]);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (!isFinite(d) || d === 0) return [a.slice(), b.slice()];
  const n = Math.max(2, Math.min(48, Math.round(haversineNm(a[0], a[1], b[0], b[1]) / 120)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, S = Math.sin(d), Aa = Math.sin((1 - f) * d) / S, Bb = Math.sin(f * d) / S;
    const x = Aa * Math.cos(lat1) * Math.cos(lon1) + Bb * Math.cos(lat2) * Math.cos(lon2);
    const y = Aa * Math.cos(lat1) * Math.sin(lon1) + Bb * Math.cos(lat2) * Math.sin(lon2);
    const z = Aa * Math.sin(lat1) + Bb * Math.sin(lat2);
    out.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return out;
}

function toLocal(lat, lon, lat0, lon0) {
  return [(lon - lon0) * NM_PER_DEG * Math.cos(toRad(lat0)), (lat - lat0) * NM_PER_DEG];
}
function localToLatLon(x, y, lat0, lon0) {
  return [lat0 + y / NM_PER_DEG, lon0 + x / (NM_PER_DEG * Math.cos(toRad(lat0)))];
}

/* ============================================================
   FLIGHT-PLAN PARSING / FORMATTING
   ============================================================ */
export function parseRouteTokens(route) {
  if (!route) return [];
  return route.toUpperCase().replace(/[\n\r]/g, " ").split(/\s+/).filter(Boolean).filter(t => t !== "DCT");
}

export function parseAlt(a) {
  if (a == null) return 0;
  a = ("" + a).toUpperCase().replace(/\s|FL/g, "");
  const n = parseInt(a, 10);
  if (isNaN(n)) return 0;
  return n < 1000 ? n * 100 : n;
}

export function ptimeToMs(dep) {
  if (!dep) return null;
  dep = ("" + dep).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  const h = +dep.slice(0, 2), m = +dep.slice(2, 4);
  if (isNaN(h) || isNaN(m) || h > 23 || m > 59) return null;
  const now = new Date(), nowMs = now.getTime();
  let ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0);
  if (ms - nowMs > 12 * 36e5) ms -= 864e5;
  else if (nowMs - ms > 12 * 36e5) ms += 864e5;
  return ms;
}

export function fmtZulu(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}

export function fmtPtime(deptime) {
  if (!deptime) return "—";
  const s = ("" + deptime).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  if (s.length !== 4) return "—";
  const h = +s.slice(0, 2), m = +s.slice(2, 4);
  if (h > 23 || m > 59) return "—";
  return s + "Z";
}

export function fpFields(fp) {
  fp = fp || {};
  return {
    dep: (fp.departure || "").toUpperCase(),
    arr: (fp.arrival || "").toUpperCase(),
    type: fp.aircraft_short || fp.aircraft_faa || "",
    tas: parseInt(fp.cruise_tas, 10) || 0,
    fpAlt: parseAlt(fp.altitude),
    deptime: fp.deptime || "",
    route: fp.route || "",
  };
}

/* ============================================================
   FCA FILTERS
   ============================================================ */
export function fcaMatchesAlt(fca, alt) {
  const min = (fca.minFL != null) ? fca.minFL * 100 : -1;
  const max = (fca.maxFL != null) ? fca.maxFL * 100 : 1e9;
  return alt >= min && alt <= max;
}
/** ICAO/IATA-tolerant airport code comparison: "MIA" matches "KMIA" and vice versa. */
export function airportCodesMatch(a, b) {
  a = (a || "").toUpperCase().trim();
  b = (b || "").toUpperCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 4 && b.length === 3 && a.slice(1) === b) return true;
  if (b.length === 4 && a.length === 3 && b.slice(1) === a) return true;
  return false;
}
export function fcaMatchesDest(fca, arr) {
  if (!fca.dests || !fca.dests.length) return true;
  return fca.dests.some(d => airportCodesMatch(d, arr));
}
export function fcaMatchesOrigin(fca, dep) {
  if (!fca.origins || !fca.origins.length) return true;
  return fca.origins.some(d => airportCodesMatch(d, dep));
}
/** ARTCC scope: the FCA applies only to aircraft physically inside one of the
 *  scoped centers (ground aircraft judged at their departure field). Fails
 *  OPEN when boundary data isn't loaded — missing map data must never hide
 *  traffic from a program. Blank scope = applies everywhere. */
export function fcaMatchesScope(fca, p) {
  if (!fca.scope || !fca.scope.length) return true;
  let lat = p.lat, lon = p.lon;
  if (lat == null || lon == null) {
    const ap = getAirport(p.dep);
    if (ap) { lat = ap[0]; lon = ap[1]; }
  }
  if (lat == null || lon == null) return true;
  let anyKnown = false;
  for (const id of fca.scope) {
    const r = pointInArtcc(id, lat, lon);
    if (r === true) return true;
    if (r !== null) anyKnown = true;
  }
  return anyKnown ? false : true;   // no boundary data at all -> fail open
}

/** Route-fix filter: meter only aircraft with one of these fixes in their FILED
 *  route. A token naming a procedure derived from the fix also matches
 *  (filter "LAIRI" catches a filed "LAIRI4" arrival). */
export function fcaMatchesFix(fca, route) {
  if (!fca.fixes || !fca.fixes.length) return true;
  const toks = parseRouteTokens(route).map(t => t.replace(/\/.*$/, ""));
  return fca.fixes.some(fx => {
    fx = ("" + fx).toUpperCase();
    return toks.some(t => t === fx || t.replace(/\d[A-Z]?$/, "") === fx);
  });
}
export function dirOfHeading(h) {
  h = ((h % 360) + 360) % 360;
  if (h >= 315 || h < 45) return "N";
  if (h < 135) return "E";
  if (h < 225) return "S";
  return "W";
}
export function fcaMatchesDir(_fca, _hdg) {
  return true;
}

function angleDiff(a, b) {
  return Math.abs(((a - b) + 540) % 360 - 180);
}

function flowBearing(fca) {
  const d = fca.dir || "any";
  if (d === "any") return null;
  return { N: 0, E: 90, S: 180, W: 270 }[d] ?? null;
}

/* ============================================================
   FCA LINE GEOMETRY
   ============================================================ */
function nearestPointOnFca(lat, lon, pts) {
  let best = null, bd = 1e9;
  for (let i = 0; i < pts.length - 1; i++) {
    const lat0 = pts[i][0], lon0 = pts[i][1];
    const A = toLocal(pts[i][0], pts[i][1], lat0, lon0);
    const B = toLocal(pts[i + 1][0], pts[i + 1][1], lat0, lon0);
    const P = toLocal(lat, lon, lat0, lon0);
    const abx = B[0] - A[0], aby = B[1] - A[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((P[0] - A[0]) * abx + (P[1] - A[1]) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = A[0] + t * abx, py = A[1] + t * aby;
    const distNm = Math.hypot(px - P[0], py - P[1]);
    if (distNm < bd) {
      bd = distNm;
      const ll = localToLatLon(px, py, lat0, lon0);
      best = { lat: ll[0], lon: ll[1], distNm };
    }
  }
  return best;
}

/** Perpendicular distance (nm) from a position to the FCA polyline. */
export function lineDistToFca(lat, lon, fca) {
  if (lat == null || lon == null || !fca?.points?.length) return null;
  const near = nearestPointOnFca(lat, lon, fca.points);
  return near ? near.distNm : null;
}

export function isCrossingAhead(p, cross) {
  if (!cross || cross.lat == null || p.lat == null || p.lon == null) return true;
  if (p.phase !== "air" || (p.gs || 0) < AIR_MIN_GS) return true;
  const hdg = p.hdg;
  if (hdg == null) return true;
  const brg = bearing(p.lat, p.lon, cross.lat, cross.lon);
  return angleDiff(hdg, brg) <= 95;
}

/** Aircraft already on the exit side of a directional FCA, moving away. */
export function hasPassedFca(p, fca) {
  if (p.phase !== "air" || (p.gs || 0) < AIR_MIN_GS) return false;
  const flow = flowBearing(fca);
  if (flow == null || !fca.points || fca.points.length < 2) return false;
  const near = nearestPointOnFca(p.lat, p.lon, fca.points);
  if (!near || near.distNm < 2) return false;
  const toAc = bearing(near.lat, near.lon, p.lat, p.lon);
  const onExitSide = angleDiff(toAc, flow) < 85;
  const headingExit = angleDiff(p.hdg || 0, flow) < 85;
  return onExitSide && headingExit;
}

export function projectCrossing(p, pts) {
  const lat0 = p.lat, lon0 = p.lon;
  const h = toRad(p.hdg || 0);
  const dir = [Math.sin(h), Math.cos(h)];
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = toLocal(pts[i][0], pts[i][1], lat0, lon0);
    const B = toLocal(pts[i + 1][0], pts[i + 1][1], lat0, lon0);
    const seg = [B[0] - A[0], B[1] - A[1]];
    const denom = dir[0] * seg[1] - dir[1] * seg[0];
    if (Math.abs(denom) < 1e-9) continue;
    const t = (A[0] * seg[1] - A[1] * seg[0]) / denom;
    const u = (A[0] * dir[1] - A[1] * dir[0]) / denom;
    if (t > 0 && u >= 0 && u <= 1) {
      if (!best || t < best.dist) {
        const px = dir[0] * t, py = dir[1] * t;
        const ll = localToLatLon(px, py, lat0, lon0);
        best = { dist: t, lat: ll[0], lon: ll[1] };
      }
    }
  }
  return (best && best.dist <= LOOKAHEAD_NM) ? best : null;
}

function segInt(P1, P2, A, B) {
  const r = [P2[0] - P1[0], P2[1] - P1[1]], s = [B[0] - A[0], B[1] - A[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const qp = [A[0] - P1[0], A[1] - P1[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { t, x: P1[0] + t * r[0], y: P1[1] + t * r[1] };
  return null;
}

export function buildPathLLs(anchors) {
  let path = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const seg = gcLine(anchors[i], anchors[i + 1]);
    if (i > 0) seg.shift();
    path = path.concat(seg);
  }
  return path;
}

export function pathCrossing(path, fca) {
  let cum = 0, best = null;
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k], b = path[k + 1];
    const legLen = haversineNm(a[0], a[1], b[0], b[1]);
    if (legLen < 0.01) continue;
    const legCourse = bearing(a[0], a[1], b[0], b[1]);
    const P2 = toLocal(b[0], b[1], a[0], a[1]);
    for (let i = 0; i < fca.points.length - 1; i++) {
      const A = toLocal(fca.points[i][0], fca.points[i][1], a[0], a[1]);
      const B = toLocal(fca.points[i + 1][0], fca.points[i + 1][1], a[0], a[1]);
      const x = segInt([0, 0], P2, A, B);
      if (x) {
        const dist = cum + x.t * legLen;
        if (!best || dist < best.dist) {
          const ll = localToLatLon(x.x, x.y, a[0], a[1]);
          best = { dist, lat: ll[0], lon: ll[1], course: legCourse };
        }
      }
    }
    cum += legLen;
  }
  return best;
}

export function plannedAnchors(p, origin, dst) {
  const anchors = [origin];
  parseRouteTokens(p.route).forEach(t => {
    const c = t.replace(/\/.*$/, "");
    if (c.length >= 3 && AIRPORTS.has(c) && c !== p.dep && c !== p.arr) anchors.push(AIRPORTS.get(c));
  });
  anchors.push(dst);
  return anchors;
}

function pilotOrigin(p) {
  if (p.lat != null && p.lon != null) return [p.lat, p.lon];
  const apt = getAirport(p.dep);
  return apt ? apt.slice() : null;
}

function routePathForCrossing(p, opts = {}) {
  const dst = opts.destination || getAirport(p.arr);
  if (!dst) return null;
  const airborne = opts.includeNow && p.lat != null && p.lon != null && p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS;

  if (isNavReady()) {
    // Never pass current position as `origin` — that labels it as the departure
    // anchor and the expansion backtracks through the entire filed route.
    // buildRoutePathLLs trims to a NOW anchor itself when includeNow is set.
    const pts = buildRoutePathLLs(p, { destination: dst, includeNow: airborne });
    if (pts.length >= 2) return buildPathLLs(pts);
  }
  const origin = opts.origin || (airborne ? [p.lat, p.lon] : pilotOrigin(p));
  if (!origin) return null;
  return buildPathLLs(plannedAnchors(p, origin, dst));
}

/** First crossing of the FCA along the filed route (remaining route when airborne). */
function findRouteCrossing(p, fca) {
  const airborne = p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS;
  const path = routePathForCrossing(p, { includeNow: airborne });
  if (!path || path.length < 2) return null;
  const best = pathCrossing(path, fca);
  if (!best || best.dist > fcaLookaheadNm(fca)) return null;
  return { ...best, path };
}

function validRouteCrossing(p, fca, cross) {
  if (!cross) return false;
  if (p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS) {
    return isCrossingAhead(p, cross) && !hasPassedFca(p, fca);
  }
  return true;
}

function validAirCrossing(p, fca, cross) {
  // A climbing departure's initial heading is runway/vector noise — its filed
  // route already turns it toward the crossing. Gating on heading here made
  // just-departed aircraft vanish from the sequence (west ops at ATL etc.),
  // collapsing the delays of everything queued behind them.
  if (isClimbingDeparture(p)) return !!cross;
  return validRouteCrossing(p, fca, cross);
}

/* ============================================================
   ETA ENGINE — climb profile + winds
   ============================================================ */
/** Filed TAS with a sane fallback estimated from cruise altitude. */
export function tasOrDefault(p) {
  const tas = parseInt(p.tas, 10) || 0;
  if (tas >= 60) return tas;
  const cruise = p.fpAlt || p.alt || 0;
  if (cruise >= 28000) return 440;
  if (cruise >= 15000) return 300;
  return 170;
}

/**
 * Seconds to cover distNm starting at fromAltFt, climbing to cruiseAltFt:
 * 250 kt below 10k (2000 fpm), 290 kt to cruise (1500 fpm), then filed TAS
 * corrected for the mean route headwind at cruise altitude.
 * Fails safe to still air when winds are unavailable.
 */
export function profileTransitSec(distNm, fromAltFt, cruiseAltFt, tasKt, path) {
  let remaining = Math.max(0, distNm);
  let alt = Math.max(0, fromAltFt || 0);
  const cruise = Math.max(alt, cruiseAltFt || 0);
  let hw = null;
  try { hw = path ? routeHeadwind(path, cruise) : null; } catch (_) { hw = null; }
  const cruiseGs = Math.max(120, effectiveGs(Math.max(120, tasKt || 0), hw));
  let t = 0;

  // Segment A — below 10,000 ft
  const topA = Math.min(10000, cruise);
  if (alt < topA) {
    const climbSec = ((topA - alt) / CLIMB_FPM_LOW) * 60;
    const gsA = SPD_BELOW_10K;
    const dA = gsA * climbSec / 3600;
    if (dA >= remaining) return t + (remaining / gsA) * 3600;
    t += climbSec; remaining -= dA; alt = topA;
  }

  // Segment B — 10,000 ft to cruise
  if (alt < cruise) {
    const climbSec = ((cruise - alt) / CLIMB_FPM_HIGH) * 60;
    const gsB = Math.max(150, effectiveGs(SPD_CLIMB, hw == null ? null : hw * 0.7));
    const dB = gsB * climbSec / 3600;
    if (dB >= remaining) return t + (remaining / gsB) * 3600;
    t += climbSec; remaining -= dB;
  }

  // Segment C — cruise
  return t + (remaining / cruiseGs) * 3600;
}

/** Predicted groundspeed at the FCA crossing (used for MIT->time conversion). */
function predictedCrossSpeed(p, path) {
  const cruise = p.fpAlt || p.alt || 0;
  let hw = null;
  try { hw = path ? routeHeadwind(path, cruise) : null; } catch (_) { hw = null; }
  return Math.max(120, effectiveGs(tasOrDefault(p), hw));
}

/** Legacy simple time = distance / speed. */
export function crossingEtaSec(distNm, gs) {
  const spd = gs > 0 ? gs : DEFAULT_GROUND_GS;
  return (distNm / spd) * 3600;
}
export function groundTransitSec(dist, gs) {
  return crossingEtaSec(dist, gs || DEFAULT_GROUND_GS);
}
/** No-op kept for old callers; winds are now imported directly. */
export function setWindAltProvider(_fn) {}

/** Is this airborne aircraft still in its departure climb? */
function isClimbingDeparture(p) {
  const cruise = p.fpAlt || 0;
  const arrApt = getAirport(p.arr);
  if (arrApt && p.lat != null && haversineNm(p.lat, p.lon, arrApt[0], arrApt[1]) < 120) return false; // descending near dest
  const depApt = getAirport(p.dep);
  if (depApt && p.lat != null) {
    const dDep = haversineNm(p.lat, p.lon, depApt[0], depApt[1]);
    if (dDep < 150 && (cruise === 0 || (p.alt || 0) < cruise - 2000)) return true;
  }
  if ((p.alt || 0) < 10000 && cruise > 12000) return true;
  return false;
}

/**
 * Estimate where/when a GROUND aircraft crosses the FCA along its filed route.
 * transitSec/etaSec = pure flight transit from wheels-up (no ready buffer, no deptime).
 */
export function groundCrossing(p, fca, _nowMs) {
  const cross = findRouteCrossing(p, fca);
  if (!cross || !validRouteCrossing(p, fca, cross)) return null;
  const transitSec = profileTransitSec(cross.dist, 0, p.fpAlt || 0, tasOrDefault(p), cross.path);
  const gs = transitSec > 0 ? (cross.dist / transitSec) * 3600 : DEFAULT_GROUND_GS; // avg speed, keeps eta = dist/gs identity
  return {
    dist: cross.dist,
    cross: { lat: cross.lat, lon: cross.lon },
    course: cross.course,
    gs,
    etaSec: transitSec,
    transitSec,
    crossSpd: predictedCrossSpeed(p, cross.path),
    origin: pilotOrigin(p),
  };
}

/** Tower: same route geometry — release-now, no filed departure time. */
export function towerGroundCrossing(p, fca, _nowMs) {
  return groundCrossing(p, fca, _nowMs);
}

function buildAirCandidate(p, fca) {
  const cross = findRouteCrossing(p, fca);
  if (!cross || !validAirCrossing(p, fca, cross)) return null;
  const dist = cross.dist; // along remaining route — not straight-line
  const cruise = p.fpAlt || p.alt || 0;
  let eta, crossSpd;
  if (isClimbingDeparture(p)) {
    eta = profileTransitSec(dist, p.alt || 0, cruise, tasOrDefault(p), cross.path);
    crossSpd = predictedCrossSpeed(p, cross.path);
  } else {
    const gs = Math.max(100, p.gs || 0);
    eta = (dist / gs) * 3600;
    crossSpd = gs;
  }
  return {
    p, phase: "air", dist,
    lineDist: lineDistToFca(p.lat, p.lon, fca),
    eta, cross: { lat: cross.lat, lon: cross.lon }, spd: p.gs || 0,
    crossSpd, transitSec: eta,
  };
}

/** Ground earliest wheels-up (sec from now). Ready = now + buffer; else honor a future filed deptime. */
function earliestOffSec(p, nowMs, ready) {
  if (ready) return READY_BUFFER_SEC;
  const dep = ptimeToMs(p.deptime);
  if (dep != null && dep > nowMs + READY_BUFFER_SEC * 1000) return (dep - nowMs) / 1000;
  return READY_BUFFER_SEC;
}

function buildGroundCandidate(p, fca, nowMs, ready) {
  const g = groundCrossing(p, fca, nowMs);
  if (!g) return null;
  const off = earliestOffSec(p, nowMs, ready);
  return {
    p, phase: "gnd", dist: g.dist,
    lineDist: lineDistToFca(p.lat, p.lon, fca),
    eta: off + g.transitSec,          // earliest possible crossing, sec from now
    offSec: off,
    cross: g.cross, spd: g.gs,
    crossSpd: g.crossSpd, transitSec: g.transitSec,
    ready: !!ready,
  };
}

/* ============================================================
   SEPARATION + SLOTTING
   ============================================================ */
/** Required time behind the previous crosser for candidate c, at the line. */
export function sepSeconds(fca, c) {
  if (fca.mode === "mit") {
    const mit = fca.mit || 0;
    const spd = (c && (c.crossSpd || c.spd)) || (c && c.p && c.p.gs) || DEFAULT_GROUND_GS;
    return mit > 0 ? (mit / Math.max(120, spd)) * 3600 : 0;
  }
  return (fca.mode === "rate" && fca.rate > 0) ? 3600 / fca.rate : 0;
}

/** Earliest t >= c.eta clear of every committed crossing by sep. */
function slotAgainstCommitted(c, committed, sep) {
  let t = c.eta;
  const EPS = 1e-6;
  const list = committed.slice().sort((a, b) => a - b);
  for (let guard = 0; guard < 1000; guard++) {
    let moved = false;
    for (const ct of list) {
      if (Math.abs(t - ct) < sep - EPS) { t = ct + sep; moved = true; }
    }
    if (!moved) break;
  }
  return t;
}

function isManualSeq(fca) {
  return fca.manualSeq === true && Array.isArray(fca.order) && fca.order.length > 0;
}

/* ============================================================
   RELEASES — "ready now" frozen EDCTs
   ============================================================ */
function releasesOf(fca) {
  if (!fca.releases || typeof fca.releases !== "object") fca.releases = {};
  return fca.releases;
}
export function getRelease(fca, callsign) {
  const r = fca && fca.releases;
  return (r && r[callsign]) || null;
}
export function isReady(fca, callsign) {
  return !!getRelease(fca, callsign);
}

/** Committed crossing times (sec from now): all airborne + all OTHER frozen releases. */
function committedTimes(fca, pilots, nowMs, exceptCallsign) {
  const times = collectAirFcaCandidates(fca, pilots).map(c => c.eta);
  const rel = fca.releases || {};
  for (const [cs, r] of Object.entries(rel)) {
    if (cs === exceptCallsign) continue;
    if (r && r.ctaMs != null) times.push((r.ctaMs - nowMs) / 1000);
  }
  return times;
}

/**
 * Mark a ground aircraft ready: compute earliest slot vs airborne + other frozen
 * releases (advisory traffic holds nothing) and freeze it into fca.releases.
 * Returns the release record or null if no crossing.
 */
export function markReady(fca, callsign, pilots, nowMs) {
  nowMs = nowMs != null ? nowMs : Date.now();
  const p = (pilots || []).find(x => x.callsign === callsign);
  if (!p) return null;
  const c = buildGroundCandidate(p, fca, nowMs, true);
  if (!c) return null;
  const sep = sepSeconds(fca, c);
  let slot;
  if (isManualSeq(fca)) {
    // Controller has set an explicit order — freeze this aircraft's slot IN that
    // order rather than greedily jumping it to the earliest global gap.
    const seq = computeSequence(fca, pilots, [], { includeEdct: true, nowMs });
    const item = seq.items.find(x => x.p && x.p.callsign === callsign && x.phase === "gnd");
    const floor = READY_BUFFER_SEC + c.transitSec;
    slot = item ? Math.max(item.sched, floor)
                : slotAgainstCommitted({ ...c, eta: floor }, committedTimes(fca, pilots, nowMs, callsign), sep);
  } else {
    slot = slotAgainstCommitted(c, committedTimes(fca, pilots, nowMs, callsign), sep);
  }
  const rel = {
    ctaMs: Math.round(nowMs + slot * 1000),
    edctMs: Math.round(nowMs + (slot - c.transitSec) * 1000),
    transitSec: Math.round(c.transitSec),
    assignedMs: nowMs,
  };
  releasesOf(fca)[callsign] = rel;
  return rel;
}

export function clearReady(fca, callsign) {
  if (fca && fca.releases && fca.releases[callsign]) {
    delete fca.releases[callsign];
    return true;
  }
  return false;
}

/**
 * Validate/refresh a frozen release for a still-on-ground candidate.
 * - Missed window (now > edct + 5 min): recompute from scratch (stays ready).
 * - Airborne encroachment: bump LATER to the next clear slot (never earlier).
 * Returns true if the release changed.
 */
function refreshRelease(fca, c, airTimes, nowMs) {
  const cs = c.p.callsign;
  const rel = getRelease(fca, cs);
  if (!rel) return false;
  const sep = sepSeconds(fca, c);
  let changed = false;

  if (nowMs > rel.edctMs + COMPLIANCE_LATE_MS) {
    // stale — pilot missed the window; re-slot as ready-now
    const fresh = { ...c, eta: READY_BUFFER_SEC + c.transitSec };
    const slot = slotAgainstCommitted(fresh, committedTimes(fca, [], nowMs, cs).concat(airTimes), sep);
    rel.ctaMs = Math.round(nowMs + slot * 1000);
    rel.edctMs = Math.round(rel.ctaMs - c.transitSec * 1000);
    rel.assignedMs = nowMs;
    changed = true;
  } else {
    // encroachment by airborne traffic — bump later only
    let t = (rel.ctaMs - nowMs) / 1000;
    const before = t;
    for (let guard = 0; guard < 1000; guard++) {
      let moved = false;
      for (const at of airTimes) {
        if (Math.abs(t - at) < sep - FREEZE_TOL_SEC) { t = at + sep; moved = true; }
      }
      if (!moved) break;
    }
    if (t > before + FREEZE_TOL_SEC) {
      rel.ctaMs = Math.round(nowMs + t * 1000);
      rel.edctMs = Math.round(rel.ctaMs - c.transitSec * 1000);
      changed = true;
    }
  }
  return changed;
}

/* ============================================================
   CANDIDATE COLLECTION
   ============================================================ */
export function isConnectedPilot(p) {
  return p && !p.prefile;
}

/** A ground aircraft is a departure candidate only if it is physically AT its
 *  filed departure airport. A landed arrival still carries the same flight
 *  plan and phase "gnd" — without this gate it gets re-metered as if it were
 *  about to fly the whole route again from the origin. */
export function isAtDepartureAirport(p) {
  if (p.lat == null || p.lon == null) return true;            // no position — can't judge
  const depApt = getAirport(p.dep);
  if (depApt) return haversineNm(p.lat, p.lon, depApt[0], depApt[1]) <= 10;
  const arrApt = getAirport(p.arr);
  if (arrApt) return haversineNm(p.lat, p.lon, arrApt[0], arrApt[1]) > 10;  // at minimum, not parked at the destination
  return true;
}

/**
 * Diagnostic: why is this aircraft in (or not in) this FCA's sequence?
 * Walks the same gates as candidate collection, in order, and reports the
 * first one that rejects. Returns { included, reason, detail, distNm? }.
 */
export function explainFcaExclusion(fca, p) {
  const R = (included, reason, detail, extra) => ({ included, reason, detail: detail || "", ...(extra || {}) });
  if (!fca || !fca.points || fca.points.length < 2) return R(false, "no-line", "FCA has no drawn line.");
  if (!fca.enabled) return R(false, "disabled", "FCA is disabled.");
  if ((fca.excluded || []).includes(p.callsign)) return R(false, "excluded", "Manually removed from this FCA.");
  if (!fcaMatchesDest(fca, p.arr)) {
    return R(false, "dest-filter", `Destination ${p.arr || "????"} not in filter [${(fca.dests || []).join(" ")}].`);
  }
  if (!fcaMatchesOrigin(fca, p.dep)) {
    return R(false, "origin-filter", `Departure ${p.dep || "????"} not in filter [${(fca.origins || []).join(" ")}].`);
  }
  if (!fcaMatchesFix(fca, p.route)) {
    return R(false, "fix-filter", `Filed route does not contain [${(fca.fixes || []).join(" ")}].`);
  }
  if (!fcaMatchesScope(fca, p)) {
    return R(false, "scope", `Aircraft is outside the FCA scope [${(fca.scope || []).join(" ")}].`);
  }
  const isAir = p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS;
  const altNow = p.alt || 0, altFp = p.fpAlt || 0;
  const altOk = isAir ? (fcaMatchesAlt(fca, altNow) || fcaMatchesAlt(fca, altFp)) : fcaMatchesAlt(fca, altFp);
  if (!altOk) {
    const band = `${fca.minFL != null ? "FL" + fca.minFL : "SFC"}–${fca.maxFL != null ? "FL" + fca.maxFL : "UNL"}`;
    return R(false, "alt-filter", `Current FL${Math.round(altNow / 100)} / filed FL${Math.round(altFp / 100)} outside ${band}.`);
  }
  if (p.phase === "gnd" && !isConnectedPilot(p)) return R(false, "prefile", "Prefiles are not metered.");
  if (p.phase === "gnd" && !isAtDepartureAirport(p)) {
    const depApt = getAirport(p.dep);
    const away = depApt && p.lat != null ? Math.round(haversineNm(p.lat, p.lon, depApt[0], depApt[1])) : null;
    return R(false, "arrived", `On the ground ${away != null ? away + "nm" : "far"} from filed departure ${p.dep || "????"} — flight has already operated.`);
  }
  if (!getAirport(p.arr)) return R(false, "no-dest-apt", `Destination ${p.arr || "????"} not in the airport DB — route can't be built.`);
  if (p.phase === "gnd" && !pilotOrigin(p)) return R(false, "no-origin", `Departure ${p.dep || "????"} not in the airport DB.`);
  const path = routePathForCrossing(p, { includeNow: isAir });
  if (!path || path.length < 2) return R(false, "no-path", "Route could not be resolved into a path.");
  const cross = pathCrossing(path, fca);
  if (!cross) return R(false, "no-crossing", "Resolved route never crosses the FCA line.");
  const cap = fcaLookaheadNm(fca);
  if (cross.dist > cap) {
    return R(false, "beyond-lookahead", `Crossing is ${Math.round(cross.dist)}nm along route — beyond the ${Math.round(cap)}nm lookahead.`, { distNm: cross.dist });
  }
  if (isAir && !isCrossingAhead(p, cross)) return R(false, "crossing-behind", "Crossing point is behind the aircraft's heading.");
  if (isAir && hasPassedFca(p, fca)) return R(false, "passed", "Already through the directional FCA, moving away.");
  return R(true, "included", `Crosses in ${Math.round(cross.dist)}nm.`, { distNm: cross.dist });
}

function collectAirFcaCandidates(fca, pilots) {
  const ex = new Set(fca.excluded || []);
  const cand = [];
  for (const p of pilots || []) {
    if (p.phase !== "air" || (p.gs || 0) < AIR_MIN_GS) continue;
    if (ex.has(p.callsign)) continue;
    if (!fcaMatchesDest(fca, p.arr)) continue;
    if (!fcaMatchesOrigin(fca, p.dep)) continue;
    if (!fcaMatchesFix(fca, p.route)) continue;
    if (!fcaMatchesScope(fca, p)) continue;
    if (!fcaMatchesAlt(fca, p.alt || 0) && !fcaMatchesAlt(fca, p.fpAlt || 0)) continue;
    const ac = buildAirCandidate(p, fca);
    if (ac) cand.push(ac);
  }
  return cand;
}

function collectGroundFcaCandidates(fca, pilots, nowMs, counters) {
  const ex = new Set(fca.excluded || []);
  const seen = new Set();
  const cand = [];
  for (const p of pilots || []) {
    if (p.phase !== "gnd" || !isConnectedPilot(p)) continue;      // no prefiles — VATSIM prefile presence is unreliable
    if (!isAtDepartureAirport(p)) continue;                        // landed arrivals are not departures
    if (seen.has(p.callsign)) continue;
    seen.add(p.callsign);
    if (ex.has(p.callsign)) { if (counters) counters.excluded++; continue; }
    if (!fcaMatchesDest(fca, p.arr)) continue;
    if (!fcaMatchesOrigin(fca, p.dep)) continue;
    if (!fcaMatchesFix(fca, p.route)) continue;
    if (!fcaMatchesScope(fca, p)) continue;
    if (!fcaMatchesAlt(fca, p.fpAlt || 0)) continue;
    const c = buildGroundCandidate(p, fca, nowMs, isReady(fca, p.callsign));
    if (c) cand.push(c);
  }
  return cand;
}

/* ============================================================
   SCHEDULING
   ============================================================ */
/**
 * Air = fixed constraints ordered by ETA (conflicts flagged, not "fixed").
 * Ready ground = frozen releases (validated / bumped-later).
 * Advisory ground = slotted around everything committed, holds nothing.
 */
function scheduleAuto(air, gnd, fca, nowMs, out, carryoverTimes) {
  // --- airborne: fixed, ordered by ETA ---
  air.sort((a, b) => a.eta - b.eta);
  for (let i = 0; i < air.length; i++) {
    const c = air[i];
    c.sched = c.eta;
    c.frozen = true;
    if (i > 0) {
      const gap = c.eta - air[i - 1].eta;
      const need = sepSeconds(fca, c);
      if (need > 0 && gap < need - 1) {
        c.conflict = true;
        c.conflictShortSec = need - gap;
        out.conflicts++;
      }
    }
  }
  const airTimes = air.map(c => c.sched).concat(carryoverTimes || []);

  // --- ready ground: frozen releases ---
  const ready = gnd.filter(c => c.ready && getRelease(fca, c.p.callsign));
  const advisory = gnd.filter(c => !ready.includes(c));
  ready.sort((a, b) => (getRelease(fca, a.p.callsign).ctaMs) - (getRelease(fca, b.p.callsign).ctaMs));
  for (const c of ready) {
    if (refreshRelease(fca, c, airTimes, nowMs)) out.releasesChanged = true;
    const rel = getRelease(fca, c.p.callsign);
    c.sched = (rel.ctaMs - nowMs) / 1000;
    c.edctMs = rel.edctMs;
    c.frozen = true;
  }

  // --- advisory ground: float around air + frozen releases ---
  const committed = airTimes.concat(ready.map(c => c.sched));
  advisory.sort((a, b) => a.eta - b.eta);
  for (const c of advisory) {
    c.sched = slotAgainstCommitted(c, committed, sepSeconds(fca, c));
    c.frozen = false;
    committed.push(c.sched);
  }

  return [...air, ...ready, ...advisory].sort((a, b) => a.sched - b.sched);
}

/** Manual override: controller-set order, times chained by separation.
 *  Frozen releases are honored inside the manual chain: a released aircraft is
 *  pinned at its release CTA (bumped LATER only if the manual order or a missed
 *  window forces it — a frozen EDCT never moves earlier). */
export function scheduleCandidates(cand, fca, manualOrder, candById, nowMs, out) {
  nowMs = nowMs != null ? nowMs : Date.now();
  const sepFor = c => sepSeconds(fca, c);
  if (manualOrder && manualOrder.length) {
    const ordered = [];
    let prev = -1e9;      // full chain (advisory included) — floors ADVISORY aircraft
    let prevHard = -1e9;  // air + frozen releases only — floors FROZEN releases
    for (const cs of manualOrder) {
      const c = candById.get(cs);
      if (!c) continue;
      const sepC = sepFor(c);
      const rel = (c.phase === "gnd" && fca) ? getRelease(fca, cs) : null;
      if (rel && rel.ctaMs != null) {
        // An issued EDCT is a commitment: only hard constraints (airborne
        // crossings, earlier releases) or a missed window may bump it later.
        // A drifting advisory proposal ahead of it never moves it — if the
        // advisory crowds inside separation, the conflict is flagged instead.
        const floor = Math.max(c.eta, prevHard + sepC);
        let t = (rel.ctaMs - nowMs) / 1000;
        const stale = nowMs > (rel.edctMs || 0) + COMPLIANCE_LATE_MS;
        if (stale) t = Math.max(floor, prev + sepC);           // missed window: re-slot at chain position
        else if (floor - t > FREEZE_TOL_SEC) t = floor;        // hard constraint forces later: bump, never earlier
        if (Math.abs(nowMs + t * 1000 - rel.ctaMs) > 1500) {
          rel.ctaMs = Math.round(nowMs + t * 1000);
          rel.edctMs = Math.round(rel.ctaMs - ((rel.transitSec || c.transitSec || 0) * 1000));
          if (out) out.releasesChanged = true;
        }
        if (prev + sepC - t > FREEZE_TOL_SEC) {
          c.conflict = true;                                    // advisory ahead crowds the frozen slot
          if (out) out.conflicts++;
        }
        c.sched = t;
        c.frozen = true;
        c.ready = true;
        c.edctMs = rel.edctMs;
        prevHard = Math.max(prevHard, t);
      } else {
        c.sched = Math.max(c.eta, prev + sepC);
        c.frozen = false;
        if (c.phase === "air") prevHard = Math.max(prevHard, c.sched);
      }
      prev = Math.max(prev, c.sched);
      ordered.push(c);
    }
    return ordered;
  }
  // fallback (unused by auto path — kept for API compatibility)
  const sorted = cand.slice().sort((a, b) => a.eta - b.eta);
  let prev = -1e9;
  for (const c of sorted) { c.sched = Math.max(c.eta, prev + sepFor(c)); prev = c.sched; }
  return sorted;
}

function finalizeItems(ordered, out, nowMs) {
  ordered.forEach(c => {
    c.delay = c.sched - c.eta;
    c.ctaMs = nowMs + c.sched * 1000;
    if (c.phase === "gnd") {
      if (c.edctMs == null) c.edctMs = c.ctaMs - (c.transitSec || 0) * 1000;
      out.nGnd++;
    } else {
      out.nAir++;
    }
  });
  out.items = ordered;
}

export function buildManualOrder(manualOrder, candById, _fca) {
  let order = (manualOrder || []).filter(cs => candById.has(cs));
  const inOrder = new Set(order);
  const sortNew = (a, b) => {
    const ca = candById.get(a), cb = candById.get(b);
    if (ca.phase !== cb.phase) return ca.phase === "air" ? -1 : 1;
    return ca.eta - cb.eta || ca.dist - cb.dist;
  };
  const newcomers = [...candById.keys()].filter(cs => !inOrder.has(cs)).sort(sortNew);
  for (const cs of newcomers) {
    const c = candById.get(cs);
    let idx = order.findIndex(o => sortNew(o, cs) > 0);
    if (idx < 0) idx = order.length;
    order.splice(idx, 0, cs);
  }
  return order;
}

export function resolveManualOrder(fca, candById, _pilots, _prefiles, _nowMs) {
  if (isManualSeq(fca)) {
    return buildManualOrder(fca.order, candById, fca);
  }
  return buildManualOrder([], candById, fca);
}

export function reorderFcaGlobalOrder(fca, pilots, prefiles, fromCs, toCs, opts = {}) {
  const seq = computeSequence(fca, pilots, prefiles, {
    includeEdct: true,
    nowMs: opts.nowMs != null ? opts.nowMs : Date.now(),
  });
  const order = Array.isArray(fca.order) && fca.order.length
    ? fca.order.slice()
    : seq.items.map(c => c.p.callsign);
  const from = order.indexOf(fromCs);
  const to = order.indexOf(toCs);
  if (from < 0 || to < 0 || from === to) return order;
  const [m] = order.splice(from, 1);
  order.splice(to, 0, m);
  return order;
}

/* ============================================================
   MAIN SEQUENCE
   ============================================================ */
export function computeSequence(fca, pilots, prefiles, opts = {}) {
  const includeEdct = opts.includeEdct !== false;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const out = {
    items: [], demand: 0, mode: fca.mode || "rate", rate: fca.rate || 0, mit: fca.mit || 0,
    minit: 0, excluded: 0, nAir: 0, nGnd: 0, nowMs, conflicts: 0, releasesChanged: false,
  };
  if (!fca.points || fca.points.length < 2) return out;

  const ex = new Set(fca.excluded || []);
  for (const p of pilots || []) {
    if (ex.has(p.callsign) && p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS) out.excluded++;
  }

  const air = collectAirFcaCandidates(fca, pilots);
  const airCs = new Set(air.map(c => c.p.callsign));

  // Releases of departed aircraft: consume only once the aircraft is genuinely
  // tracked as an airborne candidate (its own ETA takes over the slot). If it
  // departed but is NOT tracked (feed lag, filter edge, disconnect), the frozen
  // CTA stays committed until well past crossing so queued delays never collapse.
  const carryoverTimes = [];
  if (fca.releases) {
    const byCs = new Map((pilots || []).map(p => [p.callsign, p]));
    for (const cs of Object.keys(fca.releases)) {
      const rel = fca.releases[cs];
      const pl = byCs.get(cs);
      const airborneNow = pl && pl.phase === "air";
      if (airborneNow && airCs.has(cs)) { delete fca.releases[cs]; out.releasesChanged = true; continue; }
      if (airborneNow || !pl) {
        if (rel && rel.ctaMs != null && nowMs > rel.ctaMs + 10 * 60000) {
          delete fca.releases[cs]; out.releasesChanged = true;      // long past crossing
        } else if (rel && rel.ctaMs != null) {
          carryoverTimes.push((rel.ctaMs - nowMs) / 1000);          // slot stays protected
        }
      }
    }
  }

  const counters = { excluded: 0 };
  const gnd = includeEdct ? collectGroundFcaCandidates(fca, pilots, nowMs, counters) : [];
  out.excluded += counters.excluded;

  const cand = [...air, ...gnd];
  const candById = new Map();
  cand.forEach(c => candById.set(c.p.callsign, c));

  let ordered;
  if (isManualSeq(fca)) {
    out.manual = true;
    const order = buildManualOrder(fca.order, candById, fca);
    out.order = order;
    ordered = scheduleCandidates(cand, fca, order, candById, nowMs, out);
  } else {
    ordered = scheduleAuto(air, gnd, fca, nowMs, out, carryoverTimes);
  }
  finalizeItems(ordered, out, nowMs);

  if (out.mode === "rate" && fca.rate > 0) out.minit = 3600 / fca.rate;
  else if (out.mode === "mit" && cand.length) {
    const sp = cand[Math.floor(cand.length / 2)].crossSpd || 450;
    out.minit = ((fca.mit || 0) / sp) * 3600;
  }
  out.demand = cand.filter(c => c.eta <= DEMAND_WINDOW_MIN * 60).length;
  return out;
}

/* ============================================================
   TOWER DEPARTURES
   ============================================================ */
export function isDepartureCandidate(p, depIcao) {
  if (!isConnectedPilot(p)) return false;
  const dep = (p.dep || "").toUpperCase();
  if (dep !== depIcao) return false;
  if ((p.gs || 0) > 60 && (p.alt || 0) > 300) return false;
  return true;
}

export function computeTowerDepartures(depIcao, fcas, pilots, _prefiles) {
  const nowMs = Date.now();
  const dep = (depIcao || "").toUpperCase();
  if (!dep) return { departures: [], nowMs };

  const seen = new Set();
  let total = 0;
  for (const p of pilots || []) {
    if (!isDepartureCandidate(p, dep)) continue;
    if (seen.has(p.callsign)) continue;
    seen.add(p.callsign);
    total++;
  }

  const byCallsign = new Map();
  const activeFcas = (fcas || []).filter(f => f.enabled && f.points && f.points.length >= 2);

  for (const fca of activeFcas) {
    const seq = computeSequence(fca, pilots, [], { includeEdct: true, nowMs });
    for (let i = 0; i < seq.items.length; i++) {
      const c = seq.items[i];
      if (c.phase !== "gnd") continue;
      if ((c.p.dep || "").toUpperCase() !== dep) continue;
      if (!isDepartureCandidate(c.p, dep)) continue;
      const prev = i > 0 ? seq.items[i - 1] : null;
      const row = {
        callsign: c.p.callsign,
        dep: c.p.dep,
        arr: c.p.arr,
        type: c.p.type || "",
        fpAlt: c.p.fpAlt || 0,
        gs: c.p.gs || 0,
        fcaId: fca.id,
        fcaName: fca.name,
        fcaColor: fca.color,
        gapMin: prev ? (c.sched - prev.sched) / 60 : 0,
        delayMin: c.delay / 60,
        ctaMs: c.ctaMs,
        edctMs: c.edctMs,
        transitSec: c.transitSec,
        dist: c.dist,
        globalSeq: i + 1,
        sched: c.sched,
        eta: c.eta,
        ready: !!c.ready,
        frozen: !!c.frozen,
      };
      const old = byCallsign.get(row.callsign);
      if (!old || row.edctMs > old.edctMs) byCallsign.set(row.callsign, row);
    }
  }

  const departures = [...byCallsign.values()].sort((a, b) => a.edctMs - b.edctMs || a.callsign.localeCompare(b.callsign));
  return { departures, nowMs, total, metered: departures.length };
}
