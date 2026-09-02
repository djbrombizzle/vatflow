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
  buildAtcCoverage
} from "../shared/staffing-atc-hours.js";

/* Shape of https://statsim.net/atc/combinedtime/thisweek (trimmed). */
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

/* Shape of the same page through r.jina.ai (plain text, no table markup). */
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

/* ---- parsing ---- */
const fromHtml = parseStatsimAtcHtml(html);
const fromText = parseStatsimAtcText(text);
assert.equal(fromHtml.length, 6, "GND / DEL rows are dropped");
assert.equal(fromText.length, 6, "text rendering yields the same rows");
assert.deepEqual(fromHtml.map(r => r.prefix + "_" + r.type),
  ["EDWW_CTR", "DEN_CTR", "SLC_TWR", "SLC_TWR", "MDW_TWR", "D21_APP"]);
assert.deepEqual(fromText.map(r => r.prefix + "_" + r.type),
  fromHtml.map(r => r.prefix + "_" + r.type));

/* HH:MM → seconds, and the exact sorttable key wins when present. */
assert.equal(fromHtml[0].seconds, 123040);
assert.equal(fromText[0].seconds, 34 * 3600 + 10 * 60);
assert.equal(fromHtml[0].uptimePct, 20.34);
assert.equal(fromText[5].seconds, 5 * 3600);

/* Identity comes from the first callsign only. */
assert.equal(fromHtml[0].callsigns.length, 3);
assert.equal(fromHtml[0].prefix, "EDWW");

assert.equal(parseStatsimAtc(html).length, 6, "dispatches HTML");
assert.equal(parseStatsimAtc(text).length, 6, "dispatches text");

/* Markdown table rows parse too. */
const md = parseStatsimAtcText("| ATL_TWR, ATL_A_TWR | 4:30 | 2.68% |");
assert.equal(md.length, 1);
assert.equal(md[0].prefix, "ATL");
assert.equal(md[0].seconds, 4 * 3600 + 30 * 60);

/* ---- period range ---- */
const range = parseStatsimAtcRange(html);
assert.equal(range.fromMs, Date.UTC(2026, 7, 31, 0, 0));
assert.equal(range.toMs, Date.UTC(2026, 8, 6, 23, 59));
assert.equal(parseStatsimAtcRange("no range here"), null);
assert.equal(atcElapsedHours(range, Date.UTC(2026, 8, 2, 0, 0)), 48,
  "a calendar week that ends in the future only counts elapsed hours");
assert.equal(atcElapsedHours(range, Date.UTC(2026, 9, 1, 0, 0)),
  (range.toMs - range.fromMs) / 3600000, "never counts past the range end");
assert.equal(atcElapsedHours(range, Date.UTC(2026, 7, 1)), 0);

/* The text rendering drops the date line, so the period id has to stand in. */
const wed = Date.UTC(2026, 8, 2, 12, 0);
assert.equal(parseStatsimAtcRange(text), null);
const weekFallback = atcPeriodRange("thisweek", wed);
assert.equal(weekFallback.fromMs, Date.UTC(2026, 7, 31, 0, 0), "week starts Monday UTC");
assert.equal(weekFallback.toMs, Date.UTC(2026, 8, 6, 23, 59));
assert.deepEqual(resolveAtcRange(text, "thisweek", wed), weekFallback);
assert.deepEqual(resolveAtcRange(html, "thisweek", wed), range, "page range wins");
assert.deepEqual(atcPeriodRange("thismonth", wed),
  { fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 8, 30, 23, 59) });
assert.deepEqual(atcPeriodRange("thisyear", wed),
  { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 11, 31, 23, 59) });

/* ---- grouping ---- */
const grouped = groupAtcPositions(fromHtml);
const slc = grouped.find(g => g.prefix === "SLC");
assert.equal(grouped.length, 5, "SLC_C_TWR and SLC_TWR collapse into one facility");
assert.equal(slc.seconds, 44796 + 3600);
assert.equal(slc.groups, 2);
assert.equal(Math.round(slc.hours * 10) / 10, 13.4);
assert.ok(grouped[0].seconds >= grouped[1].seconds, "sorted by time online");

/* ---- coverage math ---- */
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
  extraFacilities: [{ id: "KATL", type: "TWR" }]
});

assert.equal(coverage.matchedPositions, 4, "EDWW is not a US facility");
assert.equal(coverage.skippedPositions, 1);

const byId = Object.fromEntries(coverage.rows.map(r => [r.id, r]));
assert.equal(byId.ZDV.hours, 19.3);
assert.equal(byId.ZDV.coveragePct, 40.2);
assert.equal(byId.ZDV.opsPerHour, 207.3);
assert.equal(byId.ZDV.verdict, "well covered");
assert.equal(byId.KSLC.hours, 13.4);
/* Rates divide by unrounded hours, so 900 / 13.443 h — not 900 / 13.4 h. */
assert.equal(byId.KSLC.opsPerHour, 66.9);
assert.deepEqual(byId.KSLC.prefixes, ["SLC"]);

/* Traffic with no controller time at all is the headline case. */
assert.equal(byId.KATL.hours, 0);
assert.equal(byId.KATL.opsPerHour, null);
assert.equal(byId.KATL.verdict, "unstaffed");
assert.equal(coverage.rows[0].id, "KATL", "sorted by movements");

assert.equal(coverage.totals.CTR, 19.3);
assert.equal(coverage.totals.TWR, 19.8);
assert.equal(coverage.totals.APP, 5);
assert.equal(coverage.totals.facilities, 5);
assert.equal(coverage.totals.movements, 4000 + 900 + 1200 + 600 + 5000);

/* No ATC data at all still returns the traffic-only facilities. */
const empty = buildAtcCoverage({
  positions: [],
  mapFacility,
  movementsFor: id => movements[id] || 0,
  elapsedHours: 0,
  extraFacilities: [{ id: "KATL", type: "TWR" }]
});
assert.equal(empty.rows.length, 1);
assert.equal(empty.rows[0].coveragePct, null);
assert.equal(empty.totals.opsPerHour, null);

console.log("ok");
