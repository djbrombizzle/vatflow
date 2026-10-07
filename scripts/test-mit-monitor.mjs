#!/usr/bin/env node
/**
 * Regression tests for shared/mit-monitor.js.
 * Usage: node scripts/test-mit-monitor.mjs
 */
import assert from "node:assert/strict";
import {
  arrivalGate, calcGateMit, programGateMitNm, gateMitAction, normPrograms,
  isExcludedFromProgram, wakeFromFp, buildMitMonitor, gateSpacing, NO_GATE,
} from "../shared/mit-monitor.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

t("arrivalGate takes the last STAR or fix", () => {
  assert.equal(arrivalGate("KATL DCT BANNG Q85 LPERD GTOUT1 KMCO", "KMCO"), "GTOUT1");
  assert.equal(arrivalGate("SPA DCT OMN", "KMCO"), "OMN");
  assert.equal(arrivalGate("DCT", "KMCO"), NO_GATE);
  assert.equal(arrivalGate("", "KMCO"), NO_GATE);
});

t("calcGateMit: AAR 40, one quiet gate → 30 MIT on the busy three", () => {
  const c = calcGateMit(40, [["A", 20], ["B", 20], ["C", 20], ["D", 4]], 0);
  assert.equal(c.over, true);
  for (const g of ["A", "B", "C"]) {
    const r = c.rows.find(x => x.gate === g);
    assert.equal(r.slice, 12); assert.equal(r.mit, 30); assert.equal(r.limited, true);
  }
  assert.equal(c.rows.find(x => x.gate === "D").limited, false);
});

t("calcGateMit: under the AAR needs no MIT", () => {
  const c = calcGateMit(40, [["A", 10], ["B", 5]], 2);
  assert.equal(c.over, false);
  assert.ok(c.rows.every(r => !r.limited && r.mit === 0));
});

t("programGateMitNm: gate rule wins, else airport-wide, trail converts", () => {
  const prog = normPrograms({ KMCO: { aar: 40, mit: 15, gates: [{ name: "OMN", mit: 25 }] } }).KMCO;
  assert.deepEqual(programGateMitNm(prog, "OMN"), { nm: 25, gateRule: true });
  assert.deepEqual(programGateMitNm(prog, "GTOUT1"), { nm: 15, gateRule: false });
  const tr = normPrograms({ KMCO: { aar: 40, trail: 5 } }).KMCO;
  assert.equal(programGateMitNm(tr, "X").nm, 30);
});

t("gateMitAction dead band", () => {
  assert.equal(gateMitAction(30, 20).kind, "tighten");
  assert.equal(gateMitAction(0, 20).kind, "relax");
  assert.equal(gateMitAction(20, 22).kind, "hold");
  assert.equal(gateMitAction(20, 30).kind, "relax");
});

t("normPrograms drops programs with no AAR", () => {
  const p = normPrograms({ kmco: { aar: 46 }, KXXX: { aar: 0 } });
  assert.deepEqual(Object.keys(p), ["KMCO"]);
});

t("exclusions: wake, jets only", () => {
  const prog = normPrograms({ K: { aar: 30, excludeWake: ["L"], jetsOnly: true } }).K;
  assert.equal(wakeFromFp({ aircraft: "L/C172/G" }), "L");
  assert.equal(isExcludedFromProgram({ type: "C172", wake: "" }, prog), true);
  assert.equal(isExcludedFromProgram({ type: "B738", wake: "M" }, prog), false);
  assert.equal(isExcludedFromProgram({ type: "ZZZZ", wake: "L" }, prog), true);
});

t("gateSpacing flags gaps under the MIT", () => {
  const s = gateSpacing([
    { callsign: "A", status: "AIRBORNE", dist: 50 },
    { callsign: "B", status: "AIRBORNE", dist: 60 },
    { callsign: "C", status: "AIRBORNE", dist: 100 },
  ], 20);
  assert.equal(s[0].gap, null);
  assert.equal(s[1].ahead, "A"); assert.equal(s[1].gap, 10); assert.equal(s[1].tight, true);
  assert.equal(s[2].gap, 40); assert.equal(s[2].tight, false);
});

t("buildMitMonitor: filters to the airport, counts next-hour demand per gate", () => {
  const apt = [28.43, -81.31];
  const now = Date.UTC(2026, 9, 7, 20, 0);
  const prog = normPrograms({ KMCO: { aar: 2, gates: [{ name: "OMN", mit: 20 }] } }).KMCO;
  const pilots = [
    { callsign: "AAL1", lat: 29.3, lon: -81.1, gs: 300, phase: "air", arr: "KMCO", dep: "KJFK", type: "B738", route: "X OMN" },
    { callsign: "AAL2", lat: 29.6, lon: -81.0, gs: 300, phase: "air", arr: "KMCO", dep: "KJFK", type: "B738", route: "X OMN" },
    { callsign: "DAL3", lat: 28.0, lon: -82.5, gs: 300, phase: "air", arr: "KMCO", dep: "KATL", type: "A321", route: "X LPERD GTOUT1" },
    { callsign: "UAL9", lat: 40.0, lon: -75.0, gs: 450, phase: "air", arr: "KEWR", dep: "KMCO", type: "B738", route: "X" },
    { callsign: "SWA4", lat: 28.43, lon: -81.31, gs: 10, phase: "gnd", arr: "KMCO", dep: "KBWI", type: "B737", route: "X OMN" },
  ];
  const m = buildMitMonitor({ airport: "KMCO", aptLL: apt, prog, pilots, now });
  assert.equal(m.flights.length, 4);                       // UAL9 isn't inbound
  assert.equal(m.flights.find(f => f.callsign === "SWA4").status, "ARRIVED");
  const omn = m.gates.find(g => g.name === "OMN");
  assert.equal(omn.demand60, 2); assert.equal(omn.reqMit, 20); assert.equal(omn.reqGateRule, true);
  assert.equal(m.demand, 3); assert.equal(m.over, true);
  assert.equal(omn.spacing.length, 2);
  assert.ok(m.colors.OMN && m.colors.GTOUT1 && m.colors.OMN !== m.colors.GTOUT1);
});

console.log(`\n${passed} passed`);
