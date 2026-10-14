#!/usr/bin/env node
/**
 * Regression tests for shared/atc-now.js (Pilot page: Where's ATC now).
 * Usage: node scripts/test-atc-now.mjs
 */
import assert from "node:assert/strict";
import { atcNowBoard, approachIndex, parseController, fieldIcao, fmtFlight } from "../shared/atc-now.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const NOW = Date.UTC(2026, 9, 14, 23, 0);

const LL = {
  KIAD: [38.95, -77.46], KDCA: [38.85, -77.04], KBWI: [39.18, -76.67], KBOS: [42.36, -71.01], KJFK: [40.64, -73.78],
  KLGA: [40.78, -73.87], KATL: [33.64, -84.43], KMCO: [28.43, -81.31], KLAX: [33.94, -118.41], KCLT: [35.21, -80.94],
  KRIC: [37.51, -77.32], EGLL: [51.47, -0.45], KMSP: [44.88, -93.22],
};
const airportLL = icao => LL[String(icao).toUpperCase()] || null;
const artccFor = (lat, lon) => lat > 41 && lon > -74 ? "ZBW" : lat > 40 && lon > -75 ? "ZNY" : lon > -79 && lat > 36 ? "ZDC"
  : lat < 31 ? "ZJX" : lon < -110 ? "ZLA" : lat > 43 ? "ZMP" : "ZTL";
const apIdx = approachIndex(
  { PCT: ["BWI", "DCA", "IAD", "PCT", "RIC"], N90: ["JFK", "LGA", "NY"], A90: ["A90", "BOS"] },
  { KIAD: "IAD", KDCA: "DCA", KBWI: "BWI", KRIC: "RIC", KJFK: "JFK", KLGA: "LGA", KBOS: "BOS" },
);
const ctl = (callsign, facility = 4) => ({ callsign, facility, frequency: "118.000" });
const flying = (arr, dep = "KXXX") => ({ groundspeed: 450, flight_plan: { arrival: arr, departure: dep } });

t("callsigns parse into position kinds; observers and FSS are skipped", () => {
  assert.equal(parseController(ctl("BOS_TWR")).kind, "TWR");
  assert.equal(parseController(ctl("NY_CAM_CTR", 6)).prefix, "NY");
  assert.equal(parseController(ctl("PCT_DEP", 5)).kind, "APP");
  assert.equal(parseController(ctl("DC_OBS", 0)), null);
  assert.equal(parseController(ctl("BOS_TWR", 1)), null);
  assert.equal(parseController(ctl("ZDC_FSS", 1)), null);
});

t("field prefixes resolve to ICAOs (3-letter US, 4-letter ICAO, Alaska/Hawaii)", () => {
  assert.equal(fieldIcao("BOS", airportLL), "KBOS");
  assert.equal(fieldIcao("EGLL", airportLL), "EGLL");
  assert.equal(fieldIcao("HNL", airportLL), "PHNL");
  assert.equal(fieldIcao("ZZZ", airportLL), null);
});

t("an approach callsign covers every field in its TRACON", () => {
  assert.deepEqual([...apIdx.PCT].sort(), ["KBWI", "KDCA", "KIAD", "KRIC"]);
  assert.ok(apIdx.JFK.has("KLGA"));   // JFK_APP is N90
});

t("staffed fields are listed best covered first, with flight time, inbound and the origin's own ATC", () => {
  const feed = {
    controllers: [ctl("BOS_TWR"), ctl("BOS_APP", 5), ctl("BOS_CTR", 6), ctl("ATL_TWR"), ctl("ZDC_CTR", 6), ctl("IAD_GND", 3), ctl("LAX_TWR")],
    atis: [{ callsign: "KBOS_ATIS", atis_code: "K" }],
    pilots: [flying("KBOS"), flying("KBOS"), flying("KATL"), { groundspeed: 0, flight_plan: { departure: "KIAD", arrival: "KBOS" } }],
  };
  const b = atcNowBoard({ feed, from: "KIAD", airportLL, artccFor, apIdx, now: NOW, radiusNm: 800 });
  assert.deepEqual(b.from.positions.map(p => p.callsign), ["IAD_GND", "ZDC_CTR"]);
  assert.equal(b.from.departing, 1);
  const ids = b.rows.map(r => r.icao);
  assert.equal(ids[0], "KBOS");                           // TWR + APP + CTR, and a DC partner
  const bos = b.rows[0];
  assert.deepEqual(bos.levels, ["TWR", "APP", "CTR"]);
  assert.equal(bos.inbound, 2); assert.equal(bos.atis, "K"); assert.ok(bos.partner);
  assert.ok(bos.flightMin > 60 && bos.flightMin < 90, String(bos.flightMin));
  assert.ok(ids.indexOf("KATL") < ids.indexOf("KRIC"));    // local tower beats center only
  assert.equal(b.rows.find(r => r.icao === "KRIC").top, "CTR");
  assert.ok(!ids.includes("KDCA"));                        // 20 nm away: not a flight
  assert.ok(!ids.includes("KLAX"));                        // beyond 800 nm
  assert.ok(!ids.includes("KIAD"));
});

t("fields closer than 40 nm and fields with nobody online are left out", () => {
  const b = atcNowBoard({ feed: { controllers: [ctl("BWI_TWR"), ctl("RIC_TWR")] }, from: "KIAD", airportLL, artccFor, apIdx, now: NOW });
  assert.deepEqual(b.rows.map(r => r.icao), ["KRIC"]);    // BWI is 39 nm from IAD
});

t("an event starting soon lists its field even with no ATC online yet", () => {
  const events = [{ name: "MCO Halloween FNO", startMs: NOW + 60 * 60000, endMs: NOW + 4 * 3600000, airports: ["KMCO"] },
    { name: "Tomorrow", startMs: NOW + 20 * 3600000, endMs: NOW + 23 * 3600000, airports: ["KCLT"] }];
  const b = atcNowBoard({ feed: {}, from: "KIAD", airportLL, artccFor, apIdx, events, now: NOW });
  assert.deepEqual(b.rows.map(r => r.icao), ["KMCO"]);
  assert.equal(b.rows[0].event.name, "MCO Halloween FNO");
});

t("unknown departure field gives null", () => {
  assert.equal(atcNowBoard({ feed: {}, from: "XXXX", airportLL }), null);
});

t("flight time format", () => {
  assert.equal(fmtFlight(55), "55 min");
  assert.equal(fmtFlight(100), "1 h 40");
});

console.log(`\n${passed} passed`);
