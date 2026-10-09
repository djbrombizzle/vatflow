#!/usr/bin/env node
/**
 * Regression tests for shared/zdc-sop-match.js.
 * Usage: node scripts/test-zdc-sop-match.mjs
 */
import assert from "node:assert/strict";
import { ROWS, SECTORS } from "../shared/zdc-sop-data.js";
import {
  parseFor, destMatches, parseRouting, flightRoutePoints, engineClass, cruiseFeet,
  restrictionFix, rowVisibleInConfig, ownerOf, matchFlight, descendViaFor, primaryAirports, satellitePrimaries,
} from "../shared/zdc-sop-match.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

const LL = {
  KDCA: [38.852, -77.037], KADW: [38.811, -76.867], KCGS: [38.981, -76.922],
  KPHL: [39.872, -75.241], KPNE: [40.082, -75.011], KILG: [39.679, -75.607],
  KEWR: [40.692, -74.169], KTEB: [40.850, -74.061], KLGA: [40.777, -73.873], KJFK: [40.640, -73.779],
  KBWI: [39.175, -76.668], KIAD: [38.944, -77.456], KRDU: [35.878, -78.787],
  KJYO: [39.078, -77.558], KHEF: [38.721, -77.515],
};
const ctx = { ll: id => LL[id] || null, primaries: primaryAirports(), satPrimaries: satellitePrimaries() };
const rowsFor = (flight, extra = {}) => matchFlight(flight, { ...ctx, ...extra }).map(m => m.row);

t("data covers all 14 sectors with sane columns", () => {
  const secs = new Set(ROWS.map(r => r[0]));
  assert.deepEqual([...secs].sort(), Object.keys(SECTORS).sort());
  for (const r of ROWS) {
    assert.equal(r.length, 6);
    assert.ok(r[4], "restriction present: " + r.join(" | "));
    assert.ok(/^(\d\d|Z[A-Z]{2}|CHP|JRV|MTV|SHD|N90|[A-Z]{3}z)$/.test(r[5]), "to column: " + r[5]);
  }
  assert.ok(ROWS.length > 300);
});

t("For column parsing", () => {
  assert.deepEqual(parseFor("DCA+").airports, ["KDCA"]);
  assert.equal(parseFor("DCA+").plus, true);
  assert.equal(parseFor("EWR SATS").satsOnly, true);
  const phl = parseFor("PHL N SAT", "JET");
  assert.equal(phl.dir, "N");
  assert.deepEqual(phl.classes, ["jet"]);
  assert.deepEqual(parseFor("JFK/FRG", "PN/TP").airports, ["KJFK", "KFRG"]);
  assert.deepEqual(parseFor("JFK/FRG", "PN/TP").classes.sort(), ["piston", "turboprop"]);
  assert.equal(parseFor("PHL", "PN O/F").overflight, true);
  assert.deepEqual(parseFor("KHEF/KJYO").airports, ["KHEF", "KJYO"]);
});

t("satellites: nearest primary, direction, explicit airports excluded", () => {
  assert.deepEqual(destMatches(parseFor("DCA+"), "KCGS", ctx), { how: "satellite" });
  assert.equal(destMatches(parseFor("DCA+"), "KADW", ctx), null, "KADW has its own rows");
  assert.equal(destMatches(parseFor("EWR SATS"), "KEWR", ctx), null);
  assert.deepEqual(destMatches(parseFor("EWR SATS"), "KTEB", ctx), { how: "satellite" });
  assert.deepEqual(destMatches(parseFor("PHL N SAT"), "KPNE", ctx), { how: "satellite" });
  assert.equal(destMatches(parseFor("PHL N SAT"), "KILG", ctx), null, "ILG is south of PHL");
  assert.deepEqual(destMatches(parseFor("KBWI"), "BWI", ctx), { how: "exact" });
});

t("routing parsing: STARs, fix groups, alternates, conditions", () => {
  const r = parseRouting("[HBUDA/THHMP] RAVNN#");
  assert.deepEqual(r.alternatives, [[[{ fix: "HBUDA" }, { fix: "THHMP" }], [{ star: "RAVNN" }]]]);
  const alt = parseRouting("LYH POWTN# / MOL SPIDR#");
  assert.equal(alt.alternatives.length, 2);
  assert.equal(parseRouting("(ANY)").any, true);
  assert.equal(parseRouting("[ANY]").any, true);
  const z = parseRouting("[ZID] MOL SPIDR#");
  assert.deepEqual(z.notes, ["ZID"]);
  assert.equal(z.alternatives[0].length, 2);
  assert.deepEqual(parseRouting("[250+] JAMIE CONFR Q481 DPK TRESA#").altBand, { min: 25000, max: null });
  assert.deepEqual(parseRouting("[170-] SWL V139").altBand, { min: null, max: 17000 });
  assert.deepEqual(parseRouting("[190-230] KALDA").altBand, { min: 19000, max: 23000 });
  assert.equal(parseRouting("(ANY EXCEPT VIA GSO)").exceptVia, "GSO");
  assert.deepEqual(parseRouting("MLLET2 / RASLN#").alternatives, [[[{ star: "MLLET" }]], [[{ star: "RASLN" }]]]);
});

