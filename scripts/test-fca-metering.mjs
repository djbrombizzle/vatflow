#!/usr/bin/env node
/**
 * Regression tests for shared/fca-metering.js.
 * Usage: node scripts/test-fca-metering.mjs
 */

import {
  isCrossingAhead,
  hasPassedFca,
  isConnectedPilot,
  computeSequence,
  groundCrossing,
  sepSeconds,
  crossingEtaSec,
  seedAirports,
} from "../shared/fca-metering.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

seedAirports({
  KMIA: [25.7959, -80.2870],
  KFLL: [26.0726, -80.1527],
  KPBI: [26.6832, -80.0956],
  KJFK: [40.6413, -73.7781],
  KATL: [33.6367, -84.4281],
  KDCA: [38.8512, -77.0402],
});

const FCA_SB = {
  id: "fca4",
  name: "FCA 4",
  enabled: true,
  dir: "S",
  points: [[26.5, -82.0], [26.5, -79.5]],
  minFL: 0,
  maxFL: 999,
  mode: "rate",
  rate: 12,
};

const crossOnLine = { lat: 26.5, lon: -80.2 };

const pastSouth = {
  callsign: "TEST01",
  phase: "air",
  lat: 26.0,
  lon: -80.15,
  hdg: 185,
  gs: 420,
  alt: 28000,
  arr: "KMIA",
  dep: "KJFK",
  route: "DCT",
};

assert(!isCrossingAhead(pastSouth, crossOnLine), "crossing behind aircraft should not be ahead");
assert(hasPassedFca(pastSouth, FCA_SB), "south of SB FCA heading south = passed");

const approaching = {
  ...pastSouth,
  callsign: "TEST02",
  lat: 27.2,
  lon: -80.15,
  hdg: 180,
};
assert(isCrossingAhead(approaching, crossOnLine), "crossing ahead when approaching SB FCA");
assert(!hasPassedFca(approaching, FCA_SB), "north of SB FCA is not passed");

const justPast = {
  ...pastSouth,
  callsign: "TEST03",
  lat: 26.47,
  lon: -80.15,
  hdg: 182,
};
assert(!isCrossingAhead(justPast, crossOnLine), "just past: backward crossing rejected by heading");
assert(!hasPassedFca(justPast, FCA_SB), "within 2 nm of line: hasPassedFca stays false");

const seq = computeSequence(FCA_SB, [pastSouth, approaching], [], { includeEdct: false });
const cs = seq.items.map(c => c.p.callsign);
assert(cs.includes("TEST02"), "approaching aircraft on route crossing FCA in sequence");
assert(!cs.includes("TEST01"), "past aircraft excluded from sequence");

const prefileGround = {
  callsign: "PREF01",
  phase: "gnd",
  prefile: true,
  lat: null,
  lon: null,
  gs: 0,
  arr: "KMIA",
  dep: "KPBI",
  fpAlt: 28000,
  route: "DCT",
};
const connectedGround = {
  ...prefileGround,
  callsign: "GND01",
  prefile: false,
  lat: 26.68,
  lon: -80.10,
};
assert(!isConnectedPilot(prefileGround), "prefile flagged as not connected");
assert(isConnectedPilot(connectedGround), "connected ground pilot");

const edctSeq = computeSequence(
  { ...FCA_SB, dir: "any" },
  [connectedGround],
  [prefileGround],
  { includeEdct: true },
);
const edctCs = edctSeq.items.map(c => c.p.callsign);
assert(edctCs.includes("GND01"), "connected ground on crossing route in EDCT sequence");
assert(!edctCs.includes("PREF01"), "prefile excluded from EDCT sequence");

const gCross = groundCrossing(connectedGround, { ...FCA_SB, dir: "any" }, Date.now());
assert(gCross && gCross.dist > 0, "groundCrossing returns route crossing");
assert(Math.abs(gCross.etaSec - crossingEtaSec(gCross.dist, gCross.gs)) < 1, "ground ETA = dist / gs");

const FCA_RATE = {
  id: "dep1",
  enabled: true,
  dir: "any",
  points: [[26.0, -80.5], [26.0, -79.8]],
  mode: "rate",
  rate: 10,
  minFL: 0,
  maxFL: 999,
};
const fixedNow = Date.parse("2026-07-03T12:00:00Z");

const FCA_MIT = {
  id: "mit1",
  enabled: true,
  dir: "any",
  points: [[27.0, -81.0], [27.0, -79.0]],
  mode: "mit",
  mit: 15,
  minFL: 0,
  maxFL: 999,
};
const farAir = {
  callsign: "FAR01",
  phase: "air",
  lat: 28.48,
  lon: -80.5,
  hdg: 180,
  gs: 420,
  alt: 28000,
  arr: "KMIA",
  dep: "KJFK",
  route: "DCT",
};
const nearAir = { ...farAir, callsign: "NEAR01", lat: 28.42, lon: -80.5 };
const mitSeq = computeSequence(FCA_MIT, [nearAir, farAir], [], { includeEdct: false });
const far = mitSeq.items.find(c => c.p.callsign === "FAR01");
const near = mitSeq.items.find(c => c.p.callsign === "NEAR01");
assert(far && near, "both airborne on crossing route in MIT sequence");
assert(far.dist > near.dist, "FAR01 is farther from FCA than NEAR01");
assert(mitSeq.items[0].p.callsign === "NEAR01", "order is by time-to-line (closest first)");
assert(far.sched >= near.sched + sepSeconds(FCA_MIT, far) - 1, "MIT delays trailing aircraft when too close");
assert(far.delay > 30, "MIT assigns hold time when trail < MIT nm");

