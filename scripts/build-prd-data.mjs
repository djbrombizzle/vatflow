#!/usr/bin/env node
/**
 * Build FAA Preferred Routes (PRD) data for the EDST Route Menu's "Apply ATC Preferred Route" list.
 *
 * Source: the FAA National Preferred Routes database, https://www.fly.faa.gov/rmt/data_file/prefroutes_db.csv
 * (Orig, Route String, Dest, Hours1-3, Type, Area, Altitude, Aircraft, Direction, Seq, DCNTR, ACNTR).
 * Saved at data/source/prefroutes_db.csv. The FAA updates it every 56 days: download it again and rerun.
 *
 * Output: data/prd/to-<DEST>.json, one file per destination (the Route Menu looks routes up by the flight's
 * destination). Rows: [orig, route, type, altitude, aircraft, hours, direction, area, seq].
 *
 * Usage:
 *   node scripts/build-prd-data.mjs
 *   node scripts/build-prd-data.mjs --csv /path/to/prefroutes_db.csv
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "prd");
const DEFAULT_CSV = join(ROOT, "data", "source", "prefroutes_db.csv");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const raw = readFileSync(arg("--csv", DEFAULT_CSV), "utf8").replace(/^﻿/, "");
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(",");
const EXPECTED = ["Orig", "Route String", "Dest", "Hours1", "Hours2", "Hours3", "Type", "Area", "Altitude", "Aircraft", "Direction", "Seq"];
EXPECTED.forEach((name, i) => {
  if (header[i] !== name) throw new Error(`unexpected column ${i}: got "${header[i]}", want "${name}"`);
});

// Plain CSV with quoted fields that may hold commas.
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const byDest = new Map();
let n = 0;
for (let i = 1; i < lines.length; i++) {
  const f = splitCsv(lines[i]);
  if (f.length < EXPECTED.length) throw new Error(`row ${i + 1}: ${f.length} fields`);
  const [orig, route, dest, h1, h2, h3, type, area, alt, acft, dir, seq] = f.map((x) => x.trim().toUpperCase());
  if (!orig || !dest || !route || !/^[A-Z0-9]{2,6}$/.test(dest)) continue;
  const toks = route.split(/\s+/).filter(Boolean).join(" ");
  const hours = [h1, h2, h3].filter(Boolean).join(" ");
  const list = byDest.get(dest) || byDest.set(dest, []).get(dest);
  list.push([orig, toks, type, alt, acft, hours, dir, area, parseInt(seq, 10) || 0]);
  n++;
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const [dest, list] of byDest) {
  const body = JSON.stringify(list);
  writeFileSync(join(OUT_DIR, `to-${dest}.json`), body);   // "to-": CON, PRN, AUX... are reserved names on Windows
  total += body.length;
}
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10), source: "FAA prefroutes_db", routes: n,
  dests: [...byDest.keys()].sort(),
}));
console.log(`PRD data written to data/prd/: ${n} routes, ${byDest.size} destinations, ${(total / 1048576).toFixed(2)} MB`);
