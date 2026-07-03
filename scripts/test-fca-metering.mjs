#!/usr/bin/env node
/**
 * Regression tests for shared/fca-metering.js (FCA past-line exclusion).
 * Usage: node scripts/test-fca-metering.mjs
 */

import {
  isCrossingAhead,
  hasPassedFca,
  computeSequence,
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

console.log("test-fca-metering: all passed (" + cs.length + " in seq)");
