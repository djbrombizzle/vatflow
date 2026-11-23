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
  isInternationalRoute,
  inNavCoverage,
  procedureRunwayTransition,
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
  EDDF: [50.0333, 8.5706],
  KPHL: [39.8719, -75.2411],
  KDCA: [38.8521, -77.0377],
  KBWI: [39.1754, -76.6683],
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

// International: resolve US fixes, then great-circle to destination only
const EGLL = [51.47, -0.45];
assert(isInternationalRoute("EGLL", EGLL), "EGLL should be international");
assert(isInternationalRoute("CYHZ", [44.88, -63.58]), "Canadian destination should be international");
assert(!isInternationalRoute("KJFK", AIRPORTS.KJFK), "KJFK should stay domestic");
const pIntl = {
  dep: "KJFK",
  arr: "EGLL",
  route: "MERIT NELIE ALLRY NATA OYSTR GOMUP",
  phase: "gnd",
};
const intl = buildRouteAnchors(pIntl, { origin: AIRPORTS.KJFK, destination: EGLL });
const intlNames = intl.anchors.map(a => a.name);
assert(intl.truncatedInternational, "international route should truncate oceanic tokens");
assert(intlNames.includes("MERIT") && intlNames.includes("NELIE"), "US fixes should remain");
assert(intlNames.includes("EGLL"), "destination should be appended");
assert(!intlNames.includes("ALLRY"), "oceanic fix should not be plotted");
assert(intl.oceanicSkipped.includes("ALLRY"), "oceanic token should be recorded as skipped");
assert(!intl.unresolved.includes("ALLRY"), "oceanic token should not count as unresolved");
const lastUs = intl.anchors.filter(a => a.kind !== "apt").slice(-1)[0];
assert(lastUs && inNavCoverage(lastUs.ll[0], lastUs.ll[1]), "last enroute point should stay in nav coverage");
console.log("international:", intlNames.join(" → "));

// RIFLE is a Colorado VOR and a fix off Long Island: Q167 must stop at the
// Long Island fix, then Q439 runs offshore to BRIGS (not down Q167 to KALDA).
const mej = buildRouteAnchors({ dep: "KBOS", arr: "KJFK", route: "SSOXS7 SSOXS Q167 RIFLE Q439 BRIGS ENO" });
const mejNames = mej.anchors.map(a => a.name);
const rifle = mej.anchors.find(a => a.name === "RIFLE");
assert(rifle && Math.abs(rifle.ll[1] + 72.58) < 0.1, "RIFLE should be the Long Island fix, not the Colorado VOR");
assert(!mejNames.includes("KALDA") && !mejNames.includes("ZJAAY"), "Q167 should stop at RIFLE");
assert(mejNames.join(" ").includes("RIFLE SARDI DUNEE SHERL PLUME MANTA DRIFT HARBO BRIGS ENO"), "Q439 RIFLE to BRIGS offshore");
console.log("RIFLE/Q439:", mejNames.join(" → "));

// Inbound from Europe (BAS92 EDDF→KPHL): the European part must not resolve
// to US names (Q60 → Virginia, CON → Concord NH); the route starts at ACADN.
const bas = buildRouteAnchors({ dep: "EDDF", arr: "KPHL", route: "OBOKA2E OBOKA Z29 TORNU DCT VICOT DCT GALSO Q63 ERING L179 UGBET Q60 OKSAW DCT TEWXI DCT LIPGO/N0477F340 DCT INKUR DCT CON DCT RESNO/M084F340 NATC NICSO/N0486F360 DCT ACADN DCT TUSKY DCT RIFLE Q439 BRIGS JIIMS4" });
const basNames = bas.anchors.map(a => a.name);
assert(basNames[0] === "EDDF" && basNames[1] === "ACADN", "inbound route should go EDDF then ACADN: " + basNames.join(" "));
assert(!basNames.includes("CON") && !basNames.includes("HURTS"), "no US look-alikes from the European part");
assert(basNames.join(" ").includes("RIFLE SARDI") && basNames.includes("BRIGS") && basNames.slice(-1)[0] === "KPHL", "US tail kept");
assert(bas.unresolved.length === 0 && bas.oceanicSkipped.includes("NICSO"), "foreign part is skipped, not unresolved");
console.log("inbound EDDF→KPHL:", basNames.join(" → "));

// Runway-dependent procedures follow the runway in use when the caller knows it.
const doctr = r => buildRouteAnchors({ dep: "KDCA", arr: "KBOS", route: "DOCTR5 AGARD J209 SBY" }, { depRunways: r }).anchors.map(a => a.name);
assert(!doctr([]).includes("REVGE"), "no runway: DOCTR5 has no common legs, so no runway leg is drawn");
assert(doctr(["01"]).join(" ").includes("REVGE BEBLE COVTO ALEEX DOGUE RIISE DOCTR"), "DCA 01: north-flow DOCTR5 leg: " + doctr(["01"]).join(" "));
assert(doctr(["19"]).join(" ").includes("FIMBI MOTBE GDYUP HMBGR DOCTR"), "DCA 19: south-flow DOCTR5 leg: " + doctr(["19"]).join(" "));
const ravnn = r => buildRouteAnchors({ dep: "KATL", arr: "KBWI", route: "THHMP RAVNN9" }, { arrRunways: r }).anchors.map(a => a.name);
assert(ravnn(["33L"]).join(" ").includes("CAPKO RAVNN SEEED KOOLZ"), "BWI 33L: RAVNN9 ends on the 33L leg: " + ravnn(["33L"]).join(" "));
assert(ravnn(["10"]).join(" ").includes("RAVNN SEEED NAVEY ANCRR"), "BWI 10: RAVNN9 ends on the 10 leg");
assert(ravnn([]).slice(-2).join(" ") === "RAVNN KBWI", "no runway: RAVNN9 ends at RAVNN as before");
const fakeProc = { transitions: { RW01B: [], RW19L: [], RW04: [] } };
assert(procedureRunwayTransition(fakeProc, ["01R"]) === "RW01B", "01R uses the both-parallels RW01B");
assert(procedureRunwayTransition(fakeProc, ["19L", "01C"]) === "RW19L", "first runway with a transition wins");
assert(procedureRunwayTransition(fakeProc, ["4"]) === "RW04" && procedureRunwayTransition(fakeProc, ["28"]) === null, "bare number and no match");
console.log("runway legs: DCA 19", doctr(["19"]).join(" → "), "| BWI 33L", ravnn(["33L"]).join(" → "));

console.log("All route-engine tests passed.");
