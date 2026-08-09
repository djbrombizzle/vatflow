#!/usr/bin/env node
import {
  showAllAircraftEnabled,
  normalizeAclFilter,
  freqsMatch,
  isTunedToFreq,
  filterBoardList,
  freqFilterShouldRun,
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
  mode: "all",
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.length === 5, "all → entire board");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