t("flight side helpers", () => {
  const fp = flightRoutePoints("KATL./.ODF DCT SPA Q22 HVQ.RAVNN6 KBWI");
  assert.ok(fp.stars.has("RAVNN"));
  assert.ok(fp.points.has("HVQ") && fp.points.has("Q22"));
  assert.equal(engineClass("B738"), "jet");
  assert.equal(engineClass("H/B744/L"), "jet");
  assert.equal(engineClass("DH8D"), "turboprop");
  assert.equal(engineClass("C172/G"), "piston");
  assert.equal(engineClass("ZZZZ"), null);
  assert.equal(cruiseFeet("35000"), 35000);
  assert.equal(cruiseFeet("FL240"), 24000);
  assert.equal(restrictionFix("BUBBI @ 150"), "BUBBI");
  assert.equal(restrictionFix("J: BUBBI @ 150"), "BUBBI");
  assert.equal(restrictionFix("BDRY AOB 290"), null);
  assert.equal(restrictionFix("5 S GARED @ 130"), "GARED");
  assert.equal(restrictionFix("BDRY (JUDGG) @ 130"), "JUDGG");
});

t("BWI arrival via RAVNN from the south gets the 36 → 20 → MTV chain", () => {
  const f = { callsign: "AAL1", dep: "KCLT", arr: "KBWI", route: "BARMY4 RDU THHMP RAVNN6", type: "A321", altitude: "33000" };
  const rows = rowsFor(f);
  const pairs = rows.map(r => `${r[0]}>${r[5]} ${r[4]}`);
  assert.ok(pairs.includes("36>20 BDRY AOB 290"), pairs.join("\n"));
  assert.ok(pairs.includes("09>20 BDRY AOB 250"));
  assert.ok(pairs.includes("20>MTV D/V"));
  assert.ok(pairs.includes("37>MTV D/V"));
  assert.ok(!rows.some(r => r[3].includes("ANTHM")), "other STAR rows excluded");
  assert.ok(matchFlight(f, ctx).every(m => m.quality === "full"));
});

t("aircraft class qualifiers filter rows", () => {
  const base = { dep: "KMTN", arr: "KBWI", route: "EMI EMI3", altitude: "11000" };
  const jet = rowsFor({ ...base, type: "B738" }).map(r => r[4]);
  const prop = rowsFor({ ...base, type: "DH8D" }).map(r => r[4]);
  assert.ok(jet.includes("J: BUBBI @ 150") && !jet.includes("P: BUBBI @ 090"));
  assert.ok(prop.includes("P: BUBBI @ 090") && !prop.includes("J: BUBBI @ 150"));
  const unk = matchFlight({ ...base, type: "XXXX" }, ctx).filter(m => m.row[3] === "EMI#");
  assert.equal(unk.length, 2);
  assert.ok(unk.every(m => m.typeUnknown));
});

t("altitude bands pick the right SWF row", () => {
  const ctxSwf = { ...ctx, ll: id => ({ ...LL, KSWF: [41.504, -74.105] })[id] || null };
  const hi = matchFlight({ dep: "KRDU", arr: "KSWF", route: "JAMIE CONFR Q481 DPK TRESA3", type: "E175", altitude: "31000" }, ctxSwf);
  assert.ok(hi.some(m => m.row[4] === "ZIGGI @ 250"));
  const lo = matchFlight({ dep: "KRDU", arr: "KSWF", route: "JAMIE CONFR Q481 DPK TRESA3", type: "E175", altitude: "21000" }, ctxSwf);
  assert.ok(!lo.some(m => m.row[4] === "ZIGGI @ 250"));
});

