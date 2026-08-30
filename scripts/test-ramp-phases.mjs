#!/usr/bin/env node
/**
 * A departure is a departure — at the gate, pushing, taxiing or held.
 * Usage: node scripts/test-ramp-phases.mjs
 */
import { TrafficStore, nextPhase } from "../shared/ramp-traffic.js";
import { makeProjection } from "../shared/ramp-airport.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const REF = [33.6367, -84.4281];
const proj = makeProjection(REF[0], REF[1]);
const store = () => new TrafficStore({ icao: "KATL", proj, ref: REF, elevFt: 1026 });
const pilot = (cs, gs, dep, arr, alt = 1026) => ({
  callsign: cs, latitude: 33.64, longitude: -84.43, heading: 270,
  groundspeed: gs, altitude: alt,
  flight_plan: { departure: dep, arrival: arr, aircraft_short: "B739", route: "PENCL2 RMG" },
});

/* the reported bug: two departures sitting on their gates */
const s = store();
s.ingest({ pilots: [
  pilot("DAL3996", 0, "KATL", "KBOS"),
  pilot("DAL2634", 0, "KATL", "KMCO"),
  pilot("DAL1000", 0, "KBOS", "KATL"),
] }, Date.now());

const spot = s.departures().map(t => t.callsign);
assert(spot.includes("DAL3996"), "a departure on its gate is in the spot list");
assert(spot.includes("DAL2634"), "and so is the second one");
assert(!spot.includes("DAL1000"), "an arrival that parked is not");
assert(s.targets.get("DAL3996").phase === "TURN", "a stationary outbound aircraft is mid-turn");
assert(s.targets.get("DAL1000").phase === "IN_BLOCK", "a stationary inbound one is in block");

/* every stage of a departure stays a departure */
for (const [label, gs] of [["on the gate", 0], ["pushing", 6], ["taxiing", 15], ["stopped in the queue", 0]]) {
  const one = store();
  one.ingest({ pilots: [pilot("DAL500", gs, "KATL", "KBOS")] }, Date.now());
  assert(one.departures().length === 1, "a departure " + label + " is still a departure");
}

/* the turn: an arrival becomes the next departure once it files out */
let prev = null;
let now = 0;
const step = (gs, dep, arr, alt = 1026) => {
  now += 15000;
  const t = {
    gs, dep, arr, field: "KATL",
    onGround: alt - 1026 < 150 && gs < 90,
    phaseSinceMs: prev ? prev.phaseSinceMs : now,
  };
  t.phase = nextPhase(prev, t, now);
  t.phaseSinceMs = prev && prev.phase === t.phase ? prev.phaseSinceMs : now;
  prev = t;
  return t.phase;
};
assert(step(220, "KBOS", "KATL", 4000) === "INBOUND", "inbound");
assert(step(60, "KBOS", "KATL") === "LANDED", "landed");
assert(step(18, "KBOS", "KATL") === "TAXI_IN", "taxiing in");
assert(step(0, "KBOS", "KATL") === "IN_BLOCK", "in block");
assert(step(0, "KATL", "KMCO") === "TURN", "files out on the gate and becomes a departure");
assert(step(6, "KATL", "KMCO") === "PUSHBACK", "pushes back");
assert(step(15, "KATL", "KMCO") === "PUSHBACK", "still pushing inside the hold");
now += 60000;
assert(step(15, "KATL", "KMCO") === "TAXI_OUT", "then taxiing out");
assert(step(0, "KATL", "KMCO") === "HOLDING", "holding short");
assert(step(200, "KATL", "KMCO", 4000) === "DEPARTED", "airborne");

/* a surface swap must not re-classify traffic — that is what broke this */
const swap = store();
swap.ingest({ pilots: [pilot("DAL777", 0, "KATL", "KBOS")] }, Date.now());
assert(swap.targets.get("DAL777").phase === "TURN", "departure identified");
const trailBefore = swap.targets.get("DAL777").trail.length;
swap.ingest({ pilots: [pilot("DAL777", 0, "KATL", "KBOS")] }, Date.now() + 15000);
assert(swap.targets.get("DAL777").phase === "TURN", "and it stays identified across polls");
assert(swap.targets.get("DAL777").trail.length > trailBefore, "with its history intact");
assert(swap.departures().length === 1, "and stays in the spot list");

/* the app keeps its traffic store across a surface swap on the same field */
const { RampApp } = await import("../shared/ramp-app.js");
const app = Object.create(RampApp.prototype);
app.icao = "KATL";
app.field = { ref: REF, elevFt: 1026 };
app.scope = { setModel() {} };
const model = { stands: [] };
app.useModel(model);
const first = app.traffic;
first.ingest({ pilots: [pilot("DAL888", 0, "KATL", "KBOS")] }, Date.now());
assert(first.targets.get("DAL888").phase === "TURN", "departure identified on the first surface");

app.useModel({ stands: [] });                       // switching surface, same field
assert(app.traffic === first, "the traffic store survives a surface swap");
assert(app.traffic.targets.get("DAL888").phase === "TURN", "so the departure stays a departure");

app.icao = "KIAD";
app.field = { ref: [38.9445, -77.4558], elevFt: 313 };
app.useModel({ stands: [] });
assert(app.traffic !== first, "changing field does build a new store");
assert(app.traffic.targets.size === 0, "and starts empty");

console.log(`ramp-phases: ${passed} assertions passed`);
