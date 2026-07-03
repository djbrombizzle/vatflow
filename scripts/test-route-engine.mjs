#!/usr/bin/env node
/**
 * Regression tests for shared/route-engine.js
 * Usage: node scripts/test-route-engine.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindAirports,
  seedNavData,
  resolveToken,
  expandAirway,
  buildRouteAnchors,
  buildRouteAnchorsForAircraft,
  buildRouteSegments,
} from "../shared/route-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAV = join(__dirname, "..", "data", "nav");

const AIRPORTS = {
  KATL: [33.6367, -84.4281],
  KJFK: [40.6398, -73.7789],
  KLAX: [33.9425, -118.4081],
  KORD: [41.9742, -87.9073],
  KBHM: [33.5629, -86.7535],
  KTPA: [27.9755, -82.5332],
  KBOS: [42.3656, -71.0096],
  KTYS: [35.811, -83.994],
};

bindAirports(
  icao => AIRPORTS[icao] || null,
  icao => !!AIRPORTS[icao],
);

function loadNavFromDisk() {
  seedNavData({
    meta: JSON.parse(readFileSync(join(NAV, "meta.json"), "utf8")),
    fixes: JSON.parse(readFileSync(join(NAV, "fixes.json"), "utf8")),
    navaids: JSON.parse(readFileSync(join(NAV, "navaids.json"), "utf8")),
    airways: JSON.parse(readFileSync(join(NAV, "airways.json"), "utf8")),
    procedures: JSON.parse(readFileSync(join(NAV, "procedures.json"), "utf8")),
    preferred: JSON.parse(readFileSync(join(NAV, "preferred.json"), "utf8")),
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function approx(a, b, tol = 0.5) {
  return Math.abs(a - b) <= tol;
}

loadNavFromDisk();

// Fix resolution
const merit = resolveToken("MERIT", { refLL: AIRPORTS.KJFK });
assert(merit && merit.kind === "fix", "MERIT should resolve as fix");
assert(approx(merit.ll[0], 41.38, 0.1), "MERIT lat");

// Airway expansion V16 segment
const v16 = expandAirway("V16", [33.94, -118.41], [-73.78, 40.64]);
assert(v16.length > 5, "V16 should expand to multiple waypoints");

// Route with airway
const p = {
  dep: "KLAX",
  arr: "KJFK",
  route: "MERIT V16 JFK",
  lat: null,
  lon: null,
  phase: "gnd",
};
const { anchors, unresolved } = buildRouteAnchors(p, {
  origin: AIRPORTS.KLAX,
  destination: AIRPORTS.KJFK,
});
assert(anchors.length >= 4, "route should have dep + fixes + arr");
assert(anchors.some(a => a.kind === "awy" || a.kind === "fix"), "route should include enroute points");
console.log("anchors:", anchors.map(a => `${a.name}(${a.kind})`).join(" → "));

const segs = buildRouteSegments(p, { origin: AIRPORTS.KLAX, destination: AIRPORTS.KJFK });
assert(segs.length >= 2, "should produce segments");
const totalNm = segs.reduce((s, x) => s + x.distNm, 0);
assert(totalNm > 2000, "LAX-JFK via route should be >2000nm, got " + totalNm);

// STAR with named transition only (not all transitions)
const pMaaty = {
  dep: "KBHM",
  arr: "KTPA",
  route: "GUMMP MGMRY ACORI MAATY5",
  phase: "gnd",
};
const maaty = buildRouteAnchors(pMaaty, { origin: AIRPORTS.KBHM, destination: AIRPORTS.KTPA });
const maatyNames = maaty.anchors.map(a => a.name);
assert(maatyNames.includes("ACORI"), "ACORI transition should be in path");
assert(maatyNames.includes("MAATY"), "MAATY common should be in path");
assert(!maatyNames.includes("BADDD"), "BADDD transition should not appear");
assert(!maatyNames.includes("DEFUN"), "DEFUN transition should not appear");
console.log("MAATY5/ACORI:", maatyNames.join(" → "));

// Airborne: only plot fixes ahead of position (not back to departure)
const pAir = {
  dep: "KBOS",
  arr: "KTYS",
  route: "BLZZR6 BLZZR BAF Q448 PTW J48 CSN FANPO Q40 ALEAN VXV",
  lat: 38.5,
  lon: -78.0,
  hdg: 220,
  phase: "air",
};
const ahead = buildRouteAnchorsForAircraft(pAir, {
  origin: AIRPORTS.KBOS,
  destination: AIRPORTS.KTYS,
  includeNow: true,
});
const aheadNames = ahead.anchors.map(a => a.name);
assert(aheadNames[0] === "NOW", "first anchor should be NOW");
assert(!aheadNames.includes("KBOS"), "departure should not be behind aircraft on map");
assert(!aheadNames.includes("BLZZR"), "passed SID fix should not appear behind aircraft");
console.log("ahead route:", aheadNames.join(" → "));

// STAR prefix match (CHPPR6 → CHPPR* family)
const star = resolveToken("CHPPR6", { refLL: AIRPORTS.KATL, dep: "KATL", arr: "KJFK" });
assert(star && (star.kind === "star" || star.kind === "sid"), "CHPPR6 should resolve via STAR prefix");

// STAR / SID procedure expansion
const pStar = { dep: "KATL", arr: "KATL", route: "CHPPR6", phase: "gnd" };
const starAnchors = buildRouteAnchors(pStar, { origin: AIRPORTS.KATL, destination: AIRPORTS.KATL });
assert(starAnchors.anchors.length >= 3, "STAR should expand to multiple anchors");

console.log("All route-engine tests passed.");
