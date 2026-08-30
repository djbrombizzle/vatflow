#!/usr/bin/env node
/**
 * Ground's question: which ramp is this arrival going to, where does it enter,
 * and what frequency do I send it to.
 * Usage: node scripts/test-ramp-ground.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entrySpot, groundInbounds, rampColor, GROUND_PHASES } from "../shared/ramp-ground.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "KATL.json"), "utf8"));

/* every spot names its ramp, or ground cannot route to it */
assert(M.spots.every(s => s.ramp), "every hold spot names its ramp");
assert(M.spots.some(s => s.id === "3N" && s.ramp === "R3"), "3N belongs to Ramp 3");
assert(M.spots.some(s => s.id === "8W" && s.ramp === "R8"), "8W belongs to Ramp 8");

/* entry end follows the aircraft, and flips as it rolls out the other way */
const north = entrySpot({ x: -750, y: 900 }, "R3", M.spots);
const south = entrySpot({ x: -750, y: -1100 }, "R3", M.spots);
assert(north.spot.id === "3N", "an arrival north of the complex enters at 3N");
assert(south.spot.id === "3S", "the same stand off a south runway enters at 3S");
assert(north.distM > 0 && south.distM > 0, "the distance to the spot is reported");
assert(entrySpot({ x: 0, y: 0 }, "R7", M.spots) === null, "a ramp with no spots returns nothing");

/* the ground list */
const stand = M.stands.find(s => s.id === "C30");
assert(stand && stand.ramp === "R3", "C30 sits on Ramp 3");

const target = (callsign, phase, x, y) => ({
  callsign, phase, arr: "KATL", dispX: x, dispY: y, type: "B738", standId: null,
});
const rows = groundInbounds({
  targets: [
    target("DAL100", "TAXI_IN", -700, -1100),
    target("DAL200", "INBOUND", -700, -14000),
    target("DAL300", "TAXI_OUT", -700, -1100),          // a departure, not ground's inbound problem
    { ...target("DAL400", "TAXI_IN", -700, -1100), standId: "C28" },  // already in block
    { ...target("DAL500", "TAXI_IN", -700, -1100), arr: "KBOS" },     // not landing here
  ],
  assignments: new Map([
    ["DAL100", { standId: "C30" }],
    ["DAL200", { standId: "C34" }],
    ["DAL300", { standId: "C36" }],
    ["DAL400", { standId: "C28" }],
    ["DAL500", { standId: "C38" }],
  ]),
  model: M,
});

const ids = rows.map(r => r.callsign);
assert(ids.includes("DAL100"), "a taxiing arrival is listed");
assert(ids.includes("DAL200"), "an arrival still airborne is listed, so the handoff can be planned");
assert(!ids.includes("DAL300"), "a departure is not ground's ramp-entry problem");
assert(!ids.includes("DAL400"), "an aircraft already on its stand drops off the list");
assert(!ids.includes("DAL500"), "an aircraft landing elsewhere is not listed");
assert(ids[0] === "DAL100", "aircraft already on the surface come first — they need the instruction now");

const r100 = rows.find(r => r.callsign === "DAL100");
assert(r100.ramp === "R3", "the ramp comes from the assigned gate");
assert(r100.rampLabel === "Ramp 3", "with its label");
assert(r100.freq === "129.275", "and the frequency ground reads out");
assert(r100.spot === "3S", "and the spot it enters through");
assert(typeof r100.spotDistM === "number", "and how far away that spot is");
assert(r100.gate === "C30", "and the gate itself");
assert(r100.onSurface === true, "taxiing counts as on the surface");
assert(r100.unassigned === false, "an assigned arrival is not flagged unassigned");

/* an arrival with no stand yet is still listed, flagged, so ground can chase it */
const noStand = groundInbounds({
  targets: [target("DAL700", "TAXI_IN", -700, -1100)],
  assignments: new Map(),
  model: M,
});
assert(noStand.length === 1 && noStand[0].unassigned, "an unassigned arrival is listed and flagged");
assert(noStand[0].ramp === null && noStand[0].spot === null, "with no ramp or spot invented");

/* ramp colours are distinct, so the field view reads as flow */
const colors = new Set(["R1", "R2", "R3", "R4", "R5", "R6", "R8", "R9"].map(rampColor));
assert(colors.size === 8, "every ramp has its own colour");
assert(rampColor(null) === rampColor("nope"), "an unknown ramp falls back to one neutral colour");

assert(GROUND_PHASES.has("INBOUND") && GROUND_PHASES.has("TAXI_IN") && !GROUND_PHASES.has("IN_BLOCK"),
  "ground phases cover the arrival, not the turn");

console.log(`ramp-ground: ${passed} assertions passed`);
