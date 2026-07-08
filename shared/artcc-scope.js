/**
 * ARTCC scope containment for FCA filtering.
 *
 * Loads the repo's HIGH-stratum ARTCC boundary polygons (lateral limits) and
 * answers "is this lat/lon inside ARTCC X?" via ray-casting. Used by the
 * metering engine's scope filter: an FCA scoped to ["ZDC","ZTL","ZJX"] only
 * meters aircraft physically inside one of those centers.
 *
 * Fails OPEN by design: until boundaries load (or for unknown ARTCC ids),
 * pointInArtcc returns null and the engine includes the aircraft — missing
 * map data must never silently hide traffic from a metering program.
 */

const polys = new Map();   // ARTCC id -> array of rings [[lat,lon],...] (outer rings only)
let loaded = false;
let loading = null;

/** Ray-cast a point against one ring of [lon,lat] GeoJSON coordinates. */
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];   // lon, lat
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function ingestGeojson(geo) {
  polys.clear();
  for (const f of (geo && geo.features) || []) {
    const id = ((f.properties && (f.properties.id || f.properties.ID || f.properties.prefix)) || "")
      .toString().toUpperCase().replace(/^K(?=Z)/, "");
    if (!id || !f.geometry) continue;
    const g = f.geometry;
    const rings = [];
    if (g.type === "Polygon" && g.coordinates.length) rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.length && rings.push(p[0]));
    if (!rings.length) continue;
    if (!polys.has(id)) polys.set(id, []);
    polys.get(id).push(...rings);
  }
  loaded = polys.size > 0;
  return polys.size;
}

/** Seed boundaries directly (tests / offline). */
export function seedArtccBoundaries(geo) { return ingestGeojson(geo); }

export function isArtccScopeReady() { return loaded; }

/** Known ARTCC ids in the loaded data. */
export function knownArtccs() { return [...polys.keys()].sort(); }

/**
 * true  — point is inside the ARTCC's lateral boundary
 * false — data loaded for this ARTCC, point is outside
 * null  — unknown (data not loaded, or ARTCC id not in the data) -> caller fails open
 */
export function pointInArtcc(id, lat, lon) {
  if (!loaded || lat == null || lon == null) return null;
  const rings = polys.get(("" + id).toUpperCase());
  if (!rings) return null;
  for (const r of rings) if (inRing(lat, lon, r)) return true;
  return false;
}

/**
 * Fetch boundaries once (idempotent). Tries the repo's HIGH-stratum file first
 * (same data the builder's map layer uses), falls back to the VATSpy project.
 */
export function fetchArtccBoundaries(baseUrl = "") {
  if (loaded) return Promise.resolve(polys.size);
  if (loading) return loading;
  const local = (baseUrl || "") + "data/artcc-boundaries-high.geojson";
  const fallback = "https://cdn.jsdelivr.net/gh/vatsimnetwork/vatspy-data-project@master/Boundaries.geojson";
  loading = fetch(local)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(ingestGeojson)
    .catch(() => fetch(fallback)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then(ingestGeojson)
      .catch(() => 0))
    .finally(() => { loading = null; });
  return loading;
}
