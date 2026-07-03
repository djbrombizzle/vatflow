#!/usr/bin/env node
/**
 * Build ARTCC boundary GeoJSON layers for FCA Builder.
 *
 * LOW  — from FAA Ground Level ARTCC Boundary CSV (ERAM product)
 * HIGH / UTA — from NASR ARB_BASE + ARB_SEG when available, else @squawk/airspace-data
 *
 * Usage:
 *   node scripts/build-artcc-boundaries.mjs
 *   node scripts/build-artcc-boundaries.mjs --arb-base /path/ARB_BASE.csv --arb-seg /path/ARB_SEG.csv
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const GROUND_CSV = join(DATA_DIR, "source", "Ground_Level_ARTCC_Boundary_Data_2026-06-11.csv");
const SQUAWK_GZ_URL = "https://unpkg.com/@squawk/airspace-data@latest/data/airspace.geojson.gz";
const PERTI_SECTOR_URLS = {
  LOW: "https://raw.githubusercontent.com/vATCSCC/PERTI/main/assets/geojson/low.json",
  HIGH: "https://raw.githubusercontent.com/vATCSCC/PERTI/main/assets/geojson/high.json",
  UTA: "https://raw.githubusercontent.com/vATCSCC/PERTI/main/assets/geojson/superhigh.json",
};

const US_ARTCC = new Set([
  "ZAB", "ZAU", "ZBW", "ZDC", "ZDV", "ZFW", "ZHU", "ZID", "ZJX", "ZKC",
  "ZLA", "ZLC", "ZMA", "ZME", "ZMP", "ZNY", "ZOA", "ZOB", "ZSE", "ZTL",
  "ZAN", "ZHN", "ZUA", "ZAP",
]);

const POINT_OF_BEGINNING = "POINT OF BEGINNING";

function parseFaaCoord(s) {
  s = s.trim();
  const hemi = s.slice(-1);
  const body = s.slice(0, -1);
  const ssHund = parseInt(body.slice(-2), 10);
  let rest = body.slice(0, -2);
  const sec = parseInt(rest.slice(-2), 10) + ssHund / 100;
  rest = rest.slice(0, -2);
  const mins = parseInt(rest.slice(-2), 10);
  const deg = parseInt(rest.slice(0, -2), 10);
  let val = deg + mins / 60 + sec / 3600;
  if (hemi === "S" || hemi === "W") val = -val;
  return Math.round(val * 1e6) / 1e6;
}

function closeRing(coords) {
  if (!coords.length) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...coords, first];
  return coords;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function readCsv(path) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!header) { header = fields; continue; }
    const row = {};
    header.forEach((h, i) => { row[h] = fields[i] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function buildLowFromGroundCsv(rows) {
  const byFac = new Map();
  for (const row of rows) {
    const id = row["Facility ID"].trim().toUpperCase();
    if (!US_ARTCC.has(id)) continue;
    if (!byFac.has(id)) byFac.set(id, { upper: parseInt(row["Upper Altitude"], 10), pts: [] });
    byFac.get(id).pts.push([
      parseFaaCoord(row["Longitude"]),
      parseFaaCoord(row["Latitude"]),
    ]);
  }
  const features = [];
  for (const [id, { upper, pts }] of byFac) {
    if (pts.length < 3) continue;
    features.push({
      type: "Feature",
      properties: { id, stratum: "LOW", lowerFt: 0, upperFt: upper, source: "ERAM-ground" },
      geometry: { type: "Polygon", coordinates: [closeRing(pts)] },
    });
  }
  return { type: "FeatureCollection", features };
}

function resolveStratum(altitude, type) {
  if (altitude === "HIGH" && type === "ARTCC") return "HIGH";
  if (altitude === "LOW" && type === "ARTCC") return "LOW";
  if (altitude === "UNLIMITED") {
    if (type === "UTA") return "UTA";
  }
  return null;
}

function splitClosedShapes(points) {
  const shapes = [];
  let current = [];
  for (const pt of points) {
    current.push([pt.lon, pt.lat]);
    if (pt.description.toUpperCase().includes(POINT_OF_BEGINNING)) {
      shapes.push(closeRing(current));
      current = [];
    }
  }
  if (current.length) shapes.push(closeRing(current));
  return shapes;
}

async function loadArbBase(path) {
  const rows = await readCsv(path);
  const map = new Map();
  for (const row of rows) {
    if ((row.COUNTRY_CODE || "") !== "US") continue;
    const id = (row.LOCATION_ID || "").trim().toUpperCase();
    if (!id || !US_ARTCC.has(id)) continue;
    map.set(id, {
      id,
      name: row.LOCATION_NAME || id,
      state: row.STATE || null,
    });
  }
  return map;
}

async function buildFromArb(basePath, segPath, stratumFilter) {
  const base = await loadArbBase(basePath);
  const rows = await readCsv(segPath);
  const groups = new Map();

  for (const row of rows) {
    const id = (row.LOCATION_ID || "").trim().toUpperCase();
    if (!base.has(id)) continue;
    const stratum = resolveStratum(row.ALTITUDE || "", row.TYPE || "");
    if (!stratum || !stratumFilter.has(stratum)) continue;
    const key = `${id}|${stratum}`;
    const pointSeq = parseInt(row.POINT_SEQ, 10);
    const lat = parseFloat(row.LAT_DECIMAL);
    const lon = parseFloat(row.LONG_DECIMAL);
    if (!isFinite(pointSeq) || !isFinite(lat) || !isFinite(lon)) continue;
    const pt = { pointSeq, lat, lon, description: row.BNDRY_PT_DESCRIP || "" };
    if (!groups.has(key)) groups.set(key, { id, stratum, points: [pt] });
    else groups.get(key).points.push(pt);
  }

  const features = [];
  const stratumBounds = {
    LOW: { lowerFt: 0, upperFt: 18000 },
    HIGH: { lowerFt: 18000, upperFt: 60000 },
    UTA: { lowerFt: 60000, upperFt: 99999 },
  };

  for (const { id, stratum, points } of groups.values()) {
    points.sort((a, b) => a.pointSeq - b.pointSeq);
    const shapes = splitClosedShapes(points);
    const bounds = stratumBounds[stratum];
    for (const ring of shapes) {
      if (ring.length < 4) continue;
      features.push({
        type: "Feature",
        properties: {
          id,
          stratum,
          lowerFt: bounds.lowerFt,
          upperFt: bounds.upperFt,
          source: "NASR-ARB",
        },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function buildFromSquawk(gj, stratumFilter) {
  const stratumBounds = {
    LOW: { lowerFt: 0, upperFt: 18000 },
    HIGH: { lowerFt: 18000, upperFt: 60000 },
    UTA: { lowerFt: 60000, upperFt: 99999 },
  };
  const features = [];
  for (const f of gj.features || []) {
    const p = f.properties || {};
    if (p.type !== "ARTCC") continue;
    const stratum = p.artccStratum;
    if (!stratumFilter.has(stratum)) continue;
    const id = (p.identifier || "").toUpperCase();
    if (!US_ARTCC.has(id)) continue;
    const bounds = stratumBounds[stratum];
    if (!bounds) continue;
    const geom = f.geometry;
    if (!geom) continue;
    const pushPoly = coords => {
      if (!coords || coords[0]?.length < 4) return;
      features.push({
        type: "Feature",
        properties: {
          id,
          stratum,
          lowerFt: p.floor?.valueFt ?? bounds.lowerFt,
          upperFt: p.ceiling?.valueFt ?? bounds.upperFt,
          source: "squawk-airspace-data",
        },
        geometry: { type: "Polygon", coordinates: coords },
      });
    };
    if (geom.type === "Polygon") pushPoly(geom.coordinates);
    else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) pushPoly(poly);
    }
  }
  return { type: "FeatureCollection", features };
}

/** US ERAM sector polygons from PERTI / vIFF CDM (community-derived, not official FAA). */
async function buildSectorsFromPerti(stratum, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PERTI ${stratum} fetch HTTP ${res.status}`);
  const gj = await res.json();
  const features = [];
  for (const f of gj.features || []) {
    const p = f.properties || {};
    const artcc = (p.artcc || "").toUpperCase();
    if (!US_ARTCC.has(artcc)) continue;
    const sector = String(p.sector ?? "").trim();
    const label = (p.label || artcc + sector).toUpperCase();
    const id = label || (artcc + sector);
    const geom = f.geometry;
    if (!geom || !["Polygon", "MultiPolygon"].includes(geom.type)) continue;
    features.push({
      type: "Feature",
      properties: {
        id,
        artcc,
        sector,
        label,
        stratum,
        source: "PERTI-vIFF",
      },
      geometry: geom,
    });
  }
  return { type: "FeatureCollection", features };
}

function parseArgs(argv) {
  const out = { arbBase: null, arbSeg: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--arb-base") out.arbBase = argv[++i];
    else if (argv[i] === "--arb-seg") out.arbSeg = argv[++i];
  }
  return out;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const args = parseArgs(process.argv);

  console.log("Building LOW from ERAM ground CSV…");
  const groundRows = await readCsv(GROUND_CSV);
  const low = buildLowFromGroundCsv(groundRows);
  writeFileSync(join(DATA_DIR, "artcc-boundaries-low.geojson"), JSON.stringify(low));
  console.log(`  artcc-boundaries-low.geojson — ${low.features.length} features`);

  let high, uta;
  if (args.arbBase && args.arbSeg) {
    console.log("Building HIGH/UTA from NASR ARB CSVs…");
    high = await buildFromArb(args.arbBase, args.arbSeg, new Set(["HIGH"]));
    uta = await buildFromArb(args.arbBase, args.arbSeg, new Set(["UTA"]));
  } else {
    console.log("ARB CSVs not provided — using @squawk/airspace-data (NASR-derived)…");
    const { gunzipSync } = await import("node:zlib");
    const res = await fetch(SQUAWK_GZ_URL);
    if (!res.ok) throw new Error(`squawk fetch HTTP ${res.status}`);
    const gj = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
    high = buildFromSquawk(gj, new Set(["HIGH"]));
    uta = buildFromSquawk(gj, new Set(["UTA"]));
  }

  writeFileSync(join(DATA_DIR, "artcc-boundaries-high.geojson"), JSON.stringify(high));
  writeFileSync(join(DATA_DIR, "artcc-boundaries-uta.geojson"), JSON.stringify(uta));
  console.log(`  artcc-boundaries-high.geojson — ${high.features.length} features`);
  console.log(`  artcc-boundaries-uta.geojson — ${uta.features.length} features`);

  console.log("Building US ERAM sectors from PERTI / vIFF CDM…");
  for (const [stratum, url] of Object.entries(PERTI_SECTOR_URLS)) {
    const slug = stratum === "UTA" ? "uta" : stratum.toLowerCase();
    const sectors = await buildSectorsFromPerti(stratum, url);
    writeFileSync(join(DATA_DIR, `artcc-sectors-${slug}.geojson`), JSON.stringify(sectors));
    const centers = new Set(sectors.features.map(f => f.properties.artcc));
    console.log(`  artcc-sectors-${slug}.geojson — ${sectors.features.length} sectors, ${centers.size} ARTCCs`);
  }
  console.log("Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
