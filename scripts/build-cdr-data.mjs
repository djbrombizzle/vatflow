#!/usr/bin/env node
/**
 * Build compact FAA Coded Departure Route (CDR) data for the vUSAlink
 * clearance tab.
 *
 * Source: the FAA CDR "codedswap_db.csv" export (RCode, Orig, Dest, DepFix,
 * Route String, DCNTR, ACNTR, TCNTRs, CoordReq, Play, NavEqp).
 *
 * The full database is ~41k routes / ~5 MB, far too large to load eagerly in
 * the browser, so it is sharded one file per origin airport (largest ~110 KB).
 * Every RCode is 8 characters and its first three map 1:1 onto the origin, so a
 * typed code resolves to its shard through the tiny index without a lookup
 * table of every code.
 *
 * Usage:
 *   node scripts/build-cdr-data.mjs
 *   node scripts/build-cdr-data.mjs --csv /path/to/codedswap_db.csv
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "cdr");
const DEFAULT_CSV = join(ROOT, "data", "source", "codedswap_db.csv");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg("--csv", DEFAULT_CSV);
const raw = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(",");
const EXPECTED = ["RCode", "Orig", "Dest", "DepFix", "Route String"];
EXPECTED.forEach((name, i) => {
  if (header[i] !== name) {
    throw new Error(`unexpected column ${i}: got "${header[i]}", want "${name}"`);
  }
});

// Route strings in this export never contain a comma or quote, so a plain split
// is safe. Bail loudly if that ever stops being true.
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(",");
  if (f.length !== header.length) {
    throw new Error(`row ${i + 1}: expected ${header.length} fields, got ${f.length}`);
  }
  rows.push(f);
}

const byOrig = new Map();
const prefixToOrig = new Map();
const seenCodes = new Set();

for (const [code, orig, dest, depFix, route, , , , coordReq, play, navEqp] of rows) {
  if (code.length !== 8) throw new Error(`RCode "${code}" is not 8 characters`);
  if (seenCodes.has(code)) throw new Error(`duplicate RCode "${code}"`);
  seenCodes.add(code);

  const prefix = code.slice(0, 3);
  const known = prefixToOrig.get(prefix);
  if (known && known !== orig) {
    throw new Error(`RCode prefix "${prefix}" maps to both ${known} and ${orig}`);
  }
  prefixToOrig.set(prefix, orig);

  // Strip the implied origin/destination so the stored string is the portion
  // that actually goes in a clearance. The UI re-adds nothing; CLEARED TO THE
  // <DEST> ARPT already carries the destination.
  const tokens = route.split(/\s+/).filter(Boolean);
  if (tokens[0] === orig) tokens.shift();
  if (tokens[tokens.length - 1] === dest) tokens.pop();

  const dests = byOrig.get(orig) || byOrig.set(orig, new Map()).get(orig);
  const list = dests.get(dest) || dests.set(dest, []).get(dest);
  // [code, depFix, route, navEqp, coordReq, play]. The full code is kept rather
  // than a suffix: the last two characters repeat across destinations (ATLMCOGA
  // and ATLJFKGA both end "GA"), so a suffix alone would not identify a route.
  list.push([code, depFix, tokens.join(" "), navEqp || "", coordReq || "", play || ""]);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let totalBytes = 0;
let largest = { orig: "", bytes: 0 };
for (const [orig, dests] of byOrig) {
  const body = JSON.stringify(Object.fromEntries([...dests].sort((a, b) => a[0].localeCompare(b[0]))));
  writeFileSync(join(OUT_DIR, `${orig}.json`), body);
  totalBytes += body.length;
  if (body.length > largest.bytes) largest = { orig, bytes: body.length };
}

const index = {
  generated: new Date().toISOString().slice(0, 10),
  source: "FAA CDR codedswap_db",
  routes: rows.length,
  // 3-letter RCode prefix -> origin ICAO, so a typed code finds its shard.
  prefix: Object.fromEntries([...prefixToOrig].sort((a, b) => a[0].localeCompare(b[0]))),
};
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index));

const files = readdirSync(OUT_DIR).length;
console.log(`CDR data written to data/cdr/`);
console.log(`  routes:  ${rows.length}`);
console.log(`  origins: ${byOrig.size} (${files} files incl. index)`);
console.log(`  total:   ${(totalBytes / 1048576).toFixed(2)} MB`);
console.log(`  largest: ${largest.orig}.json ${(largest.bytes / 1024).toFixed(0)} KB`);
