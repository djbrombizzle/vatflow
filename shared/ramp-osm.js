/**
 * RampView — OpenStreetMap surface extraction.
 *
 * Builds the Overpass query for an airport and parses the response into the
 * RampView airport model. Shared by scripts/build-ramp-airport.mjs (node) and
 * by the in-browser "fetch surface" flow, so both produce identical geometry.
 *
 * OSM data © OpenStreetMap contributors, ODbL.
 */

import { makeProjection, bearingXY, synthStandPoly, minCodeForWake } from "./ramp-airport.js";

/** Public Overpass endpoints, tried in order. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Half-size of the fetch box, in degrees of latitude. ~9 km covers ATL. */
const BOX_LAT = 0.08;

/**
 * @param {[number, number]} ref airport reference point [lat, lon]
 * @returns {string} Overpass QL
 */
export function overpassQuery(ref) {
  const [lat, lon] = ref;
  const dLon = BOX_LAT / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const bbox = [lat - BOX_LAT, lon - dLon, lat + BOX_LAT, lon + dLon]
    .map(v => v.toFixed(5)).join(",");
  return `[out:json][timeout:180];
(
  way["aeroway"~"^(runway|taxiway|apron|terminal|parking_position|hangar)$"](${bbox});
  node["aeroway"="parking_position"](${bbox});
  node["aeroway"="gate"](${bbox});
  way["building"="terminal"](${bbox});
);
out body geom;`;
}

/**
 * Fetch the surface from Overpass, trying each endpoint in turn.
 * @param {[number, number]} ref
 * @param {(msg: string) => void} [onStatus]
 */
export async function fetchOverpass(ref, onStatus) {
  const body = "data=" + encodeURIComponent(overpassQuery(ref));
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      if (onStatus) onStatus("Querying " + new URL(url).host + "…");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new Error(url + " returned HTTP " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("no Overpass endpoint responded");
}

/** OSM `aircraft:type` / width hints -> ICAO code letter. */
function sizeFromTags(tags) {
  const raw = String(tags["aircraft:type"] || tags.aircraft || "").toLowerCase();
  if (/a380|747|777x/.test(raw)) return "F";
  if (/heavy|widebody|787|777|a350|a330|767|md11/.test(raw)) return "E";
  if (/757|a321|737|a320|md8|e19/.test(raw)) return "C";
  if (/crj|e17|e14|regional|dh8|atr/.test(raw)) return "B";
  const width = parseFloat(tags.width || tags["maxwidth:aircraft"] || "");
  if (isFinite(width)) {
    if (width >= 75) return "F";
    if (width >= 60) return "E";
    if (width >= 50) return "D";
    if (width >= 34) return "C";
    if (width >= 24) return "B";
    return "A";
  }
  if (tags.wake) return minCodeForWake(tags.wake);
  return null;
}

/** Airline codes an OSM stand is tagged for. */
function operatorsFromTags(tags) {
  const raw = tags["operator:icao"] || tags.operator || tags.airline || "";
  return String(raw)
    .split(/[;,]/)
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z]{3}$/.test(s));
}

function standIdFromTags(tags) {
  const id = tags.ref || tags["ref:gate"] || tags.name || "";
  return String(id).trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Parse an Overpass `out body geom` response into the airport model.
 * @param {object} osm Overpass JSON
 * @param {{ icao: string, ref: [number, number] }} opts
 */
export function parseOverpass(osm, opts) {
  const { icao, ref } = opts;
  const proj = makeProjection(ref[0], ref[1]);
  const model = {
    icao: String(icao).toUpperCase(),
    ref,
    builtAt: new Date().toISOString(),
    attribution: "© OpenStreetMap contributors (ODbL)",
    runways: [], taxiways: [], aprons: [], buildings: [], stands: [],
    ramps: [], concourses: {}, operatorBlocks: {}, spots: [], areas: [],
  };

  const round = n => Math.round(n * 10) / 10;
  const geomToXY = geom => (geom || []).map(g => {
    const [x, y] = proj.toXY(g.lat, g.lon);
    return [round(x), round(y)];
  });

  const seenStand = new Set();
  const addStand = (id, point, hdg, tags) => {
    if (!id || seenStand.has(id)) return;
    seenStand.add(id);
    const sizeCode = sizeFromTags(tags) || "C";
    model.stands.push({
      id,
      point: [round(point[0]), round(point[1])],
      hdg: Math.round(hdg),
      sizeCode,
      poly: synthStandPoly(point, hdg, sizeCode).map(p => [round(p[0]), round(p[1])]),
      operators: operatorsFromTags(tags),
      opsType: tags.aeroway === "hangar" ? "ga" : (tags.type || "airline"),
      intl: tags.international === "yes" || undefined,
      concourse: null, ramp: null,
    });
  };

  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    const kind = tags.aeroway || (tags.building === "terminal" ? "terminal" : null);

    if (el.type === "node") {
      if (kind !== "parking_position" && kind !== "gate") continue;
      const [x, y] = proj.toXY(el.lat, el.lon);
      const hdg = parseFloat(tags.direction || tags.heading || "");
      addStand(standIdFromTags(tags), [x, y], isFinite(hdg) ? hdg : 0, tags);
      continue;
    }
    if (el.type !== "way") continue;
    const pts = geomToXY(el.geometry);
    if (pts.length < 2) continue;

    switch (kind) {
      case "runway":
        model.runways.push({ id: tags.ref || tags.name || "", line: pts, width: parseFloat(tags.width) || 45 });
        break;
      case "taxiway":
        model.taxiways.push({ ref: tags.ref || tags.name || "", line: pts, width: parseFloat(tags.width) || 23 });
        break;
      case "apron":
        model.aprons.push({ poly: pts });
        break;
      case "terminal":
      case "hangar":
        model.buildings.push({ poly: pts, kind });
        break;
      case "parking_position": {
        // OSM draws a parking_position as the centreline of the stand, in the
        // direction of travel entering it — so the last segment gives the
        // heading the aircraft faces when parked, and the last node the nose.
        const a = pts[pts.length - 2];
        const b = pts[pts.length - 1];
        addStand(standIdFromTags(tags), b, bearingXY(a[0], a[1], b[0], b[1]), tags);
        break;
      }
      default:
        break;
    }
  }

  model.stands.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return model;
}
