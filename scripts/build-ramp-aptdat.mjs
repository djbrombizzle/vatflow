#!/usr/bin/env node
/**
 * Enrich a built surface with X-Plane apt.dat startup locations.
 *
 * OSM knows where a stand is; apt.dat knows which way it faces, how big it is
 * and which airlines use it. This fills the gaps in a surface that already
 * exists — it never moves or renames a stand.
 *
 * The apt.dat file is read from a local path and never redistributed; only the
 * derived fields (heading, size code, operators, ops type) are written into the
 * committed surface.
 *
 * Usage:
 *   node scripts/build-ramp-aptdat.mjs --icao KATL --apt ~/X-Plane/.../apt.dat
 *   node scripts/build-ramp-aptdat.mjs --icao KATL --apt apt.dat --surface osm
 *   node scripts/build-ramp-aptdat.mjs --icao KATL --apt apt.dat --dry
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAptDat, mergeAptDat } from "../shared/ramp-aptdat.js";
import { makeProjection } from "../shared/ramp-airport.js";
import { FIELDS } from "../shared/ramp-app-fields.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "ramp");

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const icao = String(arg("icao", "KATL")).toUpperCase();
const aptPath = arg("apt");
const surface = arg("surface", "schematic");
const dry = !!arg("dry");

if (!aptPath || aptPath === true) {
  console.error("Give --apt <path to apt.dat>. The file is read locally and never committed.");
  process.exit(1);
}
if (!FIELDS[icao]) {
  console.error(`Unknown field ${ icao } — add it to shared/ramp-app-fields.mjs first.`);
  process.exit(1);
}

const modelPath = join(OUT_DIR, surface === "osm" ? `${ icao }.osm.json` : `${ icao }.json`);
if (!existsSync(modelPath)) {
  console.error(`No surface at ${ modelPath }. Build or export one first.`);
  process.exit(1);
}

const model = JSON.parse(readFileSync(modelPath, "utf8"));
const records = parseAptDat(readFileSync(aptPath, "utf8"), icao);

if (!records.length) {
  console.error(`No startup locations for ${ icao } in ${ aptPath }.`);
  process.exit(1);
}

const proj = makeProjection(FIELDS[icao].ref[0], FIELDS[icao].ref[1]);
const report = mergeAptDat(model, records, { proj });

console.log(`${ icao }: ${ records.length } startup locations in apt.dat, ${ model.stands.length } stands in the surface`);
console.table([report]);
if (report.unmatched) {
  console.warn(`  ${ report.unmatched } apt.dat locations matched no stand — the surface may be missing gates`);
}

const withOps = model.stands.filter(s => s.operators && s.operators.length).length;
console.log(`  ${ withOps }/${ model.stands.length } stands now name their operators`);

if (dry) {
  console.log("  --dry: nothing written");
} else {
  model.aptDatEnriched = new Date().toISOString();
  writeFileSync(modelPath, JSON.stringify(model));
  console.log(`  wrote ${ modelPath }`);
}