const farTrail = computeSequence(FCA_MIT, [
  { ...nearAir, callsign: "CLOSE", lat: 28.42 },
  { ...farAir, callsign: "FARTRAIL", lat: 27.0, lon: -80.5 },
], [], { includeEdct: false });
const close = farTrail.items.find(c => c.p.callsign === "CLOSE");
const farT = farTrail.items.find(c => c.p.callsign === "FARTRAIL");
if (close && farT && farT.dist - close.dist >= 15) {
  assert(farT.delay < 60, "large in-trail distance does not add long airborne hold");
}

const mitMixed = computeSequence(
  { ...FCA_RATE, mode: "mit", mit: 15 },
  [nearAir, farAir, {
    callsign: "GND1", phase: "gnd", lat: 26.07, lon: -80.15, gs: 0,
    dep: "KFLL", arr: "KMIA", fpAlt: 28000, route: "DCT",
  }],
  [],
  { includeEdct: true, nowMs: fixedNow },
);
const firstGnd = mitMixed.items.findIndex(c => c.phase === "gnd");
const lastAir = mitMixed.items.reduce((n, c, i) => c.phase === "air" ? i : n, -1);
assert(firstGnd > lastAir, "all airborne before ground in queue");
assert(mitMixed.items[0].phase === "air", "closest air is #1, not ground");

const leaderGround = {
  callsign: "LEAD",
  phase: "gnd",
  lat: 26.07,
  lon: -80.15,
  gs: 0,
  dep: "KFLL",
  arr: "KMIA",
  fpAlt: 28000,
  route: "DCT",
};
const followerGround = { ...leaderGround, callsign: "FOLL" };
const seqGround = computeSequence(FCA_RATE, [leaderGround, followerGround], [], { includeEdct: true, nowMs: fixedNow });
const followG = seqGround.items.find(c => c.p.callsign === "FOLL");
assert(followG && followG.delay >= 300, "same-airport follower delayed on ground");

const leaderAir = {
  ...leaderGround,
  phase: "air",
  gs: 160,
  alt: 2500,
  lat: 26.05,
  lon: -80.14,
  hdg: 180,
};
const seqAfterDep = computeSequence(FCA_RATE, [leaderAir, followerGround], [], { includeEdct: true, nowMs: fixedNow });
const followAfter = seqAfterDep.items.find(c => c.p.callsign === "FOLL");
assert(followAfter && followAfter.delay >= 180, "follower delay survives leader departure");

const dalLike = {
  callsign: "DAL1378",
  phase: "air",
  lat: 33.95,
  lon: -83.38,
  hdg: 55,
  gs: 496,
  alt: 27000,
  dep: "KATL",
  arr: "KDCA",
  route: "DCT",
};
const aikenFca = {
  id: "aiken",
  enabled: true,
  dir: "any",
  points: [[34.8, -81.72], [35.8, -81.72]],
  mode: "mit",
  mit: 45,
  minFL: 0,
  maxFL: 999,
};
const dalSeq = computeSequence(aikenFca, [dalLike], [], { includeEdct: false });
assert(dalSeq.items.some(c => c.p.callsign === "DAL1378"), "KATL-KDCA route crossing N-S FCA is included");

const ztlFca = {
  id: "ztl", enabled: true, dir: "any", points: [[34.5, -79.8], [37.5, -79.8]],
  mode: "mit", mit: 45, minFL: 0, maxFL: 999,
};
const gsMix = computeSequence(ztlFca, [
  { callsign: "CLOSE", phase: "air", lat: 36.0, lon: -80.2, hdg: 55, gs: 120, alt: 33000, dep: "KATL", arr: "KDCA", route: "DCT" },
  { callsign: "FAR", phase: "air", lat: 33.9, lon: -84.0, hdg: 55, gs: 500, alt: 33000, dep: "KATL", arr: "KDCA", route: "DCT" },
], [], { includeEdct: false });
assert(gsMix.items[0].p.callsign === "CLOSE", "queue order is by distance to crossing, not faster gs farther out");

const staleManual = computeSequence(
  { ...ztlFca, order: ["FAR", "CLOSE"], manualSeq: false },
  [
    { callsign: "CLOSE", phase: "air", lat: 36.0, lon: -80.2, hdg: 55, gs: 120, alt: 33000, dep: "KATL", arr: "KDCA", route: "DCT" },
    { callsign: "FAR", phase: "air", lat: 33.9, lon: -84.0, hdg: 55, gs: 500, alt: 33000, dep: "KATL", arr: "KDCA", route: "DCT" },
  ],
  [],
  { includeEdct: false },
);
assert(staleManual.items[0].p.callsign === "CLOSE", "stale order array without manualSeq still auto-sorts");

const bypass = {
  callsign: "BYPASS",
  phase: "air",
  lat: 30,
  lon: -85,
  hdg: 270,
  gs: 420,
  alt: 35000,
  dep: "KATL",
  arr: "KMSY",
  route: "DCT",
};
seedAirports({ KMSY: [29.9934, -90.2580] });
const bypassSeq = computeSequence(aikenFca, [bypass], [], { includeEdct: false });
assert(!bypassSeq.items.some(c => c.p.callsign === "BYPASS"), "route not crossing FCA is excluded");

console.log("test-fca-metering: all passed (" + cs.length + " in seq)");
