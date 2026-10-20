#!/usr/bin/env node
/**
 * Tests for scripts/lib/first-landing-core.mjs and the shape of data/first-landing/fields.json.
 * Usage: node scripts/test-first-landing.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  COLS, C, fmtStatsim, parseStatsimTime, weekWindows, parseFlightsPage, fieldCodes, codeIndex, applyFlights,
  nearestDistances, parseCsv, faaCycle, faaAptCsvUrl, unzipEntry, faaTitle, faaFields, faaCodes, xplaneCodes,
} from "./lib/first-landing-core.mjs";
import zlib from "node:zlib";

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

t("parseCsv", () => {
  const rows = parseCsv('"id","name","x"\n1,"Smith, ""Bud"" Field",\r\n2,Plain,y\n');
  assert.deepEqual(rows, [{ id: "1", name: 'Smith, "Bud" Field', x: "" }, { id: "2", name: "Plain", x: "y" }]);
});

t("FAA cycle and download URL", () => {
  assert.equal(faaCycle(Date.UTC(2026, 9, 20)), Date.UTC(2026, 9, 1));
  assert.equal(faaCycle(Date.UTC(2026, 9, 29)), Date.UTC(2026, 9, 29));
  assert.equal(faaCycle(Date.UTC(2026, 8, 30)), Date.UTC(2026, 8, 3));
  assert.equal(faaAptCsvUrl(Date.UTC(2026, 9, 1)), "https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_APT_CSV.zip");
});

t("unzipEntry: stored and deflated files", () => {
  // A two-file zip built by hand: a.txt stored, b.txt deflated.
  const files = [["a.txt", Buffer.from("plain"), 0], ["b.txt", Buffer.from("squeezed squeezed squeezed"), 8]];
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data, method] of files) {
    const body = method ? zlib.deflateRawSync(data) : data, nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, body); centrals.push(ch, nb);
    off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const zip = Buffer.concat([...locals, cd, end]);
  assert.equal(unzipEntry(zip, "a.txt").toString(), "plain");
  assert.equal(unzipEntry(zip, "b.txt").toString(), "squeezed squeezed squeezed");
  assert.throws(() => unzipEntry(zip, "c.txt"), /not in zip/);
});

t("faaFields: open airports and seaplane bases only, runways joined", () => {
  const base = [
    { SITE_NO: "1", SITE_TYPE_CODE: "A", ARPT_ID: "42M", ICAO_ID: "", ARPT_STATUS: "O", COUNTRY_CODE: "US", STATE_CODE: "MO", ARPT_NAME: "THAYER MEML", CITY: "THAYER", LAT_DECIMAL: "36.52", LONG_DECIMAL: "-91.57", ELEV: "790.3", FACILITY_USE_CODE: "PU" },
    { SITE_NO: "2", SITE_TYPE_CODE: "A", ARPT_ID: "CJJ", ICAO_ID: "KCJJ", ARPT_STATUS: "O", COUNTRY_CODE: "US", STATE_CODE: "IA", ARPT_NAME: "ELLEN CHURCH FLD", CITY: "CRESCO", LAT_DECIMAL: "43.4", LONG_DECIMAL: "-92.1", ELEV: "", FACILITY_USE_CODE: "PU" },
    { SITE_NO: "3", SITE_TYPE_CODE: "A", ARPT_ID: "0MI6", ICAO_ID: "", ARPT_STATUS: "CI", COUNTRY_CODE: "US", STATE_CODE: "MI", ARPT_NAME: "X", CITY: "Y", LAT_DECIMAL: "1", LONG_DECIMAL: "1", ELEV: "1", FACILITY_USE_CODE: "PR" },
    { SITE_NO: "4", SITE_TYPE_CODE: "H", ARPT_ID: "07MN", ICAO_ID: "", ARPT_STATUS: "O", COUNTRY_CODE: "US", STATE_CODE: "MN", ARPT_NAME: "X", CITY: "Y", LAT_DECIMAL: "1", LONG_DECIMAL: "1", ELEV: "1", FACILITY_USE_CODE: "PR" },
    { SITE_NO: "5", SITE_TYPE_CODE: "C", ARPT_ID: "16WI", ICAO_ID: "", ARPT_STATUS: "O", COUNTRY_CODE: "US", STATE_CODE: "WI", ARPT_NAME: "SWEETWATER BAY", CITY: "Z", LAT_DECIMAL: "1", LONG_DECIMAL: "1", ELEV: "1", FACILITY_USE_CODE: "PR" },
    { SITE_NO: "6", SITE_TYPE_CODE: "A", ARPT_ID: "CYQX", ICAO_ID: "", ARPT_STATUS: "O", COUNTRY_CODE: "CA", STATE_CODE: "", ARPT_NAME: "X", CITY: "Y", LAT_DECIMAL: "1", LONG_DECIMAL: "1", ELEV: "1", FACILITY_USE_CODE: "PU" },
  ];
  const rwy = [
    { SITE_NO: "1", RWY_LEN: "4200", SURFACE_TYPE_CODE: "ASPH", RWY_LGT_CODE: "MED" },
    { SITE_NO: "1", RWY_LEN: "2000", SURFACE_TYPE_CODE: "TURF", RWY_LGT_CODE: "" },
    { SITE_NO: "2", RWY_LEN: "3000", SURFACE_TYPE_CODE: "TURF-GRVL", RWY_LGT_CODE: "" },
  ];
  const m = faaFields(base, rwy);
  const t42 = m.get("42M");
  assert.equal(t42.open, true);
  assert.equal(t42.name, "Thayer Memorial");
  assert.equal(t42.elev, 790);
  assert.deepEqual(t42.rwy, { len: 4200, paved: 1, lit: 1 });
  assert.deepEqual(m.get("CJJ").rwy, { len: 3000, paved: 0, lit: 0 });
  assert.equal(m.get("CJJ").elev, null);
  assert.equal(m.get("0MI6").open, false, "closed indefinitely");
  assert.equal(m.get("07MN").open, false, "heliport");
  assert.equal(m.get("16WI").open, true);
  assert.equal(m.get("16WI").type, "w");
  assert.equal(m.get("CYQX").open, false, "outside the US");
  assert.deepEqual(faaCodes(t42), ["42M", "K42M"], "K42M is how some pilots file it, never shown");
  assert.deepEqual(faaCodes(m.get("CJJ")), ["KCJJ", "CJJ"]);
  assert.equal(faaTitle("ELLEN CHURCH FLD"), "Ellen Church Field");
});

t("xplaneCodes: shipped scenery only", () => {
  const s = xplaneCodes({ airports: [
    { AirportCode: "42M", Deprecated: null, RecommendedSceneryId: 12 },
    { AirportCode: "TT45", Deprecated: null, RecommendedSceneryId: null },
    { AirportCode: "F31", Deprecated: 1, RecommendedSceneryId: 9 },
  ] });
  assert.deepEqual([...s], ["42M"]);
});

t("fields.json: shape", () => {
  const doc = JSON.parse(fs.readFileSync(new URL("../data/first-landing/fields.json", import.meta.url), "utf8"));
  assert.deepEqual(doc.cols, COLS);
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(doc.faaCycle));
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(doc.asOf));
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(doc.crawledTo));
  assert.ok(doc.fields.length > 1000);
  const ids = new Set();
  for (const r of doc.fields) {
    assert.equal(r.length, COLS.length, r[0]);
    assert.ok(!ids.has(r[C.ident]), "duplicate " + r[C.ident]);
    ids.add(r[C.ident]);
    assert.ok(Number.isFinite(r[C.lat]) && Number.isFinite(r[C.lon]), r[0]);
    assert.ok("sw".includes(r[C.type]), r[0]);
    assert.ok(r[C.use] === "PU" || r[C.use] === "PR", r[0]);
    assert.ok(r[C.xplane] === 0 || r[C.xplane] === 1, r[0]);
    assert.ok(r[C.local], r[0]);
    // The ICAO code is the FAA's, never K + a code with digits in it (KF31).
    assert.ok(r[C.ident] === r[C.local] || /^[KPT][A-Z]{3}$/.test(r[C.ident]), r[0] + " / " + r[C.local]);
    assert.ok(r[C.status] === 0 || r[C.status] === 1, r[0]);
    assert.ok(!r[C.ident].includes("-"), r[0]);
  }
  assert.ok(doc.landed.length > 1000 && doc.landed.every((p) => p.length === 2));
});

console.log(`\n${passed} passed`);
