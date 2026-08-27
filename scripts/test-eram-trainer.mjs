#!/usr/bin/env node
import {
  validatePack,
  importPackJson,
  generateFleet,
  generateScenarios,
  gradeCommand,
  scoreRound,
  shuffleScenarios,
  aircraftMap,
  preparePack,
  normalizeCommand,
  airportsForArtcc,
} from "../shared/eram-trainer.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else console.log("ok:", msg);
}

const samplePack = {
  artcc: "ZDC",
  aircraft: [{ cs: "AAL123", alt: 280, route: "KDCA BAL TIMMY" }],
  scenarios: [{
    id: "t1",
    instruction: "Climb",
    aircraft: "AAL123",
    expect: { verb: "QZ", alt: 340, mods: ["TFC"] },
  }],
  fixes: ["BAL", "TIMMY"],
};

assert(validatePack(samplePack).ok, "validatePack accepts minimal pack");
assert(!validatePack({}).ok, "validatePack rejects empty");
assert(!validatePack({ artcc: "ZDC", aircraft: [] }).ok, "validatePack rejects empty aircraft");

const bad = importPackJson("{not json");
assert(!bad.ok, "importPackJson rejects bad JSON");

const fleet = generateFleet({ artcc: "ZDC", aircraftCount: 5, depAirports: ["KDCA"] });
assert(fleet.aircraft.length === 5, "generateFleet count");
assert(fleet.aircraft.every(a => a.cs), "generateFleet callsigns");

const zdcAirports = airportsForArtcc("ZDC");
assert(zdcAirports.includes("KDCA"), "airportsForArtcc ZDC includes KDCA");

const scenarios = generateScenarios(fleet, { scenarioCount: 10, scenarioMix: ["alt", "direct", "hdg", "spd"] });
assert(scenarios.length === 10, "generateScenarios count");

const byCs = aircraftMap(samplePack);
const g1 = gradeCommand("QZ 340 AAL123 /U /TFC", samplePack.scenarios[0], byCs);
assert(g1.ok, "grade QZ with TFC");

const g2 = gradeCommand("QZ 340 AAL123 /U", samplePack.scenarios[0], byCs);
assert(!g2.ok && g2.reason === "WRONG MODS", "grade rejects missing TFC");

const hdgSc = {
  instruction: "hdg",
  aircraft: "AAL123",
  expect: { verb: "QS", hdg: 270, mode: "NP" },
};
const g3 = gradeCommand("QS 270 AAL123 /U", hdgSc, byCs);
assert(g3.ok, "grade QS heading");

const spdSc = {
  instruction: "spd",
  aircraft: "AAL123",
  expect: { verb: "QS", kt: 280 },
};
const g4 = gradeCommand("QS /280 AAL123 /U", spdSc, byCs);
assert(g4.ok, "grade QS speed");

const quSc = {
  instruction: "direct",
  aircraft: "AAL123",
  expect: { verb: "QU", fix: "BAL" },
};
const g5 = gradeCommand("QU BAL AAL123 /U", quSc, byCs);
assert(g5.ok, "grade QU direct");

const flidSc = {
  instruction: "climb",
  aircraft: "AAL123",
  expect: { verb: "QZ", alt: 340 },
};
const g6 = gradeCommand("QZ 340 /U", flidSc, byCs);
assert(g6.ok, "grade FLID from selection");

assert(normalizeCommand("  qz  340  aal123  /u  ") === "QZ 340 AAL123 /U", "normalizeCommand");

const shuffled = shuffleScenarios([
  { type: "spd" }, { type: "alt" }, { type: "hdg" },
], "tutorial");
assert(shuffled[0].type === "alt", "tutorial order alt first");

const pts = scoreRound({ elapsedMs: 5000, attempts: 1, streak: 3 });
assert(pts.points >= 100, "scoreRound awards points");

const prepared = preparePack(fleet, { scenarioCount: 5 }, "speed");
assert(prepared.scenarios.length <= 5, "preparePack speed limits scenarios");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
