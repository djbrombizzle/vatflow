#!/usr/bin/env node
import {
  showAllAircraftEnabled,
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

assert(showAllAircraftEnabled({ showAll: true }) === true, "showAll true");
assert(showAllAircraftEnabled({ showAll: false }) === false, "showAll false");
assert(showAllAircraftEnabled({ showAll: "false" }) === false, "string false is not show-all");
assert(showAllAircraftEnabled({ showAll: 1 }) === false, "truthy non-boolean is not show-all");
assert(showAllAircraftEnabled({}) === false, "missing showAll is off");

assert(freqsMatch(132.65, 132.650) === true, "freq match");
assert(freqsMatch(132.65, 132.66) === false, "freq mismatch");

const pf = new Map([
  ["AAL1", [132.65]],
  ["UAL2", [133.0]],
]);
assert(isTunedToFreq(pf, "aal1", 132.65) === true, "tuned match");
assert(isTunedToFreq(pf, "UAL2", 132.65) === false, "other freq");
assert(isTunedToFreq(pf, "N1", 132.65) === false, "missing pilot");
assert(isTunedToFreq(pf, "AAL1", null) === false, "no controller freq");

const board = [
  { cs: "AAL1", source: "live" },
  { cs: "UAL2", source: "live" },
  { cs: "MAN1", source: "manual" },
  { cs: "DAL3", source: "live" },
];
const connected = new Set(["DAL3"]);
const tuned = (cs) => isTunedToFreq(pf, cs, 132.65);
const cpdlc = (cs) => cs === "DAL3";

assert(
  freqFilterShouldRun({ monitorMode: false, showAll: false, freqMhz: 132.65, canFilter: true }),
  "freq filter runs when controlling with freq",
);
assert(
  !freqFilterShouldRun({ monitorMode: false, showAll: true, freqMhz: 132.65, canFilter: true }),
  "freq filter off when show-all",
);
assert(
  !freqFilterShouldRun({ monitorMode: false, showAll: false, freqMhz: null, canFilter: true }),
  "freq filter off without myFreq",
);

let list = filterBoardList(board, {
  showAll: false,
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: () => false,
});
assert(list.map(a => a.cs).join(",") === "AAL1,MAN1", "unchecked+freq → tuned + manual only");

list = filterBoardList(board, {
  showAll: false,
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "AAL1,MAN1,DAL3", "CPDLC-active kept even if not tuned");

list = filterBoardList(board, {
  showAll: false,
  freqFilterOn: false,
  connected,
  isTuned: tuned,
  isCpdlcActive: cpdlc,
});
assert(list.map(a => a.cs).join(",") === "DAL3", "unchecked without freq → connected only");

list = filterBoardList(board, {
  showAll: true,
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: () => false,
});
assert(list.length === 4, "checked show-all → entire board");

// Stale onFreq must not matter — filter uses live tunedFn
const stale = board.map(a => ({ ...a, onFreq: true }));
list = filterBoardList(stale, {
  showAll: false,
  freqFilterOn: true,
  connected,
  isTuned: tuned,
  isCpdlcActive: () => false,
});
assert(list.map(a => a.cs).join(",") === "AAL1,MAN1", "stale onFreq=true does not show everyone");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
