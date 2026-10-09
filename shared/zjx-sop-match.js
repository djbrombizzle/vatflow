/**
 * Match live flights against the ZJX SOP descent tables (shared/zjx-sop-data.js).
 * Route/destination matching is the ZDC matcher run over the ZJX rows; this
 * module adds the sector geometry the ZJX tables need, because most of their
 * rows name only a destination: a row applies when the route actually crosses
 * the sector whose table lists it. Pure functions, tested by
 * scripts/test-zjx-sop-match.mjs.
 */
import { ROWS, SECTOR_FALLBACK } from "./zjx-sop-data.js";
import { matchFlight as matchRows, primaryAirports, satellitePrimaries } from "./zdc-sop-match.js";

export { engineClass, flightRoutePoints } from "./zdc-sop-match.js";

export const zjxPrimaries = () => primaryAirports(ROWS);
export const zjxSatPrimaries = () => satellitePrimaries(ROWS);

/** SOP rows for one flight (see zdc-sop-match.js matchFlight). */
export function matchFlight(flight, ctx = {}) {
  return matchRows(flight, { ...ctx, rows: ctx.rows || ROWS, config: undefined });
}

/* ---------------- sector geometry ---------------- */

/**
 * ZJX sector polygons from the repo's sector GeoJSON (one or more strata) →
 * {byStratum: {LOW|HIGH|UTA: [{sector, rings}]}, bySector: Map(sector → rings)}.
 * Rings are [[lat, lon], …]. bySector merges every stratum, since a route
 * descending through ZJX meets a sector's airspace at whatever altitude.
 */
export function zjxSectorShapes(geojsons) {
  const byStratum = {}, bySector = new Map();
  for (const g of geojsons) {
    for (const f of (g && g.features) || []) {
      const p = f.properties || {};
      if (String(p.artcc || "").toUpperCase() !== "ZJX" || !f.geometry) continue;
      const sector = String(p.sector || "").padStart(2, "0");
      const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates
        : f.geometry.type === "Polygon" ? [f.geometry.coordinates] : [];
      const rings = polys.map(poly => poly[0].map(([lon, lat]) => [lat, lon]));
      const stratum = String(p.stratum || "").toUpperCase();
      (byStratum[stratum] = byStratum[stratum] || []).push({ sector, rings });
      if (!bySector.has(sector)) bySector.set(sector, []);
      bySector.get(sector).push(...rings);
    }
  }
  for (const [sec, list] of Object.entries(SECTOR_FALLBACK)) {
    if (bySector.has(sec)) continue;
    const rings = list.flatMap(s => bySector.get(s) || []);
    if (rings.length) bySector.set(sec, rings);
  }
  return { byStratum, bySector };
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInRings(ll, rings) {
  return !!ll && rings.some(r => inRing(ll[0], ll[1], r));
}

/** Path points with extra points every ~`stepDeg` so a short cut through a sector corner counts. */
export function densify(path, stepDeg = 0.15) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    if (!a) continue;
    out.push(a);
    const b = path[i + 1];
    if (!b) continue;
    const n = Math.floor(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / stepDeg);
    for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

/** Sectors (keys of bySector) the path passes through. */
export function sectorsOnPath(path, bySector) {
  const pts = densify(path);
  const hit = new Set();
  for (const [sec, rings] of bySector) if (pts.some(p => pointInRings(p, rings))) hit.add(sec);
  return hit;
}

/** First point where the path enters `rings` from outside, or null. */
export function entryPoint(path, rings) {
  const pts = densify(path, 0.05);
  for (let i = 1; i < pts.length; i++) {
    if (!pointInRings(pts[i - 1], rings) && pointInRings(pts[i], rings)) return pts[i];
  }
  return null;
}
