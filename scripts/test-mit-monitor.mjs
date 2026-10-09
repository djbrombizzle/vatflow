#!/usr/bin/env node
/**
 * Regression tests for shared/mit-monitor.js.
 * Usage: node scripts/test-mit-monitor.mjs
 */
import assert from "node:assert/strict";
import {
  arrivalGate, gateKey, calcGateMit, programGateMitNm, gateMitAction, normPrograms,
  isExcludedFromProgram, wakeFromFp, buildMitMonitor, gateSpacing, rollingGateDemand, gateMitTimeline, gateMitSchedule, NO_GATE,
} from "../shared/mit-monitor.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

t("arrivalGate takes the last STAR or fix", () => {
  assert.equal(arrivalGate("KATL DCT BANNG Q85 LPERD GTOUT1 KMCO", "KMCO"), "GTOUT");
  assert.equal(arrivalGate("SPA DCT OMN", "KMCO"), "OMN");
  assert.equal(arrivalGate("DCT", "KMCO"), NO_GATE);
  assert.equal(arrivalGate("", "KMCO"), NO_GATE);
});

t("gate rules match any STAR revision", () => {
  assert.equal(gateKey("OZZZI1"), "OZZZI");
  assert.equal(gateKey("ozzzi2"), "OZZZI");
  assert.equal(gateKey("OMN"), "OMN");
  assert.equal(gateKey("LPERD"), "LPERD");
  assert.equal(arrivalGate("KBHM DCT OZZZI1 KATL", "KATL"), arrivalGate("KBHM DCT OZZZI2 KATL", "KATL"));
  const prog = normPrograms({ KATL: { aar: 40, gates: [{ name: "OZZZI2", mit: 25 }] } }).KATL;
  assert.equal(prog.gates[0].name, "OZZZI");
  assert.deepEqual(programGateMitNm(prog, arrivalGate("KBHM DCT OZZZI1 KATL", "KATL")), { nm: 25, gateRule: true });
  assert.deepEqual(programGateMitNm(prog, "OZZZI3"), { nm: 25, gateRule: true });
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
  assert.ok(m.colors.OMN && m.colors.GTOUT && m.colors.OMN !== m.colors.GTOUT);
});

t("buildMitMonitor: expected demand wins where it is higher than live", () => {
  const apt = [28.43, -81.31];
  const now = Date.UTC(2026, 9, 7, 20, 0);
  const prog = normPrograms({ KMCO: { aar: 40, expect: [{ gate: "GRNCH5", rate: 30 }, { gate: "SNFLD", rate: 20 }, { gate: "OMN", rate: 1 }] } }).KMCO;
  assert.deepEqual(prog.expect.map(x => x.gate), ["GRNCH", "SNFLD", "OMN"]);
  const pilots = [
    { callsign: "AAL1", lat: 29.3, lon: -81.1, gs: 300, phase: "air", arr: "KMCO", dep: "KJFK", type: "B738", route: "X OMN" },
    { callsign: "AAL2", lat: 29.6, lon: -81.0, gs: 300, phase: "air", arr: "KMCO", dep: "KJFK", type: "B738", route: "X OMN" },
    { callsign: "DAL3", lat: 30.0, lon: -83.5, gs: 300, phase: "air", arr: "KMCO", dep: "KATL", type: "A321", route: "X GRNCH4" },
  ];
  const m = buildMitMonitor({ airport: "KMCO", aptLL: apt, prog, pilots, now });
  const g = name => m.gates.find(x => x.name === name);
  assert.equal(g("GRNCH").demand60, 1); assert.equal(g("GRNCH").expected, 30);
  assert.equal(g("SNFLD").expected, 20);                    // listed with no live traffic
  assert.equal(g("OMN").expected, 0);                       // live 2 beats expected 1
  assert.equal(m.demand, 52); assert.equal(m.over, true);
  assert.ok(g("GRNCH").recMit > 0 && g("SNFLD").recMit > 0 && !g("OMN").recMit);
});

