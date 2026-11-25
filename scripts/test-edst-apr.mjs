#!/usr/bin/env node
// Tests for shared/edst-apr.js (Route Menu ATC Preferred Routes). Run: node scripts/test-edst-apr.mjs
import { parseAltitude, tecClass, aprProblems, aprList, aprText, applyApr } from "../shared/edst-apr.js";

let failed = 0;
function eq(got, want, msg) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL:", msg, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok:", msg);
}

eq(parseAltitude(""), null, "empty");
eq(parseAltitude("J100M80"), { classes: { J: 100, M: 80 } }, "TEC classes");
eq(parseAltitude("JMPQ50"), { classes: { J: 50, M: 50, P: 50, Q: 50 } }, "TEC shared altitude");
eq(parseAltitude("JM110PQ90"), { classes: { J: 110, M: 110, P: 90, Q: 90 } }, "TEC two groups");
eq(parseAltitude("10000"), { min: null, max: 100 }, "plain feet = max");
eq(parseAltitude("110-170 INCL"), { min: 110, max: 170 }, "range");
eq(parseAltitude("FL240 AND ABOVE"), { min: 240, max: null }, "and above");
eq(parseAltitude("AOB FL220"), { min: null, max: 220 }, "AOB");
eq(parseAltitude("AT OR ABOVE 130"), { min: 130, max: null }, "at or above");
eq(parseAltitude("9000 AND BELOW"), { min: null, max: 90 }, "and below");
eq(parseAltitude("10000 TO 15000"), { min: 100, max: 150 }, "to");
eq(parseAltitude("4000 / 6000"), { min: null, max: 60 }, "options");
eq(tecClass("B738/L", 450), "J", "jet");
eq(tecClass("C172/G", 110), "Q", "slow piston");

const H = ["LAX", "LAX DOTSS3 ... ", "H", "", "", "", "", "", 1];
eq(aprProblems(H, { type: "B738/L", alt: 350 }), [], "H route, jet at FL350");
eq(aprProblems(H, { type: "B738/L", alt: 120 }), ["ALTITUDE"], "H route below FL180");
eq(aprProblems(["X", "R", "TEC", "PQ60", "", "", "", "", 1], { type: "B738/L", alt: 60 }), ["AIRCRAFT CLASS"], "TEC props only");
eq(aprProblems(["X", "R", "H", "", "RNAV ONLY", "", "", "", 1], { type: "B738/A", alt: 350 }), ["EQUIPMENT"], "RNAV only, /A");
eq(aprProblems(["X", "R", "H", "", "", "1100-0300", "", "", 1], { type: "B738/L", alt: 350 }, Date.UTC(2026, 0, 1, 5, 0)), ["TIME"], "outside hours");
eq(aprProblems(["X", "R", "H", "", "", "1100-0300", "", "", 1], { type: "B738/L", alt: 350 }, Date.UTC(2026, 0, 1, 1, 0)), [], "hours across midnight");

const rows = [
  ["ILM", "ILM FAK J109 LEONI J211 HAGUD CETUS2 DTW", "H", "", "", "", "", "", 1],
  ["LDN", "LDN J134 FLM DQN MIZAR3 DTW", "H", "", "", "", "", "", 1],
  ["CLT", "CLT XXX DTW", "H", "", "", "", "", "", 1],
  ["FAK", "FAK J109 LEONI J211 HAGUD CETUS2 DTW", "L", "", "", "", "", "", 1],
];
const ground = aprList({ dep: "KILM", arr: "KDTW", type: "B752/Q", alt: 350, airborne: false, ahead: ["FAK", "LDN"] }, rows);
eq(ground.map((r) => [r.orig, r.eligible]), [["ILM", true], ["LDN", true], ["FAK", false]], "ground: dep and fixes ahead, eligible first");
const air = aprList({ dep: "KILM", arr: "KDTW", type: "B752/Q", alt: 350, airborne: true, ahead: ["FAK", "LDN"] }, rows);
eq(air.map((r) => r.orig), ["LDN", "FAK"], "airborne: no departure routes");

eq(aprText("LDN J134 FLM DQN MIZAR3 DTW"), "LDN.J134.FLM..DQN.MIZAR3.DTW", "ERAM text");
eq(applyApr("FAK LDN XYZ", { route: "LDN J134 FLM DQN MIZAR3 DTW" }, "KILM", "KDTW"), "FAK LDN J134 FLM DQN MIZAR3 KDTW", "APR from a fix ahead");
eq(applyApr("FAK LDN XYZ", { route: "ILM FAK J109 LEONI DTW" }, "KILM", "KDTW"), "KILM FAK J109 LEONI KDTW", "APR from the departure");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
