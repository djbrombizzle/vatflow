#!/usr/bin/env node
/**
 * Regression tests for shared/zjx-sop-match.js and the ZJX SOP rows.
 * Usage: node scripts/test-zjx-sop-match.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROWS, SECTORS, SECTOR_INFO, SECTOR_REF, SECTOR_FALLBACK, AREAS } from "../shared/zjx-sop-data.js";
import { parseFor, parseRouting, restrictionFix } from "../shared/zdc-sop-match.js";
import {
  matchFlight, zjxPrimaries, zjxSatPrimaries, zjxSectorShapes, sectorsOnPath, entryPoint, pointInRings,
} from "../shared/zjx-sop-match.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

const LL = {
  KMCO: [28.429, -81.309], KORL: [28.545, -81.333], KSFB: [28.778, -81.237], KISM: [28.290, -81.437],
  KTPA: [27.975, -82.533], KPIE: [27.910, -82.687], KMCF: [27.849, -82.521], KTPF: [27.915, -82.449],
  KJAX: [30.494, -81.688], KCRG: [30.336, -81.515], KNIP: [30.236, -81.681], KVQQ: [30.219, -81.877],
  KATL: [33.637, -84.428], KPDK: [33.876, -84.302], KCLT: [35.214, -80.943], KRDU: [35.878, -78.787],
  KSAV: [32.128, -81.202], KDAB: [29.180, -81.058], KPGD: [26.920, -81.991], KSRQ: [27.395, -82.554],
};
const ctx = { ll: id => LL[id] || null, primaries: zjxPrimaries(), satPrimaries: zjxSatPrimaries() };
const restr = (flight, extra = {}) => matchFlight(flight, { ...ctx, ...extra }).map(m => `${m.row[0]} ${m.row[4]}`);

t("data: sectors, refs and column shapes", () => {
  assert.equal(Object.keys(SECTOR_INFO).length, 42);
  for (const [k, v] of Object.entries(SECTOR_INFO)) {
    assert.match(k, /^\d\d$/);
    assert.ok(AREAS.includes(v[1]), "area " + v[1]);
    assert.ok(SECTOR_REF[k], "ref for " + k);
  }
  for (const r of ROWS) {
    assert.ok(r.length >= 8 && r.length <= 9, "columns: " + r.join(" | "));
    assert.ok(SECTORS[r[0]], "sector " + r[0]);
    assert.ok(r[4], "restriction present: " + r.join(" | "));
    assert.ok(/^$|^\d\d$|^17\/34$|^Z[A-Z]{2}$|^(A80|F11)$|^[A-Z]{3} APP$/.test(r[5]), "to column: " + r[5]);
    assert.ok(/^$|^(JET|TP)$/.test(r[2]), "qualifier: " + r[2]);
    assert.ok(parseFor(r[1], r[2]).airports.length, "for parses: " + r[1]);
  }
  for (const k of Object.keys(SECTOR_FALLBACK)) assert.ok(SECTORS[k]);
  assert.ok(ROWS.length > 200);
});

t("routing strings parse into STARs and fixes", () => {
  const rt = parseRouting("BITTE SHREK# / OCF V159 LEESE#");
  assert.equal(rt.alternatives.length, 2);
  assert.deepEqual(rt.alternatives[0], [[{ fix: "BITTE" }], [{ star: "SHREK" }]]);
  assert.deepEqual(rt.alternatives[1][1], [{ airway: "V159" }]);
  assert.deepEqual(parseRouting("[GRDON/WOPNR] ALYNA#").alternatives[0][0], [{ fix: "GRDON" }, { fix: "WOPNR" }]);
  const cond = parseRouting("(Over/South of CABLO)");
  assert.equal(cond.alternatives.length, 0);
  assert.deepEqual(cond.notes, ["Over/South of CABLO"]);
});

t("crossing fix read from ZJX wording", () => {
  assert.equal(restrictionFix("LALAA @ FL270"), "LALAA");
  assert.equal(restrictionFix("20 NM S of JURDI @ FL240"), "JURDI");
  assert.equal(restrictionFix("45 NM NW of GNV @ FL240"), "GNV");
  assert.equal(restrictionFix("Abeam BATTN AOB FL270"), "BATTN");
  assert.equal(restrictionFix("Over or abeam CAPOH @ FL270"), "CAPOH");
  assert.equal(restrictionFix("BDRY AOB FL270"), null);
  assert.equal(restrictionFix("Sector 17 BDRY @ FL270"), null);
  assert.equal(restrictionFix("MLB AOB FL240"), "MLB");
});

t("MCO arrival on GRNCH picks GRNCH rows, not JAFAR/LEESE siblings", () => {
  const f = { callsign: "DAL1", dep: "KATL", arr: "KMCO", route: "SMKEY Q81 JAMIZ GRNCH4", type: "B739", altitude: "35000" };
  const got = restr(f);
  assert.ok(got.includes("33 ISSZZ @ FL290"));
  assert.ok(got.includes("78 ELITE @ FL260"));
  assert.ok(got.includes("17 BDRY AOB FL270"));
  assert.ok(got.includes("32 FL370"), "destination-only row");
  assert.ok(!got.includes("78 BDRY AOB FL250"), "JAFAR# row");
  assert.ok(!got.includes("15 SHIMM @ 11,000"), "LEESE# row");
  const moultrie = matchFlight(f, ctx).filter(m => m.row[0] === "49").map(m => m.row[3]);
  assert.deepEqual(moultrie, ["GRNCH# / LEESE#"], "not the HUNKR..JAFAR# row");
});

t("aircraft class splits turbojet and turboprop rows", () => {
  const jet = { callsign: "A", dep: "KCLT", arr: "KTPA", route: "FIGEY DADES5", type: "A320", altitude: "33000" };
  const tp = { ...jet, type: "DH8D" };
  assert.ok(restr(jet).includes("33 BDRY AOB FL310"));
  assert.ok(!restr(jet).includes("33 BDRY AOB FL270"));
  assert.ok(restr(tp).includes("33 BDRY AOB FL270"));
  assert.ok(restr(tp).includes("15 OLENE @ 11,000"));
  assert.ok(!restr(tp).includes("15 OLENE @ 13,000"));
});

t("terminal areas and satellites", () => {
  const sfb = { callsign: "B", dep: "KBOS", arr: "KSFB", route: "OMN BITHO1", type: "B738", altitude: "35000" };
  const viaF11 = matchFlight({ ...sfb, route: "BITTE SHREK2" }, ctx).filter(m => m.row[0] === "14");
  assert.equal(viaF11.length, 1, "F11 arrivals row covers SFB");
  const pdk = { callsign: "C", dep: "KMCO", arr: "KPDK", route: "DOOLY HOBTT3", type: "C68A", altitude: "41000" };
  assert.ok(matchFlight(pdk, ctx).some(m => m.row[1] === "ATL+" && m.how === "satellite"));
  const cg = { callsign: "D", dep: "KMIA", arr: "KCRG", route: "HOTAR3", type: "C560", altitude: "21000" };
  assert.ok(restr(cg).includes("54 BDRY AOB 10,000"));
  assert.ok(!restr(cg).includes("54 BDRY AOB 16,000"), "VQQ/NIP/SGJ/HEG row");
});

t("sector shapes: union of strata, fallbacks, route crossing", () => {
  const sq = (lat, lon, d = 1) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
  const fc = (sector, stratum, lat, lon, d) => ({ type: "Feature", properties: { artcc: "ZJX", sector, stratum }, geometry: { type: "Polygon", coordinates: sq(lat, lon, d) } });
  const geo = { type: "FeatureCollection", features: [fc("68", "HIGH", 31, -80), fc("75", "HIGH", 29, -81), fc("68", "UTA", 31, -80, 1.5), { type: "Feature", properties: { artcc: "ZTL", sector: "68" }, geometry: null }] };
  const s = zjxSectorShapes([geo]);
  assert.equal(s.bySector.get("68").length, 2);
  assert.equal(s.bySector.get("67").length, 2, "Hunter falls back to States");
  assert.equal(s.byStratum.HIGH.length, 2);
  assert.ok(pointInRings([31.2, -80.1], s.bySector.get("68")));
  const path = [[33, -80], [27, -81]];
  const on = sectorsOnPath(path, s.bySector);
  assert.ok(on.has("68") && on.has("75") && on.has("67"));
  assert.ok(!sectorsOnPath([[33, -86], [27, -86]], s.bySector).has("68"));
  const e = entryPoint(path, s.bySector.get("75"));
  assert.ok(e && Math.abs(e[0] - 30) < 0.1, "enters 75 near its north edge");
});

t("repo sector GeoJSON covers every SOP sector (directly or by fallback)", () => {
  const geo = ["low", "high", "uta"].map(n => JSON.parse(readFileSync(new URL(`../data/artcc-sectors-${n}.geojson`, import.meta.url))));
  const s = zjxSectorShapes(geo);
  const missing = Object.keys(SECTORS).filter(k => !s.bySector.has(k));
  assert.deepEqual(missing, []);
  // KATL-bound out of MCO crosses Green Cove/States/Alma, not the Gulf low sectors.
  const on = sectorsOnPath([[28.43, -81.31], [30.5, -82.5], [33.64, -84.43]], s.bySector);
  assert.ok(on.has("50"), "Alma");
  assert.ok(!on.has("88"), "Darbs");
});

console.log(`\n${passed} passed`);
