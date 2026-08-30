#!/usr/bin/env node
/**
 * The generated KATL surface: gate inventory, face-level ramp ownership, and
 * the allocator running against the real field.
 * Usage: node scripts/test-ramp-katl.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignStand } from "../shared/ramp-alloc.js";
import { matchStand } from "../shared/ramp-stands.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "KATL.json"), "utf8"));

/* inventory */
assert(M.icao === "KATL", "icao");
assert(M.stands.length > 190 && M.stands.length < 215, "roughly the real gate count (" + M.stands.length + ")");
const ids = M.stands.map(s => s.id);
assert(new Set(ids).size === ids.length, "no duplicate stand ids");
assert(M.stands.every(s => s.ramp), "every stand belongs to a ramp");
assert(M.stands.every(s => s.concourse), "every stand belongs to a concourse");
assert(M.stands.every(s => s.poly && s.poly.length === 4), "every stand has a footprint");
assert(M.ramps.length === 8 && M.ramps.every(r => r.freq), "eight ramps, each with a frequency");
assert(M.spots.length >= 16, "hold spots present");
assert(M.areas.some(a => a.kind === "nonmovement"), "non-movement boundary present");

/* the gates the chart lists actually exist */
for (const id of ["T1A", "T21", "A1", "A34", "B36", "B1", "C55", "C1", "D46", "D1A", "E37", "E1", "F14", "F1", "D40A", "E33A"]) {
  assert(ids.includes(id), "chart gate " + id + " exists");
}
/* and the ones it does not list do not */
for (const id of ["A22", "B8", "C48", "T22", "F13"]) {
  assert(!ids.includes(id), "gate " + id + " is not invented");
}

/* face-level ramp ownership — the ATL boundary runs down the alley, not the
   concourse, so the two faces of one concourse answer to different ramps */
const by = id => M.stands.find(s => s.id === id);
assert(by("A20").face === "W" && by("A20").ramp === "R1", "A west face is Ramp 1");
assert(by("A19").face === "E" && by("A19").ramp === "R2", "A east face is Ramp 2");
assert(by("B36").ramp === "R2" && by("B33").ramp === "R3", "B splits between Ramp 2 and Ramp 3");
assert(by("C52").ramp === "R3" && by("C55").ramp === "R4", "C splits between Ramp 3 and Ramp 4");
assert(by("D46").ramp === "R4" && by("D41").ramp === "R5", "D splits between Ramp 4 and Ramp 5");
assert(by("E36").ramp === "R5" && by("E37").ramp === "R6", "E splits between Ramp 5 and Ramp 6");
assert(by("F14").ramp === "R8" && by("F9").ramp === "R9", "F splits between Ramp 8 and Ramp 9");
assert(by("T1A").ramp === "R1", "concourse T is Ramp 1");

/* frequencies as published */
const freq = id => M.ramps.find(r => r.id === id).freq;
assert(freq("R1") === "131.45" && freq("R2") === "131.85", "Ramp 1 and 2 frequencies");
assert(freq("R3") === "129.275" && freq("R4") === "130.075", "Ramp 3 and 4 frequencies");
assert(freq("R5") === "129.375" && freq("R6") === "131.375", "Ramp 5 and 6 frequencies");
assert(freq("R8") === "128.975" && freq("R9") === "131.875", "Ramp 8 and 9 frequencies");

/* geometry: the two faces of a concourse point at each other */
assert(by("A20").hdg === 90 && by("A19").hdg === 270, "aircraft face the concourse");
const gap = Math.abs(by("A20").point[0] - by("A19").point[0]);
assert(gap > 20 && gap < 60, "the concourse building sits between the faces (" + gap.toFixed(0) + " m)");

/* a target parked on a stand matches that stand and no other */
const a20 = by("A20");
const hit = matchStand(a20.point[0] - 12, a20.point[1], 90, M.stands);
assert(hit && hit.stand.id === "A20", "a parked target matches its own stand");
assert(hit.confidence === "high", "and does so unambiguously");

/* the allocator against the real field */
const ctx = () => ({
  operatorBlocks: M.operatorBlocks,
  occupancy: new Set(),
  closures: new Set(),
  blocked: new Set(),
  reservations: new Map(),
  nowMs: Date.UTC(2026, 7, 30, 12, 0, 0),
});

const swa = new Set();
for (let i = 0; i < 150; i++) {
  const r = assignStand({ callsign: "SWA" + (1000 + i), sizeCode: "C" }, M.stands, ctx());
  assert(r.standId && r.standId.startsWith("C"), "Southwest draws onto concourse C");
  assert(parseInt(r.standId.slice(1), 10) <= 22, "Southwest stays within C1-C22");
  swa.add(r.standId);
}
assert(swa.size >= 12, "the draw spreads across Southwest's block (" + swa.size + " stands)");

for (let i = 0; i < 40; i++) {
  const r = assignStand({ callsign: "AAL" + (100 + i), sizeCode: "C" }, M.stands, ctx());
  assert(r.standId && r.standId.startsWith("T"), "American draws onto concourse T");
}

const dal = new Set();
for (let i = 0; i < 200; i++) {
  const r = assignStand({ callsign: "DAL" + (1000 + i), sizeCode: "C" }, M.stands, ctx());
  assert(r.standId, "Delta always gets a stand");
  dal.add(r.standId[0]);
}
assert(dal.has("T") && dal.has("B") && dal.has("D"), "Delta spreads across its concourses");
assert(!dal.has("F"), "a domestic Delta flight does not draw an international stand");

const intl = assignStand({ callsign: "DAL450", sizeCode: "E", intl: true }, M.stands, ctx());
assert(intl.standId && "EF".includes(intl.standId[0]), "a Delta international arrival draws E or F");

/* ramp counts are plausible for a real bank */
const perRamp = {};
for (const s of M.stands) perRamp[s.ramp] = (perRamp[s.ramp] || 0) + 1;
for (const r of M.ramps) assert(perRamp[r.id] > 0, r.id + " owns at least one stand");

console.log(`ramp-katl: ${passed} assertions passed · ${M.stands.length} stands across ${M.ramps.length} ramps`);