t("deconsolidated plans hide hand-offs inside one controller's airspace", () => {
  const r = ["36", "KBWI", "", "[HBUDA/THHMP] RAVNN#", "BDRY AOB 290", "20"];
  assert.equal(rowVisibleInConfig(r, "full"), true);
  assert.equal(rowVisibleInConfig(r, "2way"), true, "36 is Brooke's, 20 is Gordonsville's");
  const inner = ["09", "KBWI", "", "[HBUDA/THHMP] RAVNN#", "BDRY AOB 250", "20"];
  assert.equal(rowVisibleInConfig(inner, "2way"), true);
  const same = ["05", "RDU+", "", "MELTN ALDAN#", "BDRY AOB 320", "32"];
  assert.equal(rowVisibleInConfig(same, "2way"), false);
  assert.equal(rowVisibleInConfig(["20", "KBWI", "", "RAVNN#", "D/V", "MTV"], "3way"), true);
  assert.equal(ownerOf("54", "3way"), "12");
  assert.equal(ownerOf("9", "full"), "09");
  assert.equal(ownerOf("ZNY", "2way"), null);
});

t("route-free rows (ANY) match on destination; overflight rows need the full route", () => {
  const cae = rowsFor({ dep: "KBWI", arr: "KCAE", route: "TERPZ6 GVE Q75 GSO", type: "CRJ9", altitude: "26000" }, { ll: id => ({ ...LL, KCAE: [33.939, -81.119] })[id] || null });
  assert.ok(cae.some(r => r[0] === "09" && r[4] === "AOB 220"));
  assert.ok(cae.some(r => r[0] === "32" && r[4] === "AOB 300"), "GVE Q75 GSO row");
  assert.ok(!cae.some(r => r[0] === "36" && r[4] === "DSDG 240"), "except via GSO");
  const of = rowsFor({ dep: "KDCA", arr: "KABE", route: "ENO V29 ETX", type: "C172", altitude: "7000" });
  assert.ok(of.some(r => r[2] === "PN O/F" && r[4] === "ENO @ 90"));
  const ofPartial = rowsFor({ dep: "KDCA", arr: "KABE", route: "ENO V16", type: "C172", altitude: "7000" });
  assert.ok(!ofPartial.some(r => r[2].includes("O/F")));
});

t("a shared STAR alone does not pull in a sibling routing", () => {
  const yyz = matchFlight({ dep: "KDCA", arr: "CYYZ", route: "HORTO4 JERES Q221 DLMAR DCT WOZEE LINNG3", type: "A319", altitude: "38000" }, ctx);
  assert.deepEqual(yyz.map(m => m.row[3]), ["WOZEE LINNG#"]);
  const bos = matchFlight({ dep: "KMIA", arr: "KBOS", route: "FOLZZ3 GRUBR Y299 SEELO WAALT Q131 EARZZ JAMIE Q133 JFK ROBUC3", type: "B738", altitude: "27000" }, ctx);
  assert.deepEqual(bos.map(m => m.row[3]), ["JAMIE CONFR Q133 JFK ROBUC#"]);
  assert.equal(bos[0].quality, "partial", "CONFR not filed");
  const clt = matchFlight({ dep: "KDCA", arr: "KCLT", route: "SCRAM6 GLANC AIROW CHSLY9", type: "A20N", altitude: "30000" }, ctx);
  assert.deepEqual(clt.map(m => m.row[3]), ["AIROW CHSLY#"]);
});

t("expanded route fixes complete a match but cannot start a partial one", () => {
  const f = { dep: "KMCO", arr: "KJFK", route: "SAWED Q108 SIE CAMRN5", type: "A359", altitude: "41000" };
  const expanded = ["SAWED", "KALDA", "ZJAAY", "ACTUP", "SIE", "HOGGS", "PANZE", "KARRS", "CAMRN"];
  const m = matchFlight(f, { ...ctx, extraFixes: expanded });
  assert.ok(!m.some(x => x.row[3].startsWith("PANZE V44")), "V44 rows are for aircraft filed on V44");
  const ka = m.find(x => x.row[3] === "KALDA Q108 SIE CAMRN#");
  assert.equal(ka.quality, "full", "KALDA picked up from Q108 expansion");
});

t("descend-via bottoms by STAR and transition", () => {
  assert.deepEqual(descendViaFor({ arr: "KBWI", route: "HVQ RAVNN6" }).map(d => d.alt), ["190"]);
  assert.deepEqual(descendViaFor({ arr: "KBWI", route: "THHMP RAVNN6" }).map(d => d.alt), ["150"]);
  assert.deepEqual(descendViaFor({ arr: "KDCA", route: "FRDMM5" }).map(d => d.join), ["WEWIL"]);
  assert.deepEqual(descendViaFor({ arr: "KIAD", route: "FRDMM5" }), []);
});

console.log(`\n${passed} passed`);
