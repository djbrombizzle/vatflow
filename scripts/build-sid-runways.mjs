#!/usr/bin/env node
/**
 * Build a compact SID -> departure runway index for taxi-time estimation.
 *
 * data/nav/procedures.json is ~2 MB — far too heavy for a page that only needs
 * "which runways can fly this SID". This flattens the SID runway transitions
 * (keys look like RW09L, RW08B, RWALL) into ICAO -> { SID: [runway, ...] }.
 *
 * A SID with an empty array has no runway transitions published; the estimator
 * falls back to the nearest active departure runway for those.
 *
 * Usage: node scripts/build-sid-runways.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "data", "nav", "procedures.json");
const OUT = join(ROOT, "data", "nav", "sid-runways.json");

const procedures = JSON.parse(readFileSync(SRC, "utf8"));
const out = {};
let sids = 0;

for (const [name, proc] of Object.entries(procedures)) {
  if (!proc || proc.type !== "SID") continue;
  sids++;
  const runways = Object.keys(proc.transitions || {})
    .filter(k => /^RW/.test(k))
    .map(k => k.slice(2))
    .sort();
  for (const apt of proc.apt || []) {
    (out[apt] ||= {})[name] = runways;
  }
}

const sorted = {};
for (const apt of Object.keys(out).sort()) sorted[apt] = out[apt];

writeFileSync(OUT, JSON.stringify(sorted) + "\n");
const kb = (JSON.stringify(sorted).length / 1024).toFixed(1);
console.log(`sid-runways.json: ${sids} SIDs across ${Object.keys(sorted).length} airports (${kb} KB)`);
