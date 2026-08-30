#!/usr/bin/env node
/**
 * RampView OSM extraction: tags in, airport model out. Runs offline.
 * Usage: node scripts/test-ramp-osm.mjs
 */
import { parseOverpass, overpassQuery } from "../shared/ramp-osm.js";
import { applyOverrides, stampRamps, coverage } from "../shared/ramp-airport.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const REF = [33.6367, -84.4281];
const OSM = {
  elements: [
    // A stand drawn as a centreline: the aircraft ends up facing west.
    { type: "way", tags: { aeroway: "parking_position", ref: "D32", "aircraft:type": "B767" },
      geometry: [{ lat: 33.6400, lon: -84.4300 }, { lat: 33.6400, lon: -84.4310 }] },
    // A stand mapped as a bare node, with an operator and a direction.
    { type: "node", lat: 33.6410, lon: -84.4290,
      tags: { aeroway: "parking_position", ref: "C21", direction: "90", operator: "SWA" } },
    // Same stand mapped twice — the duplicate must be dropped.
    { type: "node", lat: 33.64101, lon: -84.42901, tags: { aeroway: "parking_position", ref: "C21" } },
    { type: "way", tags: { aeroway: "runway", ref: "09L/27R", width: "45" },
      geometry: [{ lat: 33.630, lon: -84.44 }, { lat: 33.630, lon: -84.41 }] },
    { type: "way", tags: { aeroway: "taxiway", ref: "B" },
      geometry: [{ lat: 33.638, lon: -84.44 }, { lat: 33.638, lon: -84.41 }] },
    { type: "way", tags: { aeroway: "apron" },
      geometry: [{ lat: 33.639, lon: -84.432 }, { lat: 33.642, lon: -84.432 }, { lat: 33.642, lon: -84.427 }] },
    { type: "way", tags: { building: "terminal" },
      geometry: [{ lat: 33.6405, lon: -84.4295 }, { lat: 33.6408, lon: -84.4295 }, { lat: 33.6408, lon: -84.4290 }] },
    // Not aviation — must be ignored.
    { type: "way", tags: { highway: "service" },
      geometry: [{ lat: 33.64, lon: -84.43 }, { lat: 33.641, lon: -84.43 }] },
  ],
};

const model = parseOverpass(OSM, { icao: "KATL", ref: REF });

assert(model.icao === "KATL", "icao carried through");
assert(model.stands.length === 2, "two stands, duplicate ref dropped (" + model.stands.length + ")");
assert(model.runways.length === 1 && model.taxiways.length === 1, "runway and taxiway extracted");
assert(model.aprons.length === 1 && model.buildings.length === 1, "apron and terminal extracted");
assert(model.attribution.includes("OpenStreetMap"), "attribution recorded");

const d32 = model.stands.find(s => s.id === "D32");
assert(d32.hdg === 270, "centreline gives the parked heading (got " + d32.hdg + ")");
assert(d32.sizeCode === "E", "a 767 stand is code E");
assert(d32.poly.length === 4, "a polygon is synthesised for a stand mapped as a line");

const c21 = model.stands.find(s => s.id === "C21");
assert(c21.hdg === 90, "node direction tag used as the heading");
assert(c21.operators.join() === "SWA", "operator tag parsed to an ICAO code");
assert(c21.sizeCode === "C", "unknown size defaults to code C");

/* stands are sorted naturally, not lexically */
const ids = model.stands.map(s => s.id);
assert(ids.join() === "C21,D32", "stands sorted");

/* overrides supply ramps and blocks; geometry always comes from the build */
const overrides = {
  ramps: [{ id: "R3", label: "Ramp 3", concourses: ["C", "D"] }],
  operatorBlocks: { SWA: { concourses: ["C"] } },
};
const merged = applyOverrides(stampRamps(model), overrides);
assert(merged.stands.every(s => s.ramp === "R3"), "ramp stamped onto stands from the concourse");
assert(merged.stands.find(s => s.id === "D32").concourse === "D", "concourse derived from the stand id");
assert(merged.operatorBlocks.SWA.concourses[0] === "C", "operator blocks come from the override file");

const cov = coverage(merged);
assert(cov.stands === 2 && cov.noRamp === 0 && cov.noPoly === 0, "coverage report is accurate");
assert(cov.noOperators === 1, "coverage counts stands with no operator tags");

/* the query itself */
const q = overpassQuery(REF);
assert(q.includes("parking_position") && q.includes("out body geom"), "query asks for stands with geometry");
assert(/33\.5\d+,-84\.5\d+,33\.7\d+,-84\.3\d+/.test(q), "bbox brackets the field");

/* the committed KATL override file must stay valid and consistent */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const katl = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "overrides", "KATL.json"), "utf8"));
const rampConcourses = new Set(katl.ramps.flatMap(r => r.concourses));
for (const c of Object.keys(katl.concourses)) {
  assert(rampConcourses.has(c), "concourse " + c + " belongs to a ramp");
}
for (const [op, entry] of Object.entries(katl.operatorBlocks)) {
  for (const c of [...(entry.concourses || []), ...(entry.intl || [])]) {
    assert(katl.concourses[c], `${op} block references a real concourse (${c})`);
  }
  if (entry.inherits) assert(katl.operatorBlocks[entry.inherits], `${op} inherits a block that exists`);
}

console.log(`ramp-osm: ${passed} assertions passed`);
