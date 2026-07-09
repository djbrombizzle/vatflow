#!/usr/bin/env node
/**
 * Build compact FAA NASR navigation data for VATFLOW route processing.
 *
 * Primary source: @squawk/* NASR snapshots (FIX, NAV, AWY, procedures).
 * Optional: local NASR CSV directory via --nasr-dir (FIX.csv, NAV.csv, AWY.csv).
 * Optional: --faa-cycle YYYY-MM-DD downloads FAA FIX/NAV/PFR CSV zips and merges
 *   with @squawk airways/procedures (enroute data unchanged on 28-day change notices).
 *
 * Usage:
 *   node scripts/build-nav-data.mjs
 *   node scripts/build-nav-data.mjs --faa-cycle 2026-07-09
 *   node scripts/build-nav-data.mjs --nasr-dir /path/to/CSV
 */

import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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

const FAA_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function faaExtraDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${String(d).padStart(2, "0")}_${FAA_MONTHS[m - 1]}_${y}`;
}

function faaExtraZipUrl(isoDate, group) {
  return `https://nfdc.faa.gov/webContent/28DaySub/extra/${faaExtraDate(isoDate)}_${group}_CSV.zip`;
}

async function downloadFaaCsvGroup(isoDate, group, destDir) {
  const url = faaExtraZipUrl(isoDate, group);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = join(destDir, `${group}.zip`);
  writeFileSync(zipPath, buf);
  execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "pipe" });
  console.log(`  ${group}: ${url}`);
}

async function fetchFaaCycleCsvs(isoDate) {
  const dir = mkdtempSync(join(tmpdir(), "vatflow-nasr-"));
  try {
    console.log(`Downloading FAA CSV groups for cycle ${isoDate}…`);
    await Promise.all([
      downloadFaaCsvGroup(isoDate, "FIX", dir),
      downloadFaaCsvGroup(isoDate, "NAV", dir),
      downloadFaaCsvGroup(isoDate, "PFR", dir),
    ]);
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function firstCsvRow(rows, ...keys) {
  for (const key of keys) {
    if (rows[key] !== undefined && rows[key] !== "") return rows[key];
  }
  return "";
}

function buildFixesFromRows(rows) {
  const fixes = new Map();
  for (const r of rows) {
    const id = firstCsvRow(r, "FIX_ID", "FIX_ID_OLD", "ident").trim();
    const lat = parseFloat(firstCsvRow(r, "LAT_DECIMAL", "lat"));
    const lon = parseFloat(firstCsvRow(r, "LONG_DECIMAL", "lon"));
    addCandidate(fixes, id, lat, lon);
  }
  return fixes;
}

function buildNavaidsFromRows(rows) {
  const navaids = new Map();
  for (const r of rows) {
    const id = firstCsvRow(r, "NAV_ID", "IDENT", "ident").trim();
    const name = firstCsvRow(r, "NAME", "name").trim();
    const lat = parseFloat(firstCsvRow(r, "LAT_DECIMAL", "LAT"));
    const lon = parseFloat(firstCsvRow(r, "LONG_DECIMAL", "LON"));
    addCandidate(navaids, id, lat, lon);
    if (name) addCandidate(navaids, name, lat, lon);
  }
  return navaids;
}

function buildPreferredFromRows(rows) {
  const preferred = {};
  for (const r of rows) {
    const dep = firstCsvRow(r, "ORIGIN_ID", "DEPARTURE_AIRPORT", "DEPARTURE", "dep").toUpperCase();
    const arr = firstCsvRow(r, "DSTN_ID", "ARRIVAL_AIRPORT", "ARRIVAL", "arr").toUpperCase();
    const route = firstCsvRow(r, "ROUTE_STRING", "route").trim().toUpperCase();
    if (!dep || !arr || !route) continue;
    preferred[`${dep}|${arr}`] = route;
  }
  return preferred;
}

async function readCsvFromDir(dir, ...names) {
  for (const name of names) {
    const path = join(dir, name);
    try {
      readFileSync(path);
      return readCsv(path);
    } catch {
      // try next filename variant
    }
  }
  return [];
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

  // Preferred routes: FAA PFR when available
  const preferred = await fetchPreferredRoutes(null);

  return assembleNavData({
    meta: {
      source: "squawk NASR snapshots",
      nasrCycleDate: fixPack.meta?.nasrCycleDate || awyPack.meta?.nasrCycleDate || null,
      cifpCycleDate: procPack.meta?.cifpCycleDate || null,
    },
    fixes,
    navaids,
    airways,
    procedures,
    preferred,
  });
}

async function fetchPreferredRoutes(isoDate) {
  const preferred = {};
  const sources = isoDate
    ? [faaExtraZipUrl(isoDate, "PFR")]
    : [
        faaExtraZipUrl("2026-06-11", "PFR"),
        "https://nfdc.faa.gov/webContent/28DaySub/extra/11_Jun_2026_PFR_CSV.zip",
      ];
  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const dir = mkdtempSync(join(tmpdir(), "vatflow-pfr-"));
      try {
        const zipPath = join(dir, "pfr.zip");
        writeFileSync(zipPath, buf);
        execFileSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "pipe" });
        const rows = await readCsvFromDir(dir, "PFR_BASE.csv", "PFR.csv");
        Object.assign(preferred, buildPreferredFromRows(rows));
        if (Object.keys(preferred).length) break;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn("PFR fetch skipped:", e.message);
    }
  }
  return preferred;
}

