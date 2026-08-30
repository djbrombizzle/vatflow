#!/usr/bin/env node
/**
 * The generated KIAD surface: gate inventory, ramp ownership by taxilane, and
 * the allocator running against the real field.
 * Usage: node scripts/test-ramp-kiad.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignStand } from "../shared/ramp-alloc.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "KIAD.json"), "utf8"));
const by = id => M.stands.find(s => s.id === id);

/* inventory */
assert(M.icao === "KIAD", "icao");
assert(M.stands.length > 130 && M.stands.length < 170, "gate count is in range (" + M.stands.length + ")");
const ids = M.stands.map(s => s.id);
assert(new Set(ids).size === ids.length, "no duplicate stand ids");
assert(M.stands.every(s => s.ramp), "every stand belongs to a ramp");
assert(M.stands.every(s => s.poly && s.poly.length === 4), "every stand has a footprint");

/* gates the chart lists exist */
for (const id of ["Z6", "Z14", "B79", "B37", "B78", "B38", "A31", "A14", "A1A", "A6E",
                  "D29A", "D1", "D32B", "D2", "C27A", "C1", "C28", "C2", "R28", "R3"]) {
  assert(ids.includes(id), "chart gate " + id + " exists");
}
/* and ones it does not are not invented */
for (const id of ["B60", "A33", "C30", "D34", "Z1", "R40"]) {
  assert(!ids.includes(id), "gate " + id + " is not invented");
}

/* the three ramp areas, with the chart's frequencies */
const ramp = id => M.ramps.find(r => r.id === id);
assert(M.ramps.length === 3, "three ramp areas");
assert(ramp("RN").freq === "119.12" && ramp("RN").label === "North Area Ramp", "North Area Ramp 119.12");
assert(ramp("RM").freq === "129.55" && ramp("RM").label === "Midfield Area Ramp", "Midfield Area Ramp 129.55");
assert(ramp("RS").freq === "130.55" && ramp("RS").label === "South Area Ramp", "South Area Ramp 130.55");
assert(ramp("RN").lanes === "Taxilanes A & B", "North works taxilanes A and B");
assert(ramp("RM").lanes === "Taxilanes C & D", "Midfield works taxilanes C and D");
assert(ramp("RS").lanes === "Taxilanes E & F", "South works taxilanes E and F");

/* ownership runs down the taxilane, so one building answers to two ramps */
assert(by("B79").face === "N" && by("B79").ramp === "RN", "the north face of B is the North ramp");
assert(by("B78").face === "S" && by("B78").ramp === "RM", "the south face of B is the Midfield ramp");
assert(by("A31").ramp === "RN" && by("A32").ramp === "RM", "A splits the same way");
assert(by("D1").ramp === "RM" && by("D2").ramp === "RS", "the D building splits Midfield / South");
assert(by("C1").ramp === "RM" && by("C2").ramp === "RS", "and so does C");
assert(by("Z6").ramp === "RN", "the Main Terminal Z gates are the North ramp");
assert(by("R28").ramp === "RS", "the R Ramp hardstands are the South ramp");

/* geometry: the two faces of a building point at each other */
assert(by("B79").hdg === 180 && by("B78").hdg === 0, "aircraft face the concourse");
const gap = Math.abs(by("B79").point[1] - by("B78").point[1]);
assert(gap > 20 && gap < 60, "the building sits between the faces (" + gap.toFixed(0) + " m)");

/* runways */
assert(M.runways.length === 4, "four runways");
for (const id of ["01L/19R", "01C/19C", "01R/19L", "12/30"]) {
  assert(M.runways.some(r => r.id === id), "runway " + id + " is present");
}

/* the allocator against the real field */
const ctx = () => ({
  operatorBlocks: M.operatorBlocks,
  occupancy: new Set(), closures: new Set(), blocked: new Set(), reservations: new Map(),
  nowMs: Date.UTC(2026, 7, 30, 12, 0, 0),
});

const ual = new Set();
for (let i = 0; i < 120; i++) {
  const r = assignStand({ callsign: "UAL" + (1000 + i), sizeCode: "C" }, M.stands, ctx());
  assert(r.standId && "CD".includes(r.standId[0]), "United draws the C/D midfield");
  ual.add(r.standId);
}
assert(ual.size >= 15, "the draw spreads across United's block (" + ual.size + " stands)");

for (let i = 0; i < 30; i++) {
  const r = assignStand({ callsign: "GJS" + (100 + i), sizeCode: "B" }, M.stands, ctx());
  assert(r.standId && "CD".includes(r.standId[0]), "United Express inherits United's block");
}
for (let i = 0; i < 30; i++) {
  const r = assignStand({ callsign: "AAL" + (100 + i), sizeCode: "C" }, M.stands, ctx());
  assert(r.standId && r.standId.startsWith("B"), "American draws concourse B");
}
const ba = assignStand({ callsign: "BAW216", sizeCode: "E", intl: true }, M.stands, ctx());
assert(ba.standId && ba.standId.startsWith("D"), "British Airways draws concourse D");
const af = assignStand({ callsign: "AFR38", sizeCode: "E", intl: true }, M.stands, ctx());
assert(af.standId && af.standId.startsWith("A"), "Air France draws concourse A");

/* remote hardstands are never drawn for an ordinary arrival */
const remote = M.stands.filter(s => s.opsType === "remote");
assert(remote.length >= 10, "the R Ramp is modelled as remote parking");
let drewRemote = 0;
for (let i = 0; i < 200; i++) {
  const r = assignStand({ callsign: "UAL" + (5000 + i), sizeCode: "C" }, M.stands, ctx());
  if (remote.some(s => s.id === r.standId)) drewRemote++;
}
assert(drewRemote === 0, "no arrival is parked on a hardstand by the draw");
let unmappedRemote = 0;
for (let i = 0; i < 100; i++) {
  const r = assignStand({ callsign: "GLO" + (100 + i), sizeCode: "C" }, M.stands, ctx());
  if (remote.some(s => s.id === r.standId)) unmappedRemote++;
}
assert(unmappedRemote === 0, "not even an unmapped carrier lands on a hardstand");

console.log(`ramp-kiad: ${passed} assertions passed · ${M.stands.length} stands across ${M.ramps.length} ramps`);