t("rollingGateDemand: busiest 60-minute window across the lookahead drives demand", () => {
  const now = Date.UTC(2026, 9, 9, 0, 0);
  const at = (min, gate) => ({ eta: now + min * 60000, gate });
  const flights = [
    at(-3, "OMN"),                                        // overdue, still inbound: first window only
    at(10, "OMN"), at(50, "GRNCH"),
    ...Array.from({ length: 8 }, (_, i) => at(95 + i * 3, "GRNCH")),   // rush 95-116 min out
    at(100, NO_GATE), at(130, "OMN"), at(200, "OMN"),     // 200 is past the 3 hr lookahead
  ];
  const r = rollingGateDemand({ flights, now });
  assert.deepEqual(r.windows.map(w => w.offsetMin), [0, 15, 30, 45, 60, 75, 90, 105, 120]);
  assert.equal(r.windows[0].total, 3);                    // the old next-60 view
  const pk = r.windows[r.peak];
  assert.equal(pk.offsetMin, 75);                         // 0115-0215z holds the whole rush + 0210 OMN
  assert.equal(pk.total, 10);
  assert.deepEqual(pk.entries, [["GRNCH", 8], ["OMN", 1]]);
  assert.equal(pk.unassigned, 1);
  assert.equal(r.windows[8].total, 1);                    // 0200-0300z: 0210 only
});

t("rollingGateDemand: expected demand is a per-window floor, ties go to the earliest window", () => {
  const now = 0;
  const r = rollingGateDemand({ flights: [{ eta: 5 * 60000, gate: "OMN" }], now, horizonMin: 120, stepMin: 30, expect: { GRNCH: 12 } });
  assert.equal(r.windows.length, 3);
  assert.equal(r.peak, 0);
  assert.deepEqual(r.windows[0].entries, [["GRNCH", 12], ["OMN", 1]]);
  assert.deepEqual(r.windows[0].expected, ["GRNCH"]);
  assert.equal(r.windows[1].total, 12);
  assert.equal(rollingGateDemand({ flights: [], now, horizonMin: 60 }).windows.length, 1);
});

t("gateMitTimeline: when each gate first needs MIT and how tight it gets", () => {
  const now = 0;
  const at = (min, gate) => ({ eta: min * 60000, gate });
  const flights = [
    at(5, "OMN"), at(10, "GRNCH"),
    ...Array.from({ length: 12 }, (_, i) => at(70 + i * 4, "GRNCH")),   // GRNCH rush from ~70 min
    ...Array.from({ length: 4 }, (_, i) => at(80 + i * 10, "OMN")),
  ];
  const { windows } = rollingGateDemand({ flights, now, horizonMin: 180 });
  const tl = gateMitTimeline(windows, 10, 360);
  assert.equal(tl[0].gate, "GRNCH");
  assert.equal(tl[0].mits[0], 0);                          // quiet now
  assert.ok(tl[0].first > 0 && windows[tl[0].first].offsetMin <= 60);   // seen before the rush starts
  assert.ok(tl[0].peakMit >= 60);                          // 12 vs a 6/hr slice -> 60 MIT
  const omn = tl.find(g => g.gate === "OMN");
  assert.equal(omn.first, -1);                             // under its even share throughout
  assert.equal(omn.mits.every(m => m === 0), true);
});

t("gateMitSchedule: start with the traffic, don't relax just to re-add it", () => {
  // program already runs 30 MIT but nothing needs it for 45 minutes
  assert.deepEqual(gateMitSchedule([0, 0, 0, 25, 30, 30, 0, 0, 0], 30), [
    { i: 0, kind: "stop", from: 30, to: 0 },
    { i: 3, kind: "start", from: 0, to: 25 },
    { i: 4, kind: "tighten", from: 25, to: 30 },
    { i: 6, kind: "stop", from: 30, to: 0 },
  ]);
  // a one-window dip doesn't relax; a real lull does, and MIT comes back with the traffic
  assert.deepEqual(gateMitSchedule([40, 20, 40, 40, 0, 0, 35], 40), [
    { i: 4, kind: "stop", from: 40, to: 0 },
    { i: 6, kind: "start", from: 0, to: 35 },
  ]);
  assert.deepEqual(gateMitSchedule([0, 0, 0], 0), []);
  assert.deepEqual(gateMitSchedule([20, 20], 20), []);
  assert.deepEqual(gateMitSchedule([30, 20, 20], 30), [{ i: 1, kind: "relax", from: 30, to: 20 }]);
});

console.log(`\n${passed} passed`);
