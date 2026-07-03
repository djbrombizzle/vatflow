#!/usr/bin/env node
/**
 * Build compact FAA NASR navigation data for VATFLOW route processing.
 *
 * Primary source: @squawk/* NASR snapshots (FIX, NAV, AWY, procedures).
 * Optional: local NASR CSV directory via --nasr-dir (FIX.csv, NAV.csv, AWY.csv).
 *
 * Usage:
 *   node scripts/build-nav-data.mjs
 *   node scripts/build-nav-data.mjs --nasr-dir /path/to/CSV
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "nav");

const CONUS = { minLat: 23.5, maxLat: 51.5, minLon: -130, maxLon: -63 };

const SQUAWK = {
  fixes: "https://unpkg.com/@squawk/fix-data@0.6.10/data/fixes.json.gz",
  navaids: "https://unpkg.com/@squawk/navaid-data@0.6.10/data/navaids.json.gz",
  airways: "https://unpkg.com/@squawk/airway-data@0.5.10/data/airways.json.gz",
  procedures: "https://unpkg.com/@squawk/procedure-data@0.7.8/data/procedures.json.gz",
};

function inConus(lat, lon) {
  return lat >= CONUS.minLat && lat <= CONUS.maxLat && lon >= CONUS.minLon && lon <= CONUS.maxLon;
}

function roundCoord(n) {
  return Math.round(n * 1e5) / 1e5;
}

function addCandidate(map, id, lat, lon) {
  if (!id || !isFinite(lat) || !isFinite(lon) || !inConus(lat, lon)) return;
  const key = id.toUpperCase();
  const pt = [roundCoord(lat), roundCoord(lon)];
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  if (!arr.some(p => p[0] === pt[0] && p[1] === pt[1])) arr.push(pt);
}

async function fetchGzJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return JSON.parse(gunzipSync(buf).toString("utf8"));
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

function mapToObj(m) {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

async function buildFromSquawk() {
  console.log("Fetching @squawk NASR snapshots…");
  const [fixPack, navPack, awyPack, procPack] = await Promise.all([
    fetchGzJson(SQUAWK.fixes),
    fetchGzJson(SQUAWK.navaids),
    fetchGzJson(SQUAWK.airways),
    fetchGzJson(SQUAWK.procedures),
  ]);

  const fixes = new Map();
  const navaids = new Map();

  for (const r of fixPack.records || []) {
    addCandidate(fixes, r.identifier, r.lat, r.lon);
  }
  for (const r of navPack.records || []) {
    addCandidate(navaids, r.identifier, r.lat, r.lon);
    if (r.name) addCandidate(navaids, r.name, r.lat, r.lon);
  }

  const airways = {};
  for (const a of awyPack.records || []) {
    const des = (a.designation || "").toUpperCase();
    if (!des) continue;
    const wps = [];
    for (const w of a.waypoints || []) {
      const lat = w.lat, lon = w.lon;
      if (!isFinite(lat) || !isFinite(lon) || !inConus(lat, lon)) continue;
      const id = (w.identifier || w.name || "").toUpperCase();
      wps.push([id, roundCoord(lat), roundCoord(lon)]);
      if (id) addCandidate(fixes, id, lat, lon);
    }
    if (wps.length >= 2) {
      const prefix = des.charAt(0);
      airways[des] = { t: prefix, w: wps };
    }
  }

  const procedures = {};
  const preferred = {};
  for (const p of procPack.records || []) {
    const typ = (p.type || "").toUpperCase();
    if (typ !== "SID" && typ !== "STAR") continue;
    const id = (p.identifier || p.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!id || id.length < 4) continue;
    const pushLeg = (arr, leg) => {
      if (!leg || !isFinite(leg.lat) || !isFinite(leg.lon)) return;
      if (!inConus(leg.lat, leg.lon)) return;
      const fix = (leg.fixIdentifier || "").toUpperCase();
      arr.push([fix, roundCoord(leg.lat), roundCoord(leg.lon)]);
      if (fix) addCandidate(fixes, fix, leg.lat, leg.lon);
    };
    const common = [];
    for (const route of p.commonRoutes || []) {
      for (const leg of route.legs || []) pushLeg(common, leg);
    }
    const transitions = {};
    for (const tr of p.transitions || []) {
      const tname = (tr.name || tr.identifier || "").toUpperCase();
      if (!tname) continue;
      const tlegs = [];
      for (const leg of tr.legs || []) pushLeg(tlegs, leg);
      if (tlegs.length >= 2) transitions[tname] = tlegs;
    }
    if (common.length < 2 && !Object.keys(transitions).length) continue;
    procedures[id] = {
      type: typ,
      apt: (p.airports || []).map(a => a.toUpperCase()),
      common,
      transitions,
    };
    const base = id.replace(/\d+[A-Z]?$/, "");
    if (base.length >= 4 && !procedures[base]) procedures[base] = procedures[id];
  }

  // Preferred routes: try FAA PFR.csv when NASR CDN is reachable
  try {
    const pfrUrl = "https://nfdc.faa.gov/webContent/28DaySub/2026-05-14/CSV/PFR.csv";
    const res = await fetch(pfrUrl);
    if (res.ok) {
      const text = await res.text();
      const lines = text.split(/\r?\n/);
      const header = lines[0]?.split(",") || [];
      const idx = name => header.findIndex(h => h.replace(/"/g, "").trim() === name);
      const iDep = idx("DEPARTURE_AIRPORT") >= 0 ? idx("DEPARTURE_AIRPORT") : idx("DEPARTURE");
      const iArr = idx("ARRIVAL_AIRPORT") >= 0 ? idx("ARRIVAL_AIRPORT") : idx("ARRIVAL");
      const iRoute = idx("ROUTE_STRING") >= 0 ? idx("ROUTE_STRING") : idx("ROUTE");
      if (iDep >= 0 && iArr >= 0 && iRoute >= 0) {
        for (let li = 1; li < lines.length; li++) {
          const cols = parseCsvLine(lines[li]);
          const dep = (cols[iDep] || "").replace(/"/g, "").trim().toUpperCase();
          const arr = (cols[iArr] || "").replace(/"/g, "").trim().toUpperCase();
          const route = (cols[iRoute] || "").replace(/"/g, "").trim().toUpperCase();
          if (dep && arr && route) preferred[`${dep}|${arr}`] = route;
        }
      }
    }
  } catch (e) {
    console.warn("PFR fetch skipped:", e.message);
  }

  return {
    meta: {
      source: "squawk NASR snapshots",
      nasrCycleDate: fixPack.meta?.nasrCycleDate || awyPack.meta?.nasrCycleDate || null,
      cifpCycleDate: procPack.meta?.cifpCycleDate || null,
      generatedAt: new Date().toISOString(),
      bbox: [CONUS.minLat, CONUS.minLon, CONUS.maxLat, CONUS.maxLon],
      fixCount: fixes.size,
      navaidCount: navaids.size,
      airwayCount: Object.keys(airways).length,
      procedureCount: Object.keys(procedures).length,
      preferredRouteCount: Object.keys(preferred).length,
    },
    fixes: mapToObj(fixes),
    navaids: mapToObj(navaids),
    airways,
    procedures,
    preferred,
  };
}

async function buildFromNasrCsv(dir) {
  console.log(`Building from NASR CSV in ${dir}…`);
  const fixRows = await readCsv(join(dir, "FIX.csv")).catch(() => []);
  const navRows = await readCsv(join(dir, "NAV.csv")).catch(() => []);
  const awyRows = await readCsv(join(dir, "AWY.csv")).catch(() => []);
  const pfrRows = await readCsv(join(dir, "PFR.csv")).catch(() => []);

  const fixes = new Map();
  const navaids = new Map();
  for (const r of fixRows) {
    const id = (r.FIX_ID || r.IDENT || r.ident || "").trim();
    const lat = parseFloat(r.LAT_DECIMAL || r.LAT || r.lat);
    const lon = parseFloat(r.LONG_DECIMAL || r.LON || r.lon);
    addCandidate(fixes, id, lat, lon);
  }
  for (const r of navRows) {
    const id = (r.NAV_ID || r.IDENT || r.ident || "").trim();
    const lat = parseFloat(r.LAT_DECIMAL || r.LAT || r.lat);
    const lon = parseFloat(r.LONG_DECIMAL || r.LON || r.lon);
    addCandidate(navaids, id, lat, lon);
  }

  const airwayGroups = new Map();
  for (const r of awyRows) {
    const des = (r.ROUTE_ID || r.AWY_ID || r.ident || "").toUpperCase();
    const seq = parseInt(r.SEQUENCE_NBR || r.SEQ || r.seq || "0", 10);
    const fix = (r.FIX_ID || r.WAYPOINT_ID || "").toUpperCase();
    const lat = parseFloat(r.LAT_DECIMAL || r.LAT);
    const lon = parseFloat(r.LONG_DECIMAL || r.LON);
    if (!des || !isFinite(seq)) continue;
    const key = des;
    if (!airwayGroups.has(key)) airwayGroups.set(key, []);
    airwayGroups.get(key).push({ seq, fix, lat, lon });
  }
  const airways = {};
  for (const [des, pts] of airwayGroups) {
    pts.sort((a, b) => a.seq - b.seq);
    const w = [];
    for (const p of pts) {
      if (!isFinite(p.lat) || !isFinite(p.lon) || !inConus(p.lat, p.lon)) continue;
      w.push([p.fix, roundCoord(p.lat), roundCoord(p.lon)]);
      if (p.fix) addCandidate(fixes, p.fix, p.lat, p.lon);
    }
    if (w.length >= 2) airways[des] = { t: des.charAt(0), w };
  }

  const preferred = {};
  for (const r of pfrRows) {
    const dep = (r.DEPARTURE_AIRPORT || r.dep || "").toUpperCase();
    const arr = (r.ARRIVAL_AIRPORT || r.arr || "").toUpperCase();
    const route = (r.ROUTE_STRING || r.route || "").trim();
    if (!dep || !arr || !route) continue;
    const key = `${dep}|${arr}`;
    if (!preferred[key]) preferred[key] = route.toUpperCase();
  }

  return {
    meta: {
      source: "NASR CSV",
      nasrCycleDate: null,
      generatedAt: new Date().toISOString(),
      bbox: [CONUS.minLat, CONUS.minLon, CONUS.maxLat, CONUS.maxLon],
      fixCount: fixes.size,
      navaidCount: navaids.size,
      airwayCount: Object.keys(airways).length,
      procedureCount: 0,
      preferredRouteCount: Object.keys(preferred).length,
    },
    fixes: mapToObj(fixes),
    navaids: mapToObj(navaids),
    airways,
    procedures: {},
    preferred,
  };
}

function writeOutputs(data) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "meta.json"), JSON.stringify(data.meta, null, 2));
  writeFileSync(join(OUT_DIR, "fixes.json"), JSON.stringify(data.fixes));
  writeFileSync(join(OUT_DIR, "navaids.json"), JSON.stringify(data.navaids));
  writeFileSync(join(OUT_DIR, "airways.json"), JSON.stringify(data.airways));
  writeFileSync(join(OUT_DIR, "procedures.json"), JSON.stringify(data.procedures));
  writeFileSync(join(OUT_DIR, "preferred.json"), JSON.stringify(data.preferred));
  const sizes = {
    fixes: JSON.stringify(data.fixes).length,
    navaids: JSON.stringify(data.navaids).length,
    airways: JSON.stringify(data.airways).length,
    procedures: JSON.stringify(data.procedures).length,
    preferred: JSON.stringify(data.preferred).length,
  };
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  console.log(`Wrote data/nav/* (${Math.round(total / 1024)} KB JSON payload)`, sizes);
  console.log(data.meta);
}

async function main() {
  const nasrIdx = process.argv.indexOf("--nasr-dir");
  const nasrDir = nasrIdx >= 0 ? process.argv[nasrIdx + 1] : null;
  const data = nasrDir ? await buildFromNasrCsv(nasrDir) : await buildFromSquawk();
  writeOutputs(data);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
