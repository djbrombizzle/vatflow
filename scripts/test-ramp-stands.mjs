#!/usr/bin/env node
/**
 * RampView occupancy: no flicker on a 15-second feed.
 * Usage: node scripts/test-ramp-stands.mjs
 */
import { StandOccupancy, matchStand } from "../shared/ramp-stands.js";
import { synthStandPoly, makeProjection, pointInPoly } from "../shared/ramp-airport.js";
import { declaredStand } from "../shared/ramp-app-pure.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const stand = (id, x, y, hdg = 270, size = "C") => ({
  id, point: [x, y], hdg, sizeCode: size, poly: synthStandPoly([x, y], hdg, size), concourse: id[0],
});

const STANDS = [stand("D32", 0, 0), stand("D34", 0, 45), stand("D36", 0, 90)];

/* projection sanity */
const proj = makeProjection(33.6367, -84.4281);
const [px, py] = proj.toXY(33.6467, -84.4281);
assert(Math.abs(px) < 0.5 && Math.abs(py - 1113) < 3, "projection north offset is right");
const [blat, blon] = proj.toLL(px, py);
assert(Math.abs(blat - 33.6467) < 1e-9 && Math.abs(blon + 84.4281) < 1e-9, "projection round-trips");

/* matching */
assert(matchStand(10, 0, 270, STANDS).stand.id === "D32", "inside the polygon matches");
assert(matchStand(10, 0, 270, STANDS).confidence === "high", "a single polygon hit is high confidence");
assert(matchStand(10, 90, 90, STANDS).confidence === "low", "crossing a stand box at 90 degrees is low confidence, not a match");
assert(matchStand(500, 500, 270, STANDS) === null, "far away does not match");
assert(pointInPoly(10, 0, STANDS[0].poly), "poly containment");

/* the core anti-flicker behaviours */
function run(steps) {
  const occ = new StandOccupancy(STANDS);
  let t = 0;
  for (const s of steps) {
    t += 15000;
    occ.update(t, s === null ? [] : [{ callsign: "DAL1", x: s.x, y: s.y ?? 0, hdg: 270, gs: s.gs ?? 0, onGround: true, hasPlan: s.plan !== false }]);
  }
  return occ;
}

const park = [{ x: 10 }, { x: 10 }, { x: 10 }];
assert(run([{ x: 10 }]).occupied.size === 0, "one slow sample does not occupy a stand");
assert(run(park).occupied.get("D32"), "30 s stopped in the box does occupy it");

/* jitter must not move the aircraft between adjacent stands */
const jitter = run([...park, { x: 10.4, y: 0.6 }, { x: 9.7, y: -0.4 }, { x: 10.1, y: 0.2 }]);
assert(jitter.occupied.size === 1 && jitter.occupied.has("D32"), "position jitter does not flip the gate");

/* a disconnect is held through the grace window, then released */
const held = run([...park, null, null, null]);
assert(held.occupied.has("D32"), "stand held through a 45 s dropout");
const released = run([...park, null, null, null, null, null, null]);
assert(!released.occupied.has("D32"), "stand released after the grace window");

/* reconnect keeps the turn timer */
const occR = new StandOccupancy(STANDS);
let t = 0;
const feed = p => {
  t += 15000;
  occR.update(t, p ? [{ callsign: "DAL2", x: 10, y: 0, hdg: 270, gs: 0, onGround: true, hasPlan: true }] : []);
};
feed(1); feed(1); feed(1);
const since = occR.occupied.get("D32").sinceMs;
feed(0); feed(0); feed(1);
assert(occR.occupied.get("D32").sinceMs === since, "a reconnect inside the window keeps the in-block time");

/* pushback frees the stand */
const occP = new StandOccupancy(STANDS);
let u = 0;
const move = (x, gs) => {
  u += 15000;
  occP.update(u, [{ callsign: "DAL3", x, y: 0, hdg: 270, gs, onGround: true, hasPlan: true }]);
};
move(10, 0); move(10, 0); move(10, 0);
assert(occP.occupied.has("D32"), "parked before push");
move(60, 6); move(200, 15); move(320, 15); move(420, 15);
assert(!occP.occupied.has("D32"), "stand freed once the aircraft is clear");

/* squatters */
const occD = new StandOccupancy(STANDS);
let v = 0;
for (let i = 0; i < 400; i++) {
  v += 15000;
  occD.update(v, [{ callsign: "N670DN", x: 10, y: 0, hdg: 270, gs: 0, onGround: true, hasPlan: false }]);
}
assert(occD.occupied.get("D32").dormant, "90 minutes in block with no flight plan is dormant");

/* multi-use stands block their neighbours */
const big = stand("D33", 0, 22, 270, "E");
big.blocks = ["D32", "D34"];
const occB = new StandOccupancy([...STANDS, big]);
let w = 0;
for (let i = 0; i < 3; i++) {
  w += 15000;
  occB.update(w, [{ callsign: "DAL4", x: 10, y: 22, hdg: 270, gs: 0, onGround: true, hasPlan: true }]);
}
const blocked = occB.blockedStands();
assert(blocked.has("D32") && blocked.has("D34"), "a code-E stand in use blocks its code-C neighbours");

/* declared gates: explicit prefixes only */
const model = { stands: STANDS };
assert(declaredStand({ route: "GATE D32 DCT" }, model) === "D32", "GATE prefix is honoured");
assert(declaredStand({ route: "STAND D34" }, model) === "D34", "STAND prefix is honoured");
assert(declaredStand({ route: "DCT D32 J75" }, model) === null, "a bare token is not a gate");
assert(declaredStand({ route: "GATE Z99" }, model) === null, "an unknown stand is rejected");

console.log(`ramp-stands: ${passed} assertions passed`);
