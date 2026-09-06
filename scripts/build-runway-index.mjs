#!/usr/bin/env node
/**
 * Build a compact runway threshold index for taxi-time estimation.
 *
 * Source: OurAirports runways.csv — the same file runway-balancer.html fetches
 * live. Caching it here keeps IDST from pulling ~1 MB of CSV on first RDY;
 * shared/taxi-runways.js prefers this file and falls back to the live fetch
 * when it is absent, so the build is an optimization, not a dependency.
 *
 * Requires network access to davidmegginson.github.io.
 *
 * Usage: node scripts/build-runway-index.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "nav", "runways.json");
const SRC = "https://davidmegginson.github.io/ourairports-data/runways.csv";

/** Airports we estimate taxi times for: US/Canada scheduled fields. */
const IDENT_RE = /^(K[A-Z]{3}|C[YZ][A-Z]{2}|P[AH][A-Z]{2})$/;

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeRunway(id) {
  const s = String(id || "").trim().toUpperCase().replace(/^RW/, "");
  const m = /^(\d{1,2})([LCRB]?)$/.exec(s);
  if (!m) return "";
  const num = parseInt(m[1], 10);
  if (!(num >= 1 && num <= 36)) return "";
  return String(num).padStart(2, "0") + m[2];
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`fetch runways.csv: HTTP ${res.status}`);
const csv = await res.text();

const lines = csv.split("\n");
const header = splitCsvLine(lines[0]).map(h => h.trim());
const col = name => header.indexOf(name);
const cIdent = col("airport_ident");
const cClosed = col("closed");
const cLen = col("length_ft");
const ENDS = [
  { ident: col("le_ident"), lat: col("le_latitude_deg"), lon: col("le_longitude_deg"), hdg: col("le_heading_degT") },
  { ident: col("he_ident"), lat: col("he_latitude_deg"), lon: col("he_longitude_deg"), hdg: col("he_heading_degT") },
];
if (cIdent < 0 || ENDS.some(e => e.ident < 0 || e.lat < 0)) {
  throw new Error("runways.csv header changed — column names no longer match");
}

const out = {};
let ends = 0;
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const c = splitCsvLine(lines[i]);
  const apt = (c[cIdent] || "").toUpperCase();
  if (!IDENT_RE.test(apt) || c[cClosed] === "1") continue;
  const lenFt = parseInt(c[cLen], 10) || 0;
  for (const e of ENDS) {
    const id = normalizeRunway(c[e.ident]);
    const lat = parseFloat(c[e.lat]);
    const lon = parseFloat(c[e.lon]);
    if (!id || !isFinite(lat) || !isFinite(lon)) continue;
    const hdg = parseFloat(c[e.hdg]);
    (out[apt] ||= []).push([
      id,
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
      isFinite(hdg) ? Math.round(hdg) : (parseInt(id, 10) || 0) * 10,
      lenFt,
    ]);
    ends++;
  }
}

const sorted = {};
for (const apt of Object.keys(out).sort()) sorted[apt] = out[apt];
writeFileSync(OUT, JSON.stringify(sorted) + "\n");
const kb = (JSON.stringify(sorted).length / 1024).toFixed(0);
console.log(`runways.json: ${ends} ends across ${Object.keys(sorted).length} airports (${kb} KB)`);