function assembleNavData({ meta, fixes, navaids, airways, procedures, preferred }) {
  return {
    meta: {
      ...meta,
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

async function buildFromFaaCycle(isoDate) {
  const csvDir = await fetchFaaCycleCsvs(isoDate);
  try {
    console.log("Fetching @squawk airways/procedures (enroute data from prior 56-day cycle)…");
    const [awyPack, procPack] = await Promise.all([
      fetchGzJson(SQUAWK.airways),
      fetchGzJson(SQUAWK.procedures),
    ]);

    const fixRows = await readCsvFromDir(csvDir, "FIX_BASE.csv", "FIX.csv");
    const navRows = await readCsvFromDir(csvDir, "NAV_BASE.csv", "NAV.csv");
    const fixes = buildFixesFromRows(fixRows);
    const navaids = buildNavaidsFromRows(navRows);

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
        airways[des] = { t: des.charAt(0), w: wps };
      }
    }

    const procedures = {};
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

    const pfrRows = await readCsvFromDir(csvDir, "PFR_BASE.csv", "PFR.csv");
    const preferred = buildPreferredFromRows(pfrRows);

    return assembleNavData({
      meta: {
        source: `FAA NASR ${isoDate} (FIX/NAV/PFR) + @squawk airways/procedures`,
        nasrCycleDate: isoDate,
        cifpCycleDate: procPack.meta?.cifpCycleDate || null,
        enrouteCycleDate: awyPack.meta?.nasrCycleDate || null,
      },
      fixes,
      navaids,
      airways,
      procedures,
      preferred,
    });
  } finally {
    rmSync(csvDir, { recursive: true, force: true });
  }
}

async function buildFromNasrCsv(dir) {
  console.log(`Building from NASR CSV in ${dir}…`);
  const fixRows = await readCsvFromDir(dir, "FIX_BASE.csv", "FIX.csv");
  const navRows = await readCsvFromDir(dir, "NAV_BASE.csv", "NAV.csv");
  const awyRows = await readCsvFromDir(dir, "AWY_BASE.csv", "AWY.csv");
  const pfrRows = await readCsvFromDir(dir, "PFR_BASE.csv", "PFR.csv");

  const fixes = buildFixesFromRows(fixRows);
  const navaids = buildNavaidsFromRows(navRows);

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

  const preferred = buildPreferredFromRows(pfrRows);

  return assembleNavData({
    meta: {
      source: "NASR CSV",
      nasrCycleDate: null,
    },
    fixes,
    navaids,
    airways,
    procedures: {},
    preferred,
  });
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
  const cycleIdx = process.argv.indexOf("--faa-cycle");
  const faaCycle = cycleIdx >= 0 ? process.argv[cycleIdx + 1] : "2026-07-09";
  const data = nasrDir
    ? await buildFromNasrCsv(nasrDir)
    : cycleIdx >= 0
      ? await buildFromFaaCycle(faaCycle)
      : await buildFromSquawk();
  writeOutputs(data);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
