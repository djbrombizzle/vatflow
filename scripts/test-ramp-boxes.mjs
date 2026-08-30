#!/usr/bin/env node
/**
 * Stand boxes fit the gaps they actually have, so a dense pier reads as gates
 * rather than a smear.
 * Usage: node scripts/test-ramp-boxes.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fitStandBoxes, synthStandPoly, standBox } from "../shared/ramp-airport.js";
import { parseOverpass } from "../shared/ramp-osm.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const bbox = poly => ({
  x0: Math.min(...poly.map(p => p[0])), x1: Math.max(...poly.map(p => p[0])),
  y0: Math.min(...poly.map(p => p[1])), y1: Math.max(...poly.map(p => p[1])),
});
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
function overlapPairs(stands) {
  const boxes = stands.map(s => bbox(s.poly));
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) n++;
  }
  return n;
}

/* a row packed tighter than the nominal box */
const row = [];
for (let i = 0; i < 8; i++) row.push({ id: "A" + i, point: [i * 25, 0], hdg: 90, sizeCode: "C" });
const nominal = row.map(s => ({ ...s, poly: synthStandPoly(s.point, s.hdg, s.sizeCode) }));
assert(overlapPairs(nominal) > 0, "nominal boxes do overlap at 25 m spacing — that is the bug");
fitStandBoxes(row);
assert(overlapPairs(row) === 0, "fitted boxes do not overlap");
assert(row.every(s => s.boxScale < 1), "and every box was shrunk to fit");
assert(row.every(s => s.boxScale >= 0.4), "but none below the floor — a gate is never a dot");

/* a stand with room keeps its full size */
const roomy = [{ id: "X1", point: [0, 0], hdg: 90, sizeCode: "C" }, { id: "X2", point: [400, 0], hdg: 90, sizeCode: "C" }];
fitStandBoxes(roomy);
assert(roomy[0].boxScale === 1, "a stand with space is drawn at full size");

/* a bigger aircraft still gets a bigger box where there is room for one */
const mixed = [
  { id: "M1", point: [0, 0], hdg: 90, sizeCode: "C" },
  { id: "M2", point: [0, 300], hdg: 90, sizeCode: "E" },
  { id: "M3", point: [0, 600], hdg: 90, sizeCode: "C" },
];
fitStandBoxes(mixed);
const widthOf = s => bbox(s.poly).y1 - bbox(s.poly).y0;
assert(widthOf(mixed[1]) > widthOf(mixed[0]), "a code-E stand is drawn larger than a code-C one");

/* a stand with no mapped heading gets a square, not a long box pointing north */
const noHdg = [{ id: "N1", point: [0, 0], hdg: 0, sizeCode: "C", hdgKnown: false }];
fitStandBoxes(noHdg);
const b = bbox(noHdg[0].poly);
assert(Math.abs((b.x1 - b.x0) - (b.y1 - b.y0)) < 0.5, "an unmapped heading draws a square box");

/* the committed schematic ships fitted */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "KATL.json"), "utf8"));
assert(overlapPairs(M.stands) === 0, "no two stands overlap on the committed KATL surface");
assert(M.stands.every(s => typeof s.boxScale === "number"), "every stand records the scale it was drawn at");

/* and an OSM surface is fitted as it is parsed */
const osm = { elements: [] };
for (let i = 0; i < 10; i++) {
  osm.elements.push({
    type: "node", lat: 33.6400 + i * 0.0002, lon: -84.4300,
    tags: { aeroway: "parking_position", ref: "D" + i, direction: "270" },
  });
}
const parsed = parseOverpass(osm, { icao: "KATL", ref: [33.6367, -84.4281] });
assert(parsed.stands.length === 10, "stands parsed");
assert(overlapPairs(parsed.stands) === 0, "an OSM surface comes back fitted, not overlapping");
assert(standBox("E")[0] > standBox("C")[0], "the nominal size table still scales with aircraft code");

console.log(`ramp-boxes: ${passed} assertions passed`);
