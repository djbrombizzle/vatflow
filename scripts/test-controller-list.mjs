#!/usr/bin/env node
/**
 * Regression tests for shared/controller-list-core.js (CRC-style controller list).
 * Usage: node scripts/test-controller-list.mjs
 */
import assert from "node:assert/strict";
import {
  fmtFreq, sectorCode, controllerKind, shortRating, parseController, filterRows, groupRows, artccScope, fmtOnline,
} from "../shared/controller-list-core.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

const pos = (o = {}) => ({
  facilityId: "IND", facilityName: "Indianapolis ATCT/TRACON", positionId: "x", positionName: "Departure Radar East",
  positionType: "Tracon", radioName: "Indianapolis Approach", defaultCallsign: "IND_E_APP", frequency: 124950000,
  isPrimary: true, isActive: true, eramData: null, starsData: { subset: 1, sectorId: "E", assumedTcps: ["1E", "1B"] }, ...o,
});
const ctrl = (o = {}, vd = {}) => ({
  artccId: "ZID", primaryFacilityId: "IND", role: "Controller", positions: [pos()], isActive: true, isObserver: false,
  loginTime: "2026-10-22T11:40:22.4779826Z",
  vatsimData: { cid: "1814243", realName: "Ali F", controllerInfo: "line1\r\nline2", userRating: "Student3",
    callsign: "IND_E_APP", facilityType: "ApproachDeparture", primaryFrequency: 124950000, ...vd },
  ...o,
});

t("frequencies format from Hz; observer 199.998 is blank", () => {
  assert.equal(fmtFreq(124950000), "124.950");
  assert.equal(fmtFreq(118100000), "118.100");
  assert.equal(fmtFreq(199998000), "");
  assert.equal(fmtFreq(null), "");
});

t("sector codes: STARS subset+sector, ERAM NAS letter+sector", () => {
  assert.equal(sectorCode(pos(), "ZID"), "1E");
  assert.equal(sectorCode(pos({ positionType: "Artcc", eramData: { sectorId: "83" }, starsData: null }), "ZID"), "I83");
  assert.equal(sectorCode(pos({ eramData: { sectorId: "17" }, starsData: null }), "ZBW"), "B17");
  assert.equal(sectorCode(pos({ starsData: null }), "ZID"), "");
});

t("kinds come from facilityType, observers win, callsign suffix fallback", () => {
  assert.equal(controllerKind(ctrl()), "APP");
  assert.equal(controllerKind(ctrl({}, { facilityType: "Center", callsign: "IND_83_CTR" })), "CTR");
  assert.equal(controllerKind(ctrl({ isObserver: true, role: "Observer" })), "OBS");
  assert.equal(controllerKind(ctrl({}, { facilityType: "Unknown", callsign: "IND_GND" })), "GND");
});

t("ratings shorten like CRC", () => {
  assert.equal(shortRating("Student3"), "S3");
  assert.equal(shortRating("Controller1"), "C1");
  assert.equal(shortRating("Instructor3"), "I3");
  assert.equal(shortRating("Supervisor"), "SUP");
});

t("parseController flattens the primary active position", () => {
  const r = parseController(ctrl({ positions: [pos({ isActive: false, positionName: "Inactive", frequency: 120000000 }), pos({ isPrimary: false })] }));
  assert.equal(r.callsign, "IND_E_APP");
  assert.equal(r.sector, "1E");
  assert.equal(r.freq, "124.950");
  assert.equal(r.position, "Departure Radar East");
  assert.equal(r.info, "line1\nline2");
  assert.equal(r.positions.length, 2);
});

t("filters: ARTCC scope with neighbors, kinds, observers, search", () => {
  const rows = [
    parseController(ctrl()),
    parseController(ctrl({ artccId: "ZAU" }, { cid: "2", callsign: "CHI_CTR", facilityType: "Center", realName: "Bo" })),
    parseController(ctrl({ artccId: "ZBW", isObserver: true, role: "Observer" }, { cid: "3", callsign: "3_OBS" })),
  ];
  const nb = { ZID: ["ZAU", "ZOB"] };
  assert.equal(filterRows(rows, { scope: artccScope("ZID", false, nb) }).length, 1);
  assert.equal(filterRows(rows, { scope: artccScope("ZID", true, nb) }).length, 2);
  assert.equal(filterRows(rows, { showObs: false }).length, 2);
  assert.equal(filterRows(rows, { kinds: new Set(["CTR"]), showObs: false }).length, 1);
  assert.equal(filterRows(rows, { q: "bo" })[0].callsign, "CHI_CTR");
  assert.equal(filterRows(rows, { q: "124.95" }).length, 3);
  assert.equal(artccScope("", true, nb), null);
});

t("grouping puts the home ARTCC first and center rows above approach", () => {
  const rows = [
    parseController(ctrl()),
    parseController(ctrl({ artccId: "ZAU" }, { cid: "2", callsign: "CHI_CTR", facilityType: "Center" })),
    parseController(ctrl({ positions: [pos({ facilityId: "ZID", facilityName: "Indianapolis ARTCC", positionType: "Artcc", eramData: { sectorId: "83" }, starsData: null })] },
      { cid: "4", callsign: "IND_83_CTR", facilityType: "Center" })),
  ];
  const g = groupRows(rows, "ZID");
  assert.deepEqual(g.map(x => x.artcc), ["ZID", "ZAU"]);
  assert.deepEqual(g[0].facilities.map(f => f.id), ["ZID", "IND"]);
  assert.equal(g[0].count, 2);
});

t("time online is h:mm", () => {
  assert.equal(fmtOnline(Date.UTC(2026, 0, 1, 10, 0), Date.UTC(2026, 0, 1, 11, 23)), "1:23");
  assert.equal(fmtOnline(null), "");
});

console.log(`\n${passed} passed`);
