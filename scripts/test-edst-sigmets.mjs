#!/usr/bin/env node
/**
 * EDST SIGMET filtering: 150 NM range, stale NWS rows, WMO hazard URLs,
 * multi-FIR isigmets, and ICAO series supersession.
 * Usage: node scripts/test-edst-sigmets.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(__dirname, "../shared/edst-sigmets.js"),
  "utf8"
);
const sandbox = { window: {}, globalThis: {}, console };
vm.runInNewContext(src, sandbox, { filename: "edst-sigmets.js" });
const EdstSigmets = sandbox.window.EdstSigmets || sandbox.globalThis.EdstSigmets;
if (!EdstSigmets) throw new Error("EdstSigmets not loaded");

const geo = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../data/artcc-boundaries-high.geojson"),
    "utf8"
  )
);
EdstSigmets._ingestBoundaries(geo);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// --- hazard URLs (NWS phenomenon) ---
assert(
  EdstSigmets.normalizeHazard(
    "http://codes.wmo.int/49-2/SigWxPhenomena/FRQ_TS"
  ) === "frq ts",
  "lowercase WMO URI → frq ts"
);
assert(
  EdstSigmets.normalizeHazard(
    "HTTP://CODES.WMO.INT/49-2/SIGWXPHENOMENA/FRQ_TS"
  ) === "frq ts",
  "uppercase WMO URI → frq ts"
);
assert(EdstSigmets.normalizeHazard("TS") === "ts", "plain TS kept");
assert(
  EdstSigmets.normalizeHazard("CONVECTIVE") === "convective",
  "convective kept"
);

const stub = EdstSigmets._buildTextFromNws(
  {
    fir: "KZMA",
    sequence: "CHARLIE 3",
    phenomenon: "HTTP://CODES.WMO.INT/49-2/SIGWXPHENOMENA/FRQ_TS",
  },
  null
);
assert(
  stub.text.includes("HAZARD: FRQ TS"),
  "stub hazard strips WMO URI"
);
assert(
  !/https?:\/\//i.test(stub.text),
  "stub body has no URL"
);

const fromIsig = EdstSigmets._fromIsigmet(
  {
    seriesId: "CHARLIE 3",
    firId: "KZHU",
    hazard: "TS",
    qualifier: "FRQ",
    rawSigmet: "KZMA KZHU SIGMET CHARLIE 3",
  },
  "KZMA"
);
assert(fromIsig, "fromIsigmet no longer drops non-matching firId");
assert(fromIsig.hazard === "frq ts", "isigmet qualifier+hazard");

// --- multi-FIR bulletin vs single AWC firId ---
const charlie3 = {
  seriesId: "CHARLIE 3",
  firId: "KZHU",
  coords: [
    { lon: -93.95, lat: 28.25 },
    { lon: -84.383, lat: 27.533 },
    { lon: -83.817, lat: 26.183 },
    { lon: -88.617, lat: 24.517 },
    { lon: -93.533, lat: 26.767 },
    { lon: -93.95, lat: 28.25 },
  ],
  rawSigmet:
    "WSNT03 KKCI 211930\nSIGA0C\nKZMA KZHU SIGMET CHARLIE 3 VALID 211930/212330 KKCI-",
};
const india3 = {
  seriesId: "INDIA 3",
  firId: "KZWY",
  coords: [
    { lon: -71.683, lat: 36.467 },
    { lon: -71.517, lat: 31.783 },
    { lon: -77.033, lat: 30.617 },
    { lon: -76.983, lat: 31.967 },
    { lon: -71.683, lat: 36.467 },
  ],
  rawSigmet: "KZWY SIGMET INDIA 3 VALID 211705/212105 KKCI-",
};
const farPacific = {
  seriesId: "ALPHA 1",
  firId: "PHZH",
  coords: [
    { lon: -157.9, lat: 21.3 },
    { lon: -156.0, lat: 22.0 },
    { lon: -157.0, lat: 20.5 },
    { lon: -157.9, lat: 21.3 },
  ],
  rawSigmet: "PHZH SIGMET ALPHA 1",
};

assert(
  EdstSigmets._firsFromIsigmet(charlie3).indexOf("ZMA") !== -1,
  "CHARLIE 3 raw lists ZMA even when firId is KZHU"
);
assert(
  EdstSigmets._isigmetRelevant(charlie3, "ZMA"),
  "CHARLIE 3 relevant to ZMA via raw FIR / geometry"
);
assert(
  EdstSigmets._isigmetRelevant(india3, "ZMA"),
  "INDIA 3 relevant to ZMA via 150 NM (NY Oceanic, firId KZWY)"
);
assert(
  !EdstSigmets._isigmetRelevant(farPacific, "ZMA"),
  "Hawaii SIGMET not relevant to ZMA"
);

// --- 150 NM vs intersection-only ---
assert(
  EdstSigmets._geometryNearArtcc("ZMA", india3.coords, 150) === true,
  "INDIA 3 within 150 NM of ZMA"
);
assert(
  EdstSigmets._geometryNearArtcc("ZMA", india3.coords, 0) === false,
  "INDIA 3 does not intersect ZMA (0 NM)"
);

// Convective analogue of 25E/26E: just outside ZMA, inside 150 NM (33E-like)
const gulfNear = [
  { lat: 29.543, lon: -89.854 },
  { lat: 29.168, lon: -86.68 },
  { lat: 27.5, lon: -86.5 },
  { lat: 27.8, lon: -90.0 },
  { lat: 29.543, lon: -89.854 },
];
assert(
  EdstSigmets._geometryNearArtcc("ZMA", gulfNear, 150) === true,
  "western Gulf convective within 150 NM of ZMA"
);
assert(
  EdstSigmets._geometryNearArtcc("ZMA", gulfNear, 0) === false,
  "western Gulf convective does not intersect ZMA"
);

const virginiaFar = [
  { lat: 37.965, lon: -77.076 },
  { lat: 37.245, lon: -75.753 },
  { lat: 36.5, lon: -76.0 },
  { lat: 37.965, lon: -77.076 },
];
assert(
  EdstSigmets._geometryNearArtcc("ZMA", virginiaFar, 150) === false,
  "VA convective (~365 NM) outside 150 NM"
);

assert(EdstSigmets._SIGMET_PROXIMITY_NM === 150, "proximity default is 150 NM");

// --- stale NWS vs current AWC ---
const airIdx = {
  bySeries: { "29E": {}, "32E": {} },
  list: [{ seriesId: "29E" }],
};
const isigIdx = {
  bySeries: { "CHARLIE 3": {}, "HOTEL 3": {} },
  list: [{ seriesId: "CHARLIE 3" }],
};
assert(
  EdstSigmets._nwsIsStaleAgainstAwc("13E", true, airIdx, true, isigIdx),
  "previous-hour 13E dropped when AWC moved on"
);
assert(
  !EdstSigmets._nwsIsStaleAgainstAwc("29E", true, airIdx, true, isigIdx),
  "current 29E kept"
);
assert(
  EdstSigmets._nwsIsStaleAgainstAwc("CHARLIE 2", true, airIdx, true, isigIdx),
  "CHARLIE 2 dropped when AWC has CHARLIE 3"
);
assert(
  !EdstSigmets._nwsIsStaleAgainstAwc("CHARLIE 3", true, airIdx, true, isigIdx),
  "CHARLIE 3 kept"
);
assert(
  !EdstSigmets._nwsIsStaleAgainstAwc("13E", false, airIdx, false, isigIdx),
  "do not drop NWS if AWC fetch failed"
);
assert(
  !EdstSigmets._nwsIsStaleAgainstAwc(
    "13E",
    true,
    { bySeries: {}, list: [] },
    true,
    { bySeries: {}, list: [] }
  ),
  "do not drop NWS if AWC returned an empty list"
);

const kept = EdstSigmets._dropSupersededIntl([
  { sequence: "CHARLIE 2" },
  { sequence: "CHARLIE 3" },
  { sequence: "21E" },
  { sequence: "HOTEL 3" },
]);
assert(
  kept.map((e) => e.sequence).join() === "CHARLIE 3,21E,HOTEL 3",
  "keep latest ICAO series number; leave convective numbers"
);

// validity windows (unix seconds + ISO with offset)
const now = new Date("2026-08-21T20:10:00Z");
assert(
  EdstSigmets._isCurrentlyValid(
    { start: "2026-08-21T17:55:00+00:00", end: "2026-08-21T19:55:00+00:00" },
    now
  ) === false,
  "13E expired by ISO end time"
);
assert(
  EdstSigmets._isCurrentlyValid(
    { start: 1787342100, end: 1787349300 },
    now
  ) === true,
  "current convective unix window still valid"
);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
