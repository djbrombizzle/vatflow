#!/usr/bin/env node
/**
 * Tests for scripts/lib/first-landing-core.mjs and the shape of data/first-landing/fields.json.
 * Usage: node scripts/test-first-landing.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  COLS, C, fmtStatsim, parseStatsimTime, weekWindows, parseFlightsPage, fieldCodes, codeIndex, applyFlights,
  nearestDistances, isPaved, parseCsv, stateOf,
} from "./lib/first-landing-core.mjs";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

const row = (html) => html.replace(/\n\s*/g, "\n                                ");
const PAGE = `<h4>Departed (2)</h4><table><thead><tr><th>Callsign</th></tr></thead><tbody>` +
  row(`<tr><td><a href="/flights/detail/101">N123AB</a></td>
<td><a href="/flights/airport/1N7/thisweek">1N7</a></td>
<td><a href="/flights/airport/KABE/thisweek">KABE</a></td>
<td>2026-10-19 13:51</td>
<td>C172</td></tr>`) +
  row(`<tr><td><a href="/flights/detail/102">DAL1</a></td>
<td><a href="/flights/airport/KATL/thisweek">KATL</a></td>
<td><a href="/flights/airport/KTT45/thisweek">KTT45</a></td>
<td>2026-10-19 13:40</td>
<td>A321</td></tr>`) +
  `</tbody></table><h4>Arrived (1)</h4><table><tbody>` +
  row(`<tr><td><a href="/flights/detail/103">N9AB</a></td>
<td><a href="/flights/airport/KCOT/thisweek">KCOT</a></td>
<td><a href="/flights/airport/K79J/thisweek">K79J</a></td>
<td>2026-10-19 12:05</td>
<td>PA28</td></tr>`) + `</tbody></table>`;

t("time formats", () => {
  assert.equal(fmtStatsim(Date.UTC(2026, 9, 19, 14, 5)), "2026-10-19 14:05");
  assert.equal(parseStatsimTime("2026-10-19 14:05"), Date.UTC(2026, 9, 19, 14, 5));
  assert.equal(parseStatsimTime("nope"), null);
});

t("weekWindows: 7-day windows ending at the end time", () => {
  const w = weekWindows(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 16));
  assert.equal(w.length, 3);
  assert.equal(w[0][1], Date.UTC(2026, 0, 8) - 60000);
  assert.equal(w[2][1], Date.UTC(2026, 0, 16));
  assert.deepEqual(weekWindows(5, 5), []);
});

t("parseFlightsPage: both tables and their heading counts", () => {
  const p = parseFlightsPage(PAGE);
  assert.equal(p.dep.length, 2);
  assert.equal(p.arr.length, 1);
  assert.deepEqual(p.counts, { dep: 2, arr: 1 });
  assert.deepEqual(p.dep[0], { id: 101, callsign: "N123AB", origin: "1N7", dest: "KABE", time: Date.UTC(2026, 9, 19, 13, 51), aircraft: "C172" });
  assert.equal(p.arr[0].dest, "K79J");
  assert.deepEqual(parseFlightsPage(""), { dep: [], arr: [], counts: { dep: 0, arr: 0 } });
});

t("fieldCodes: FAA codes both with and without K", () => {
  assert.deepEqual(fieldCodes("K79J", "79J"), ["K79J", "79J"]);
  assert.deepEqual(fieldCodes("1N7", "1N7"), ["1N7", "K1N7"]);
  assert.deepEqual(fieldCodes("TT45", "TT45"), ["TT45"]);
  assert.deepEqual(fieldCodes("KI39", "RGA", "KRGA"), ["KI39", "KRGA", "RGA"]);
  assert.deepEqual(fieldCodes("PGRO", ""), ["PGRO"]);
});

const mk = (ident, local, status = 0, deps = 0) => {
  const r = new Array(COLS.length).fill(0);
  r[C.ident] = ident; r[C.local] = local; r[C.status] = status; r[C.deps] = deps; r[C.lat] = 30; r[C.lon] = -97;
  return r;
};

t("applyFlights: an arrival removes the field, a departure marks it", () => {
  const rows = [mk("K79J", "79J"), mk("1N7", "1N7"), mk("TT45", "TT45")];
  assert.equal(codeIndex(rows).get("K1N7")[C.ident], "1N7");
  const seen = new Set();
  const res = applyFlights(rows, parseFlightsPage(PAGE), seen);
  assert.deepEqual(res.rows.map((r) => r[C.ident]), ["1N7", "TT45"]);
  assert.equal(res.landed.get("K79J").callsign, "N9AB");
  const n7 = res.rows[0];
  assert.equal(n7[C.status], 1);
  assert.equal(n7[C.deps], 1);
  assert.equal(res.rows[1][C.status], 0, "filed to TT45 is not an arrival");
  // The same page again (overlapping window): no double count.
  applyFlights(res.rows, parseFlightsPage(PAGE), seen);
  assert.equal(n7[C.deps], 1);
});

t("applyFlights: the Arrived table's origin is not a departure", () => {
  const rows = [mk("KCOT", "COT")];
  const res = applyFlights(rows, parseFlightsPage(PAGE));
  assert.equal(res.rows[0][C.status], 0);
});

t("nearestDistances: skips itself, caps far ones", () => {
  const others = [[30, -97, "A"], [30.0167, -97, "B"], [35, -90, "C"]];
  const d = nearestDistances([[30, -97, "A"], [35, -90, "C"]], others);
  assert.equal(d[0], 1);
  assert.equal(d[1], 10);
});

t("isPaved, stateOf, parseCsv", () => {
  assert.ok(isPaved("ASPH-G") && isPaved("CONC") && isPaved("PEM") && isPaved("Asphalt"));
  assert.ok(!isPaved("TURF") && !isPaved("GRVL") && !isPaved("WATER") && !isPaved(""));
  assert.equal(stateOf("US-TX", "US"), "TX");
  assert.equal(stateOf("PR-U-A", "PR"), "PR");
  const rows = parseCsv('"id","name","x"\n1,"Smith, ""Bud"" Field",\r\n2,Plain,y\n');
  assert.deepEqual(rows, [{ id: "1", name: 'Smith, "Bud" Field', x: "" }, { id: "2", name: "Plain", x: "y" }]);
});

t("fields.json: shape", () => {
  const doc = JSON.parse(fs.readFileSync(new URL("../data/first-landing/fields.json", import.meta.url), "utf8"));
  assert.deepEqual(doc.cols, COLS);
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(doc.asOf));
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(doc.crawledTo));
  assert.ok(doc.fields.length > 1000);
  const ids = new Set();
  for (const r of doc.fields) {
    assert.equal(r.length, COLS.length, r[0]);
    assert.ok(!ids.has(r[C.ident]), "duplicate " + r[C.ident]);
    ids.add(r[C.ident]);
    assert.ok(Number.isFinite(r[C.lat]) && Number.isFinite(r[C.lon]), r[0]);
    assert.ok("smlw".includes(r[C.type]), r[0]);
    assert.ok(r[C.status] === 0 || r[C.status] === 1, r[0]);
    assert.ok(!r[C.ident].includes("-"), r[0]);
  }
  assert.ok(doc.landed.length > 1000 && doc.landed.every((p) => p.length === 2));
});

console.log(`\n${passed} passed`);
