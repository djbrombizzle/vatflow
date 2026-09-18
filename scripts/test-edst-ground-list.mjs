#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedArtccBoundaries } from "../shared/artcc-scope.js";
import { seedAirports } from "../shared/fca-metering.js";
import {
  buildGroundList,
  mergeGroundRows,
  parseApts,
  aptMatches,
  GROUND_GS_KT,
} from "../shared/edst-ground-list.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
seedArtccBoundaries(JSON.parse(
  readFileSync(join(__dirname, "..", "data", "artcc-boundaries-high.geojson"), "utf8"),
));
seedAirports({
  KATL: [33.6367, -84.4281],
  KMCO: [28.4312, -81.3081],
  KJFK: [40.6413, -73.7781],
});

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

assert(GROUND_GS_KT === 60, "ground threshold is 60 kt");
assert(parseApts("katl, kmco").join(",") === "KATL,KMCO", "airport box parsed");
assert(aptMatches("KATL", ["ATL"]) === true, "3-letter entry matches the ICAO");
assert(aptMatches("KATL", ["KMCO"]) === false, "other airport does not match");

const fp = (dep, arr, route) => ({
  departure: dep, arrival: arr, route, aircraft_short: "B739", altitude: "35000", deptime: "1830",
});
const vatsim = {
  pilots: [
    // DAL123 at the gate at KATL — the case the hub ACL feed never sends.
    { callsign: "DAL123", cid: 1234567, groundspeed: 0, altitude: 1026, heading: 90,
      latitude: 33.6367, longitude: -84.4281, transponder: "2000", flight_plan: fp("KATL", "KJFK", "ERLIN2 SPA") },
    // Taxiing at KATL.
    { callsign: "DAL456", cid: 1234568, groundspeed: 14, altitude: 1030,
      latitude: 33.64, longitude: -84.43, transponder: "1200", flight_plan: fp("KATL", "KMCO", "DIRECT") },
    // Rolling — past the ground cutoff.
    { callsign: "DAL789", cid: 1234569, groundspeed: 95, altitude: 1200,
      latitude: 33.65, longitude: -84.42, flight_plan: fp("KATL", "KJFK", "DIRECT") },
    // On the ground at KMCO (ZJX, not ZTL).
    { callsign: "NKS10", cid: 1234570, groundspeed: 3, altitude: 96,
      latitude: 28.4312, longitude: -81.3081, flight_plan: fp("KMCO", "KATL", "DIRECT") },
    // Enroute over ZTL.
    { callsign: "AAL900", cid: 1234571, groundspeed: 450, altitude: 35000,
      latitude: 33.9, longitude: -84.5, flight_plan: fp("KJFK", "KATL", "DIRECT") },
  ],
};

let built = buildGroundList("ZTL", vatsim);
assert(built.items.map(a => a.cs).join(",") === "DAL123,DAL456",
  "no airport typed → ground traffic departing our own ARTCC");
assert(!built.items.some(a => a.cs === "NKS10"), "another ARTCC's ground traffic is excluded");
assert(!built.items.some(a => a.cs === "DAL789"), "aircraft at 95 kt is not on the ground");

assert(buildGroundList("KZTL", vatsim).count === 2, "KZTL and ZTL resolve the same");

built = buildGroundList("ZTL", vatsim, { apts: "KMCO" });
assert(built.items.map(a => a.cs).join(",") === "NKS10",
  "a typed airport reaches ground traffic outside our own ARTCC");
built = buildGroundList("ZTL", vatsim, { apts: "atl" });
assert(built.items.map(a => a.cs).join(",") === "DAL123,DAL456", "typed airport, 3-letter, case-insensitive");
built = buildGroundList("ZTL", vatsim, { apts: "KZZZ" });
assert(built.count === 0, "unknown airport → nothing");
built = buildGroundList("", vatsim);
assert(built.count === 0, "no ARTCC and no airport → nothing (never the whole network)");
built = buildGroundList("", vatsim, { apts: "KATL" });
assert(built.count === 2, "a typed airport works without a known ARTCC");

const row = buildGroundList("ZTL", vatsim).items[0];
assert(row.cs === "DAL123", "row callsign");
assert(row.source === "ground", "rows are tagged as ground-sourced");
assert(row.gs === 0 && row.hs === "/0", "stopped aircraft reports 0 kt");
assert(row.alt === 10, "altitude carried as a flight level");
assert(row.type === "B739", "type from the flight plan");
assert(row.dep === "KATL" && row.arr === "KJFK", "dep/arr carried");
assert(row.route === "KATL ERLIN2 SPA KJFK", "route text built like the hub rows");
assert(row.cat === "DEP", "categorised as a departure, so the FIR default keeps it");
assert(row.squawk === "2000", "squawk carried");

const hubRow = { cs: "DAL123", source: "live", gs: 0 };
let merged = mergeGroundRows([hubRow], buildGroundList("ZTL", vatsim).items);
assert(merged.length === 2, "merge adds only the rows the hub did not send");
assert(merged[0] === hubRow, "the hub's own row wins for a duplicate callsign");
assert(merged.some(a => a.cs === "DAL456"), "the missing ground aircraft is added");
merged = mergeGroundRows([], []);
assert(merged.length === 0, "merging nothing is empty");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
