#!/usr/bin/env node
/**
 * EDST Route Menu remaining-fix trim must not jump to STAR bends
 * while the aircraft is still enroute (UAL78DL / JJEDI case).
 * Usage: node scripts/test-edst-route-fixes-ahead.mjs
 */
import { fixEntriesAheadOfAircraft } from "../shared/route-engine.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// Hub-expanded KBOS→KATL via Q172 / JJEDI STAR (coords from navdata).
const entries = [
  { name: "MRPIT", kind: "enroute", lat: 34.43475, lon: -79.02919 },
  { name: "CEELY", kind: "enroute", lat: 34.2152, lon: -79.46584 },
  { name: "HINTZ", kind: "enroute", lat: 34.16973, lon: -79.7467 },
  { name: "BWAGS", kind: "enroute", lat: 34.00105, lon: -80.75341 },
  { name: "YUTEE", kind: "enroute", lat: 33.79126, lon: -81.55532 },
  { name: "SKWKR", kind: "star", lat: 33.60878, lon: -81.87018 },
  { name: "LAYUH", kind: "star", lat: 33.30638, lon: -82.87652 },
  { name: "FLKNN", kind: "star", lat: 33.23824, lon: -83.44048 },
  { name: "CHWEE", kind: "star", lat: 33.20018, lon: -83.74413 },
  { name: "JJEDI", kind: "star", lat: 33.19039, lon: -83.82271 },
  { name: "DAFII", kind: "star", lat: 33.29357, lon: -83.94561 },
  { name: "GRHAM", kind: "star", lat: 33.36302, lon: -84.02874 },
  { name: "POOBA", kind: "star", lat: 33.46164, lon: -84.0308 },
  { name: "KATL", kind: "enroute" }, // dest often has no lat/lon from hub
];

// Live-ish position NE of MRPIT (Norfolk area) — old pairwise trim falsely cut to POOBA.
const mid = fixEntriesAheadOfAircraft(entries, 37.1276, -76.43363, 223);
const midNames = mid.map((e) => e.name);
assert(midNames.includes("MRPIT"), "mid-route still lists MRPIT");
assert(midNames.includes("CEELY"), "mid-route still lists CEELY");
assert(midNames.includes("YUTEE"), "mid-route still lists YUTEE");
assert(midNames.includes("SKWKR"), "mid-route still lists STAR SKWKR");
assert(midNames[0] === "MRPIT" || midNames[0] === "CEELY", "mid-route starts near first enroute fix");
assert(!(midNames.length === 2 && midNames[0] === "POOBA"), "must not collapse to POOBA+KATL only");

// Past YUTEE / approaching SKWKR — enroute behind should drop, STAR remain.
const nearStar = fixEntriesAheadOfAircraft(entries, 33.75, -81.65, 240);
const nearNames = nearStar.map((e) => e.name);
assert(!nearNames.includes("MRPIT"), "past MRPIT dropped when near STAR");
assert(nearNames.includes("SKWKR") || nearNames.includes("YUTEE"), "STAR/transition still listed");

// No position → unchanged
const all = fixEntriesAheadOfAircraft(entries, null, null, null);
assert(all.length === entries.length, "null position keeps full list");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
