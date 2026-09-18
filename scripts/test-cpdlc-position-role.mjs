#!/usr/bin/env node
import {
  positionSuffix,
  positionRole,
  canUseCpdlc,
  allowedAclModes,
  clampAclMode,
  isGroundOnly,
  findMyPosition,
  positionField,
  ROLE_FULL,
  ROLE_GROUND,
  ROLE_NONE,
} from "../shared/cpdlc-position-role.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

assert(positionSuffix("ZTL_CTR") === "CTR", "suffix of ZTL_CTR");
assert(positionSuffix("ZTL_12_CTR") === "CTR", "suffix of a numbered sector");
assert(positionSuffix("katl_twr") === "TWR", "suffix is case-insensitive");
assert(positionSuffix("ZTL") === "", "no suffix without an underscore");
assert(positionSuffix("ZTL_") === "", "trailing underscore is not a suffix");

assert(positionRole("ZTL_CTR") === ROLE_FULL, "center is full access");
assert(positionRole("ZJX_FSS") === ROLE_FULL, "FSS is treated as center-class");
for (const cs of ["KATL_DEL", "KATL_GND", "KATL_TWR", "A80_APP", "KATL_DEP"]) {
  assert(positionRole(cs) === ROLE_GROUND, `${cs} is ground-only`);
}
for (const cs of ["KATL_ATIS", "ZTL_OBS", "VATUSA_SUP", "", null, "DAL123"]) {
  assert(positionRole(cs) === ROLE_NONE, `${cs || "(empty)"} is not a CPDLC position`);
}

assert(canUseCpdlc("KATL_GND") === true, "ground controller may use CPDLC");
assert(canUseCpdlc("ZTL_CTR") === true, "center may use CPDLC");
assert(canUseCpdlc("KATL_ATIS") === false, "ATIS may not");

assert(allowedAclModes("ZTL_CTR").join(",") === "all,cpdlc,freq,ground", "center gets every filter");
assert(allowedAclModes("KATL_TWR").join(",") === "ground", "tower gets GROUND only");
assert(allowedAclModes("KATL_OBS").length === 0, "observer gets none");

assert(clampAclMode("all", "ZTL_CTR") === "all", "center keeps ALL");
assert(clampAclMode("ground", "ZTL_CTR") === "ground", "center may still pick GROUND");
assert(clampAclMode("all", "KATL_TWR") === "ground", "tower asking for ALL is held to GROUND");
assert(clampAclMode("cpdlc", "KATL_GND") === "ground", "ground asking for CPDLC is held to GROUND");
assert(clampAclMode("ground", "KATL_GND") === "ground", "tower asking for GROUND is fine");
assert(clampAclMode("freq", "") === "freq", "unknown position is left alone (hub owns sign-in)");
assert(clampAclMode("freq", "KATL_ATIS") === "freq", "a non-CPDLC position is left to the hub, not silently re-filtered");

assert(isGroundOnly("KATL_TWR") === true, "tower is ground-only");
assert(isGroundOnly("ZTL_CTR") === false, "center is not");
assert(isGroundOnly("") === false, "unknown position is not locked");

const controllers = [
  { cid: 1111111, callsign: "ZTL_CTR" },
  { cid: 2222222, callsign: "KATL_TWR" },
];
assert(findMyPosition(controllers, 2222222).callsign === "KATL_TWR", "own position found by CID");
assert(findMyPosition(controllers, "1111111").callsign === "ZTL_CTR", "CID compared as text");
assert(findMyPosition(controllers, 9999999) === null, "not on position → null");
assert(findMyPosition(controllers, "") === null, "no CID → null");

assert(positionField("KATL_TWR") === "KATL", "tower position names its field");
assert(positionField("KATL_GND") === "KATL", "ground position names its field");
assert(positionField("ATL_DEL") === "ATL", "3-letter clearance position");
assert(positionField("KATL_1_GND") === "KATL", "numbered ground position");
assert(positionField("A80_APP") === "", "approach is a TRACON, not a field");
assert(positionField("KATL_DEP") === "", "departure is a TRACON, not a field");
assert(positionField("ZTL_CTR") === "", "center is not tied to one field");
assert(positionField("") === "", "no callsign → no field");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
