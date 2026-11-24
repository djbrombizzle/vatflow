/**
 * Dispatch Center: ARTCC airspace for the ARTCC watch (DOM-free, tested in
 * scripts/test-aoc-core.mjs).
 *
 * Uses the same polygons as the rest of VATFLOW:
 *   data/artcc-boundaries-high.geojson   lateral limits of each center (as
 *                                        shared/artcc-scope.js and FCA builder)
 *   data/artcc-sectors-{low,high,uta}.geojson  its sectors, drawn on the map and
 *                                        used to say which sector a flight is in
 *
 * An area is {id, rings, bbox, contains(lat, lon)}: rings are GeoJSON outer
 * rings ([lon, lat]), bbox [minLat, minLon, maxLat, maxLon].
 */

/** KZDC -> ZDC; VAT-Spy FIR ids for the centers outside CONUS. */
const ALIASES = { PAZA: "ZAN", PHZH: "ZHN", TJZS: "ZSU", HCF: "ZHN", ANC: "ZAN" };
export function normArtcc(id) {
  let s = String(id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ALIASES[s]) return ALIASES[s];
  s = s.replace(/^K(?=Z[A-Z0-9]{2}$)/, "");
  return ALIASES[s] || s;
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function outerRings(g) {
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates.length ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") return g.coordinates.filter(p => p.length).map(p => p[0]);
  return [];
}

function makeArea(id, rings, extra = {}) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const r of rings) for (const [lon, lat] of r) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const bbox = [minLat, minLon, maxLat, maxLon];
  return {
    id, rings, bbox, ...extra,
    contains(lat, lon) {
      if (lat == null || lon == null || lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) return false;
      return rings.some(r => inRing(lat, lon, r));
    },
  };
}

/** The ARTCC boundaries in a GeoJSON file: Map(id -> area). Map-only overlays (ZMA-N) are skipped. */
export function artccAreas(geo) {
  const rings = new Map();
  for (const f of (geo && geo.features) || []) {
    const p = f.properties || {};
    if (p.mapHighlightOnly) continue;
    const id = normArtcc(p.id || p.ID || p.prefix);
    if (!id || id.includes("-")) continue;
    const rs = outerRings(f.geometry);
    if (!rs.length) continue;
    if (!rings.has(id)) rings.set(id, []);
    rings.get(id).push(...rs);
  }
  return new Map([...rings].map(([id, rs]) => [id, makeArea(id, rs)]));
}

/** One center's sectors in a sector file: [{id, label, sector, stratum, ...area}]. */
export function artccSectors(geo, id) {
  const want = normArtcc(id);
  const out = [];
  for (const f of (geo && geo.features) || []) {
    const p = f.properties || {};
    if (normArtcc(p.artcc) !== want) continue;
    const rs = outerRings(f.geometry);
    if (!rs.length) continue;
    out.push(makeArea(p.id || `${want}${p.sector || ""}`, rs, {
      label: p.label || p.id || "", sector: String(p.sector || ""), stratum: String(p.stratum || "").toUpperCase(),
    }));
  }
  return out;
}

/** Stratum for an altitude: LOW below FL240, HIGH to FL350, UTA above. */
export function stratumFor(altFt) {
  return altFt < 24000 ? "LOW" : altFt < 35000 ? "HIGH" : "UTA";
}

/**
 * The sector a flight is in: {LOW, HIGH, UTA} lists from artccSectors. It tries
 * the flight's stratum first, then the ones below it (a center with no UTA or
 * HIGH split owns that airspace in its lower sectors).
 */
export function sectorAt(byStratum, lat, lon, altFt) {
  if (!byStratum || lat == null) return null;
  const order = { LOW: ["LOW", "HIGH"], HIGH: ["HIGH", "LOW"], UTA: ["UTA", "HIGH", "LOW"] }[stratumFor(+altFt || 0)];
  for (const s of order) {
    const hit = (byStratum[s] || []).find(a => a.contains(lat, lon));
    if (hit) return hit;
  }
  return null;
}
