#!/usr/bin/env node
import {
  showAllAircraftEnabled,
  normalizeAclFilter,
  freqsMatch,
  isTunedToFreq,
  filterBoardList,
  filterCpdlcOnFreqOverlay,
  freqFilterShouldRun,
  groundSpeedKt,
  isOnGround,
  GROUND_SPEED_KT,
  depIcaoOf,
  parseGroundDep,
  matchesGroundDep,
} from "../shared/acl-display-filter.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

assert(normalizeAclFilter({ aclFilter: "freq" }) === "freq", "aclFilter freq");
assert(normalizeAclFilter({ showAll: true }) === "all", "legacy showAll → all");
assert(normalizeAclFilter({ showCpdlcOnly: true }) === "cpdlc", "legacy showCpdlcOnly → cpdlc");
assert(normalizeAclFilter({}) === "auto", "default auto");
assert(showAllAircraftEnabled({ aclFilter: "all" }) === true, "showAll via mode");
assert(showAllAircraftEnabled({ aclFilter: "freq" }) === false, "freq is not show-all");

assert(freqsMatch(132.65, 132.650) === true, "freq match");
assert(freqsMatch(132.65, 132.66) === false, "freq mismatch");

const pf = new Map([
  ["AAL1", [132.65]],
  ["UAL2", [133.0]],
  ["DAL3", [132.65]],
]);
assert(isTunedToFreq(pf, "aal1", 132.65) === true, "tuned match");
assert(isTunedToFreq(pf, "UAL2", 132.65) === false, "other freq");

const board = [
  { cs: "AAL1", source: "live" }, // on freq, not CPDLC
  { cs: "UAL2", source: "live" }, // other freq
  { cs: "MAN1", source: "manual" },
  { cs: "DAL3", source: "live" }, // on freq + CPDLC
  { cs: "JBU4", source: "live" }, // CPDLC, not on freq
];
const connected = new Set(["DAL3", "JBU4"]);
const tuned = (cs) => isTunedToFreq(pf, cs, 132.65);
const cpdlc = (cs) => connected.has(cs);

assert(
  freqFilterShouldRun({ monitorMode: false, mode: "freq", freqMhz: 132.65, canFilter: true }),
  "freq filter runs in freq mode",
);
assert(
  !freqFilterShouldRun({ monitorMode: false, mode: "all", freqMhz: 132.65, canFilter: true }),
  "freq filter off in all mode",
);

