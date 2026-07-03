#!/usr/bin/env node
/**
 * Regression tests for shared/fca-metering.js (FCA past-line exclusion).
 * Usage: node scripts/test-fca-metering.mjs
 */

import {
  isCrossingAhead,
  hasPassedFca,
  isConnectedPilot,
  computeSequence,
  groundCrossing,
  sepSeconds,
  withTerminalEtaFloor,
  seedAirports,
} from "../shared/fca-metering.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

seedAirports({
  KMIA: [25.7959, -80.2870],
  KFLL: [26.0726, -80.1527],
  KPBI: [26.6832, -80.0956],
});

// FCA 4–style line across south Florida (west → east), southbound metering
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

// Aircraft south of FCA, heading south (screenshot aircraft #3 case)
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

// Aircraft north of FCA, heading south — still approaching
const approaching = {
  ...pastSouth,
  callsign: "TEST02",
  lat: 27.2,
  lon: -80.15,
  hdg: 180,
};
assert(isCrossingAhead(approaching, crossOnLine), "crossing ahead when approaching SB FCA");
assert(!hasPassedFca(approaching, FCA_SB), "north of SB FCA is not passed");

// Just crossed (<2 nm) but heading away — still exclude via heading
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
assert(cs.includes("TEST02"), "approaching aircraft in sequence");
assert(!cs.includes("TEST01"), "past aircraft excluded from sequence");

const prefileGround = {
  callsign: "PREF01",
  phase: "gnd",
  prefile: true,
  lat: null,
  lon: null,
  gs: 0,
  hdg: 0,
  alt: 0,
  arr: "KMIA",
  dep: "KPBI",
  tas: 420,
  fpAlt: 28000,
  deptime: "1200",
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
assert(edctCs.includes("GND01"), "connected ground in EDCT sequence");
assert(!edctCs.includes("PREF01"), "prefile excluded from EDCT sequence");

const now = Date.now();
const nearFuture = new Date(now);
nearFuture.setUTCMinutes(nearFuture.getUTCMinutes() + 45);
const futureDepStr = String(nearFuture.getUTCHours()).padStart(2, "0") +
  String(nearFuture.getUTCMinutes()).padStart(2, "0");
const futureGround = {
  ...connectedGround,
  callsign: "GND02",
  deptime: futureDepStr,
};
const gNow = groundCrossing(connectedGround, { ...FCA_SB, dir: "any" }, now);
const gFuture = groundCrossing(futureGround, { ...FCA_SB, dir: "any" }, now);
assert(gNow && gFuture, "groundCrossing returns candidates");
assert(gFuture.etaSec > gNow.etaSec + 60, "future P time pushes ground ETA later");

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
assert(far && near, "both airborne in MIT sequence");
assert(far.dist > near.dist, "FAR01 is farther from FCA than NEAR01");
assert(mitSeq.items[0].p.callsign === "NEAR01", "MIT order is by distance — closer aircraft first");
assert(far.sched >= near.sched + sepSeconds(FCA_MIT, far) - 1, "MIT delays trailing aircraft when too close");
assert(far.delay > 30, "MIT assigns hold time to trailing aircraft");

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
const leaderGround = {
  callsign: "LEAD",
  phase: "gnd",
  lat: 26.07,
  lon: -80.15,
  gs: 0,
  dep: "KFLL",
  arr: "KMIA",
  tas: 420,
  fpAlt: 28000,
  deptime: "1200",
  route: "DCT",
};
const followerGround = { ...leaderGround, callsign: "FOLL", deptime: "1200" };
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
assert(followAfter && followAfter.delay >= 180, "follower delay survives leader departure near field");

const floored = withTerminalEtaFloor(leaderAir, FCA_RATE, fixedNow, 30);
assert(floored >= 40, "terminal floor keeps eta from collapsing near departure");

console.log("test-fca-metering: all passed (" + cs.length + " in seq)");
