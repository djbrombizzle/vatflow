#!/usr/bin/env node
/**
 * Build a RampView airport surface from OpenStreetMap.
 *
 * Queries Overpass for runways, taxiways, aprons, terminals and parking
 * positions around the field, projects everything into local metres about the
 * airport reference point, and writes data/ramp/<ICAO>.json.
 *
 * The page never calls Overpass on the critical path — it loads this file.
 * (The in-browser "Fetch surface" button exists for fields nobody has built
 * yet, and caches to IndexedDB rather than to the repo.)
 *
 * Usage:
 *   node scripts/build-ramp-airport.mjs --icao KATL
 *   node scripts/build-ramp-airport.mjs --icao KATL --osm /tmp/katl.json   (offline)
 *   node scripts/build-ramp-airport.mjs --all
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOverpass, fetchOverpass } from "../shared/ramp-osm.js";
import { applyOverrides, stampRamps, coverage } from "../shared/ramp-airport.js";
import { FIELDS } from "../shared/ramp-app-fields.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "ramp");

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

async function buildOne(icao) {
  const field = FIELDS[icao];
  if (!field) throw new Error("Unknown field " + icao + " — add it to shared/ramp-app-fields.mjs");

  const osmPath = arg("osm");
  let osm;
  if (typeof osmPath === "string") {
    console.log(`[${icao}] reading ${osmPath}`);
    osm = JSON.parse(readFileSync(osmPath, "utf8"));
  } else {
    console.log(`[${icao}] querying Overpass…`);
    osm = await fetchOverpass(field.ref, msg => console.log(`[${icao}] ${msg}`));
  }

  const model = parseOverpass(osm, { icao, ref: field.ref });
  model.elevFt = field.elevFt;
  model.name = field.name;

  const overridePath = join(OUT_DIR, "overrides", icao + ".json");
  const overrides = existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, "utf8")) : null;
  const merged = applyOverrides(stampRamps(model), overrides);
  const cov = coverage(merged);
  merged.coverage = cov;

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, icao + ".json");
  writeFileSync(out, JSON.stringify(merged));
  console.log(`[${icao}] wrote ${out}`);
  console.table([cov]);
  if (cov.noConcourse) console.warn(`[${icao}] ${cov.noConcourse} stands have no concourse — check stand ids`);
  if (cov.noRamp) console.warn(`[${icao}] ${cov.noRamp} stands have no ramp — extend "ramps" in the override file`);
  if (!cov.stands) console.warn(`[${icao}] NO STANDS FOUND — OSM coverage for this field may be missing`);
  return cov;
}

const icaos = arg("all") ? Object.keys(FIELDS) : [String(arg("icao", "KATL")).toUpperCase()];
for (const icao of icaos) {
  try {
    await buildOne(icao);
  } catch (err) {
    console.error(`[${icao}] build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
