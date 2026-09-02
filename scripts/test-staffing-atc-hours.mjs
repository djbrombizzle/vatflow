#!/usr/bin/env node
/**
 * Regression tests for shared/staffing-atc-hours.js (StatSim ATC time online).
 * Usage: node scripts/test-staffing-atc-hours.mjs
 */
import assert from "assert";
import {
  parseStatsimAtc,
  parseStatsimAtcHtml,
  parseStatsimAtcText,
  parseStatsimAtcRange,
  atcPeriodRange,
  resolveAtcRange,
  atcElapsedHours,
  groupAtcPositions,
  mergeAtcPositionGroups,
  statsimAtcFetchJobs,
  statsimAtcCustomUrl,
  statsimAtcCalendarYearUrl,
  atcTrendYears,
  buildAtcTrendRows,
  buildAtcCoverage,
  analyzeStaffItEffect
} from "../shared/staffing-atc-hours.js";

const html = `
<p>2026-08-31 00:00 - 2026-09-06 23:59</p>
<table class="table sortable" id="positionTable"><thead><tr><th>Callsign</th>
      <th>Time online</th>
      <th>Uptime</th></tr></thead>
  <tbody><tr><td>EDWW_ALR_CTR, EDWW_BOR_CTR, EDWW_CTR</td>
        <td sorttable_customkey="123040">34:10</td>
        <td>20.34%</td></tr><tr><td>DEN_17_CTR, DEN_171_CTR, DEN_25_CTR</td>
        <td sorttable_customkey="69464">19:17</td>
        <td>11.49%</td></tr><tr><td>SLC_C_TWR</td>
        <td sorttable_customkey="44796">12:26</td>
        <td>7.41%</td></tr><tr><td>SLC_TWR</td>
        <td sorttable_customkey="3600">1:00</td>
        <td>0.59%</td></tr><tr><td>MDW_GND</td>
        <td sorttable_customkey="43871">12:11</td>
        <td>7.25%</td></tr><tr><td>MDW_TWR</td>
        <td sorttable_customkey="22975">6:22</td>
        <td>3.80%</td></tr><tr><td>D21_APP, D21_S_APP</td>
        <td sorttable_customkey="18000">5:00</td>
        <td>2.98%</td></tr><tr><td>KMCO_DEL</td>
        <td sorttable_customkey="900">0:15</td>
        <td>0.15%</td></tr></tbody></table>
`;

const text = `Title: Flight simulator statistics for VATSIM

URL Source: https://statsim.net/atc/combinedtime/thisweek

Markdown Content:
Callsign Time online Uptime
EDWW_ALR_CTR, EDWW_BOR_CTR, EDWW_CTR 34:10 20.34%
DEN_17_CTR, DEN_171_CTR, DEN_25_CTR 19:17 11.49%
SLC_C_TWR 12:26 7.41%
SLC_TWR 1:00 0.59%
MDW_GND 12:11 7.25%
MDW_TWR 6:22 3.80%
D21_APP, D21_S_APP 5:00 2.98%
KMCO_DEL 0:15 0.15%
`;

const fromHtml = parseStatsimAtcHtml(html);
const fromText = parseStatsimAtcText(text);
assert.equal(fromHtml.length, 6);
assert.equal(fromText.length, 6);
assert.equal(fromHtml[0].seconds, 123040);

const grouped = groupAtcPositions(fromHtml);
const mapFacility = (prefix, type) => {
  if (type === "CTR") return prefix === "DEN" ? { id: "ZDV", type: "CTR" } : null;
  if (type === "APP") return prefix === "D21" ? { id: "D21", type: "APP" } : null;
  if (type === "TWR") return { id: "K" + prefix, type: "TWR" };
  return null;
};
const movements = { ZDV: 4000, KSLC: 900, KMDW: 1200, D21: 600, KATL: 5000 };
const coverage = buildAtcCoverage({
  positions: grouped,
  mapFacility,
  movementsFor: id => movements[id] || 0,
  elapsedHours: 48,
  extraFacilities: [{ id: "KATL", type: "TWR" }],
  minMovements: 50
});

const byId = Object.fromEntries(coverage.rows.map(r => [r.id, r]));
assert.equal(byId.ZDV.staffed, true);
assert.equal(byId.ZDV.staffTier, "heavy");
assert.equal(byId.ZDV.staffSignal, "staffed");
assert.equal(byId.KATL.staffed, false);
assert.equal(byId.KATL.staffSignal, "busy · no ATC");
assert.ok(!("opsPerHour" in byId.ZDV));

const staffIt = coverage.staffIt;
assert.equal(staffIt.busyCount, 5);
assert.equal(staffIt.staffedCount, 4);
assert.equal(staffIt.unstaffedCount, 1);
assert.equal(staffIt.staffedMedian, 1050);
assert.equal(staffIt.unstaffedMedian, 5000);
assert.ok(staffIt.ratio < 1);
assert.equal(staffIt.counterexamples[0].id, "KATL");
assert.equal(staffIt.leansYes, false);

const bands = analyzeStaffItEffect([
  { movements: 100, hours: 0, type: "TWR" },
  { movements: 200, hours: 0, type: "TWR" },
  { movements: 300, hours: 10, type: "TWR" },
  { movements: 400, hours: 20, type: "APP" },
  { movements: 10, hours: 0, type: "CTR" }
], { minMovements: 50 });
assert.equal(bands.busyCount, 4);
assert.equal(bands.unstaffedCount, 2);
assert.ok(bands.staffedMedian > bands.unstaffedMedian);
assert.ok(bands.correlation > 0);

const empty = buildAtcCoverage({
  positions: [],
  mapFacility,
  movementsFor: id => movements[id] || 0,
  elapsedHours: 0,
  extraFacilities: [{ id: "KATL", type: "TWR" }]
});
assert.equal(empty.rows[0].staffSignal, "busy · no ATC");
assert.equal(empty.staffIt.unstaffedCount, 1);

const yearJobs = statsimAtcFetchJobs("thisyear", Date.UTC(2026, 8, 2, 12, 0, 0));
assert.ok(yearJobs.length >= 9);
assert.ok(statsimAtcCustomUrl(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 31, 23, 59)).includes("custom/"));

const merged = mergeAtcPositionGroups([
  [{ prefix: "DEN", type: "CTR", seconds: 100, uptimePct: 1, callsigns: ["DEN_CTR"], groups: 1 }],
  [{ prefix: "DEN", type: "CTR", seconds: 50, uptimePct: 2, callsigns: ["DEN_17_CTR"], groups: 1 }]
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].seconds, 150);

const trendYears = [2020, 2021, 2022];
const trendPositions = {
  2020: [{ prefix: "DEN", type: "CTR", seconds: 10000 }],
  2021: [{ prefix: "DEN", type: "CTR", seconds: 15000 }],
  2022: [{ prefix: "DEN", type: "CTR", seconds: 20000 }]
};
const trendRows = buildAtcTrendRows(trendPositions, trendYears, (prefix, type) =>
  type === "CTR" && prefix === "DEN" ? { id: "ZDV", type: "CTR" } : null);
assert.equal(trendRows.length, 1);
assert.equal(trendRows[0].hoursByYear[2020], 2.8);
assert.equal(trendRows[0].trendPct, 100);

assert.ok(statsimAtcCalendarYearUrl(2025).includes("2025-01-01T00%3A01"));
assert.deepEqual(atcTrendYears(), [2020, 2021, 2022, 2023, 2024, 2025]);

console.log("ok");
