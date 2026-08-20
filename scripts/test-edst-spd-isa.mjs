#!/usr/bin/env node
import {
  gsToMach,
  gsToIas,
  machLabel,
  machUplinkToken,
  isaMach1Kt,
} from "../shared/edst-spd-isa.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else console.log("ok:", msg);
}

assert(Math.abs(isaMach1Kt(360) - 574) < 4, "ISA Mach 1 at FL360 ~574 kt");
assert(machLabel(0.79) === "M079", "machLabel 0.79 → M079");
assert(machUplinkToken(0.79) === "MACH .79", "uplink MACH .79");
assert(gsToMach(471, 360) > 0.784 && gsToMach(471, 360) < 0.786, "471 kt GS at FL360 → M.79");
assert(machLabel(gsToMach(471, 360)) === "M079", "471@FL360 label M079");

const ias = gsToIas(471, 360);
assert(ias > 240 && ias < 290, "471 kt GS at FL360 → ~260 KIAS (got "+ias.toFixed(0)+")");

assert(gsToMach(0, 360) === 0, "zero GS");
assert(gsToMach(300, 180) > 0.4 && gsToMach(300, 180) < 0.55, "low-alt Mach uses ISA SoS");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
