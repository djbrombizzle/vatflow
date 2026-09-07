#!/usr/bin/env node
/**
 * ARTCC scope id normalization + ring lookup.
 * Usage: node scripts/test-artcc-scope.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  seedArtccBoundaries,
  getArtccRings,
  getArtccBounds,
  pointInArtcc,
  normArtccId,
} from "../shared/artcc-scope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const geo = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "artcc-boundaries-high.geojson"), "utf8"),
);
seedArtccBoundaries(geo);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

assert(normArtccId("KZJX") === "ZJX", "KZJX → ZJX");
assert(normArtccId("zjx") === "ZJX", "zjx → ZJX");
assert(normArtccId("ZAU") === "ZAU", "ZAU unchanged");

const ringsZ = getArtccRings("ZJX");
const ringsK = getArtccRings("KZJX");
assert(!!ringsZ && ringsZ.length > 0, "ZJX has rings");
assert(!!ringsK && ringsK.length === ringsZ.length, "KZJX resolves same rings as ZJX");
assert(!!getArtccBounds("KZJX"), "KZJX has bounds");

// Jacksonville approx inside ZJX
assert(pointInArtcc("KZJX", 30.5, -81.7) === true, "KJAX area inside KZJX");
assert(pointInArtcc("ZJX", 30.5, -81.7) === true, "KJAX area inside ZJX");
// Chicago area outside ZJX
assert(pointInArtcc("ZJX", 41.9, -87.6) === false, "ORD outside ZJX");
// West Texas / Oklahoma fields used on Airport TMU
assert(pointInArtcc("ZFW", 33.66364, -101.82278) === true, "KLBB inside ZFW");
assert(pointInArtcc("ZFW", 31.94253, -102.20191) === true, "KMAF inside ZFW");
assert(pointInArtcc("ZFW", 35.3931, -97.6007) === true, "KOKC inside ZFW");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