let list = filterBoardList(board, {
  mode: "auto",
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "AAL1,MAN1,DAL3,JBU4", "auto+freq → tuned + CPDLC-active + manual");

list = filterBoardList(board, {
  mode: "freq",
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "AAL1,MAN1,DAL3", "freq → tuned only (no off-freq CPDLC)");

list = filterBoardList(board, {
  mode: "cpdlc",
  freqFilterOn: true,
  cpdlcRequireFreq: false,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "MAN1,DAL3,JBU4", "classic cpdlc → connected only");

list = filterBoardList(board, {
  mode: "cpdlc",
  freqFilterOn: true,
  cpdlcRequireFreq: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "MAN1,DAL3", "EDST cpdlc → on-freq AND connected");

list = filterBoardList(board, {
  mode: "cpdlc",
  freqFilterOn: false,
  cpdlcRequireFreq: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "MAN1", "EDST cpdlc without controller freq → manual only");

list = filterBoardList(board, {
  mode: "freq",
  freqFilterOn: false,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "MAN1", "freq without controller freq → manual only");

list = filterBoardList(board, {
  mode: "all",
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.length === 5, "all → entire board");

// Off-frequency CPDLC must not remain on freq / EDST-cpdlc lists
list = filterBoardList(board, {
  mode: "freq",
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(!list.some(a => a.cs === "JBU4"), "freq hides off-frequency CPDLC");
list = filterBoardList(board, {
  mode: "cpdlc",
  freqFilterOn: true,
  cpdlcRequireFreq: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(!list.some(a => a.cs === "JBU4"), "EDST cpdlc hides off-frequency CPDLC");
assert(!list.some(a => a.cs === "UAL2"), "EDST cpdlc hides off-frequency non-CPDLC");

list = filterCpdlcOnFreqOverlay(board, {
  freqFilterOn: true,
  connected,
  isTuned: tuned,
});
assert(list.map(a => a.cs).join(",") === "DAL3", "overlay → on-freq AND CPDLC only");
assert(!list.some(a => a.source === "manual"), "overlay excludes manual strips");
assert(!list.some(a => a.cs === "AAL1"), "overlay excludes on-freq without CPDLC");
assert(!list.some(a => a.cs === "JBU4"), "overlay excludes off-freq CPDLC");

list = filterCpdlcOnFreqOverlay(board, {
  freqFilterOn: false,
  connected,
  isTuned: tuned,
});
assert(list.length === 0, "overlay without controller freq → empty (no sector leak)");

// ---- ground filter (SORT → SHOW GROUND A/C) ----
assert(GROUND_SPEED_KT === 60, "ground threshold is 60 kt");
assert(groundSpeedKt({ gs: 0 }) === 0, "numeric gs 0 kept (not treated as unknown)");
assert(groundSpeedKt({ gs: 12 }) === 12, "numeric gs wins");
assert(groundSpeedKt({ hs: "/450" }) === 450, "gs parsed from hs string");
assert(groundSpeedKt({ hs: "/" }) === null, "unknown gs → null");
assert(isOnGround({ gs: 0 }) === true, "stopped aircraft is on the ground");
assert(isOnGround({ gs: 59 }) === true, "59 kt is on the ground");
assert(isOnGround({ gs: 60 }) === false, "60 kt is airborne/rolling");
assert(isOnGround({ hs: "/" }) === false, "unknown gs is not on the ground");

const gndBoard = [
  { cs: "AAL1", source: "live", gs: 0, dep: "KATL", cat: "DEP" },     // at the gate, ATL
  { cs: "UAL2", source: "live", gs: 18, dep: "KMCO", cat: "DEP" },    // taxiing, MCO
  { cs: "MAN1", source: "manual", route: "KATL ERLIN2 SPA" },         // manual strip off ATL
  { cs: "DAL3", source: "live", gs: 140, dep: "KATL", cat: "DEP" },   // rolling out of ATL
  { cs: "JBU4", source: "live", gs: 450, dep: "KATL", cat: "DEP" },   // enroute
  { cs: "SWA5", source: "live", hs: "/25", dep: "KATL", cat: "DEP" }, // taxiing, gs only in hs
  { cs: "NKS6", source: "live", gs: 5, dep: "KCLT", cat: "ADJ" },     // ground in the next FIR
];
// Everything on the ground list must be logged on to CPDLC (KUSA).
const gndConnected = new Set(["AAL1", "UAL2", "SWA5", "DAL3", "JBU4", "NKS6"]);
const gndOpts = {
  mode: "ground",
  freqFilterOn: true,
  connected: gndConnected,
  isTuned: () => false,
};
list = filterBoardList(gndBoard, gndOpts);
assert(
  list.map(a => a.cs).join(",") === "AAL1,UAL2,MAN1,SWA5",
  "ground, no airport → CPDLC aircraft on the ground in our FIR + manual strips, regardless of frequency",
);
assert(!list.some(a => a.cs === "NKS6"), "ground, no airport → ADJ (other FIR) ground traffic excluded");

list = filterBoardList(gndBoard, { ...gndOpts, freqFilterOn: false });
assert(
  list.map(a => a.cs).join(",") === "AAL1,UAL2,MAN1,SWA5",
  "ground list does not depend on a known controller frequency",
);

list = filterBoardList(gndBoard, { ...gndOpts, connected: new Set(["AAL1"]) });
assert(
  list.map(a => a.cs).join(",") === "AAL1,MAN1",
  "aircraft not logged on to KUSA are not listed (manual strips stay)",
);
list = filterBoardList(gndBoard, { ...gndOpts, connected: new Set() });
assert(
  list.map(a => a.cs).join(",") === "MAN1",
  "nobody logged on → only the controller's own manual strips",
);

list = filterBoardList(gndBoard, { ...gndOpts, groundDep: "KATL" });
assert(
  list.map(a => a.cs).join(",") === "AAL1,MAN1,SWA5",
  "ground + KATL → only KATL departures still on the ground",
);
list = filterBoardList(gndBoard, { ...gndOpts, groundDep: "atl" });
assert(
  list.map(a => a.cs).join(",") === "AAL1,MAN1,SWA5",
  "ground airport box is case-insensitive and accepts the 3-letter id",
);
list = filterBoardList(gndBoard, { ...gndOpts, groundDep: "KATL, KMCO" });
assert(
  list.map(a => a.cs).join(",") === "AAL1,UAL2,MAN1,SWA5",
  "ground box accepts several airports",
);
list = filterBoardList(gndBoard, { ...gndOpts, groundDep: "KCLT" });
assert(
  list.map(a => a.cs).join(",") === "NKS6",
  "an explicit airport reaches ground traffic outside our own FIR",
);
list = filterBoardList(gndBoard, { ...gndOpts, groundDep: "KZZZ" });
assert(list.length === 0, "ground + unknown airport → empty list");

assert(depIcaoOf({ dep: "kbos" }) === "KBOS", "depIcaoOf uses the dep field");
assert(depIcaoOf({ route: "KATL ERLIN2 SPA" }) === "KATL", "depIcaoOf falls back to the route's first fix");
assert(depIcaoOf({ route: "" }) === "", "depIcaoOf with nothing to go on → empty");
assert(parseGroundDep("katl,  kmco ").join(",") === "KATL,KMCO", "parseGroundDep normalises the typed box");
assert(parseGroundDep("").length === 0, "blank box → no airports");
assert(matchesGroundDep({ cat: "DEP" }, "") === true, "blank box keeps our own FIR rows");
assert(matchesGroundDep({ cat: "ADJ" }, "") === false, "blank box drops ADJ rows");
assert(matchesGroundDep({ dep: "KATL" }, "KATL") === true, "airport match");
assert(matchesGroundDep({ dep: "KATL", cat: "ADJ" }, "KATL") === true, "typed airport overrides the FIR default");
assert(matchesGroundDep({ dep: "KMCO" }, "KATL") === false, "airport mismatch");
assert(normalizeAclFilter({ aclFilter: "ground" }) === "ground", "aclFilter ground");
assert(showAllAircraftEnabled({ aclFilter: "ground" }) === false, "ground is not show-all");
assert(
  !freqFilterShouldRun({ monitorMode: false, mode: "ground", freqMhz: 132.65, canFilter: true }),
  "freq filter off in ground mode",
);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
