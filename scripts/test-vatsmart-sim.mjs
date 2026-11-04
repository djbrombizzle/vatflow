#!/usr/bin/env node
/**
 * Regression tests for shared/vatsmart-sim.js (VATSMART PLAN tab).
 * Usage: node scripts/test-vatsmart-sim.mjs
 */
import assert from "node:assert/strict";
import {
  pathModel, sAtMin, pointAtS, flightAt, demandHours, makeFlights, runSim, simNow, simStats, aarForDelay,
  assignStacks, drawnPath, gcNm, destPoint, SIM_ENTRY_NM, SPEED_ABSORB_MIN,
} from "../shared/vatsmart-sim.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const MIN = 60000, HOUR = 3600000;
const FIELD = [28.43, -81.31];
const T0 = Date.UTC(2026, 10, 7, 23, 0);

/* a straight-in stream from the north: 400 nm out, gate fix 60 nm out, field */
const north = [destPoint(FIELD, 0, 400), destPoint(FIELD, 0, 60), FIELD];
const west = [destPoint(FIELD, 270, 300), destPoint(FIELD, 270, 50), FIELD];
const models = { N: pathModel(north, 1), W: pathModel(west, 1) };

t("pathModel trims to the last SIM_ENTRY_NM and times the legs", () => {
  const m = models.N;
  assert.ok(Math.abs(m.total - 400) < 1);
  assert.ok(Math.abs(m.total - m.entryS - SIM_ENTRY_NM) < 0.01);
  assert.ok(Math.abs(m.gateRemNm - 60) < 1);
  /* 150 nm at 440 + 60 at 300 + 28 at 220 + 12 at 150 ≈ 20.5 + 12 + 7.6 + 4.8 = 44.9 min */
  assert.ok(m.flyMin > 43 && m.flyMin < 47, String(m.flyMin));
  assert.ok(m.gateMin > 27.5 && m.gateMin < 29.5, String(m.gateMin));   // 150 nm at 440 + 40 at 300
  const s = sAtMin(m, m.gateMin);
  assert.ok(Math.abs(s - m.gateS) < 0.1);
  assert.ok(gcNm(...pointAtS(m, m.total).ll, ...FIELD) < 0.1);
  assert.ok(gcNm(...drawnPath(m)[0], ...destPoint(FIELD, 0, SIM_ENTRY_NM)) < 1);
});

t("pathModel never starts past the gate fix, and rejects bad paths", () => {
  const far = pathModel([destPoint(FIELD, 0, 600), destPoint(FIELD, 0, 300), FIELD], 1);
  assert.ok(far.entryS <= far.gateS - 5);
  assert.equal(pathModel([FIELD]), null);
  assert.equal(pathModel([FIELD, FIELD]), null);
  const noGate = pathModel(north, -1);
  assert.ok(Math.abs(noGate.gateRemNm - 30) < 0.1);
});

t("demandHours: flat, event-shaped and from a past event", () => {
  assert.deepEqual(demandHours({ startMs: T0, hours: 3, peak: 40, shape: "flat" }).map(h => h.n), [40, 40, 40]);
  const ev = demandHours({ startMs: T0, hours: 4, peak: 50, shape: "event" });
  assert.deepEqual(ev.map(h => h.n), [30, 48, 50, 30]);
  assert.equal(ev[1].t, T0 + HOUR);
  const past = demandHours({ startMs: T0, hours: 2, peak: 60, shape: "past",
    pastArrByHour: [{ n: 0 }, { n: 10 }, { n: 20 }, { n: 0 }] });
  assert.deepEqual(past.map(h => h.n), [30, 60]);
});

t("makeFlights: right count, weights respected, deterministic by seed", () => {
  const hours = demandHours({ startMs: T0, hours: 3, peak: 60, shape: "flat" });
  const streams = [{ id: "N", weight: 3 }, { id: "W", weight: 1 }, { id: "X", weight: 0 }];
  const a = makeFlights({ hours, streams, seed: 7 });
  assert.equal(a.length, 180);
  const nN = a.filter(f => f.stream === "N").length;
  assert.ok(nN > 115 && nN < 155, String(nN));
  assert.equal(a.filter(f => f.stream === "X").length, 0);
  assert.ok(a.every((f, i) => i === 0 || f.U >= a[i - 1].U));
  assert.ok(a.every(f => f.U >= T0 && f.U < T0 + 3 * HOUR));
  assert.equal(new Set(a.map(f => f.callsign)).size, a.length);
  assert.deepEqual(makeFlights({ hours, streams, seed: 7 }), a);
  assert.notDeepEqual(makeFlights({ hours, streams, seed: 8 }).map(f => f.U), a.map(f => f.U));
});

t("runSim: under the AAR nobody waits", () => {
  const flights = [0, 5, 10, 15].map((m, i) => ({ id: i, callsign: "A" + i, stream: "N", U: T0 + m * MIN }));
  const s = runSim({ flights, models, aar: 40 });
  assert.ok(s.flights.every(f => f.delayMin === 0 && f.holdMin === 0));
  assert.equal(s.flights[0].entryT, T0 - models.N.flyMin * MIN);
});

t("runSim: over the AAR the runway spaces them and the rest holds at the gate", () => {
  /* 10 arrivals all wanting the same minute, AAR 30 = one every 2 min */
  const flights = Array.from({ length: 10 }, (_, i) => ({ id: i, callsign: "A" + i, stream: i % 2 ? "W" : "N", U: T0 }));
  const s = runSim({ flights, models, aar: 30 });
  s.flights.forEach((f, i) => assert.equal(f.landT, T0 + i * 2 * MIN));
  const last = s.flights[9];
  assert.equal(last.delayMin, 18);
  assert.equal(last.speedMin, SPEED_ABSORB_MIN);
  assert.equal(last.holdMin, 18 - SPEED_ABSORB_MIN);
  const st = simStats(s, T0);
  assert.equal(st.maxDelay, 18);
  assert.equal(st.held, 8);         // delays of 0 and 2 min are soaked up by speed
  assert.ok(st.peakHold >= 5);
  const g = runSim({ flights, models, aar: 30, mode: "ground" });
  assert.ok(g.flights.every(f => f.holdMin === 0));
  assert.equal(g.flights[9].edctMin, 18);
  assert.equal(g.flights[9].entryT, T0 - models[g.flights[9].stream].flyMin * MIN + 18 * MIN);
  assert.equal(simStats(g, T0).peakHold, 0);
});

t("flightAt follows the path, holds near the gate fix, then lands on time", () => {
  const flights = Array.from({ length: 6 }, (_, i) => ({ id: i, callsign: "A" + i, stream: "N", U: T0 }));
  const s = assignStacks(runSim({ flights, models, aar: 12 }));   // one every 5 min
  const f = s.flights[5], m = models.N;
  assert.equal(f.holdMin, 25 - SPEED_ABSORB_MIN);
  assert.equal(flightAt(f, m, f.entryT - 1), null);
  const en = flightAt(f, m, f.entryT + 5 * MIN);
  assert.equal(en.phase, "enroute");
  assert.ok(Math.abs(en.hdg - 180) < 1);
  assert.ok(en.alt > 30000);
  const h = flightAt(f, m, f.gateT + 7 * MIN);
  assert.equal(h.phase, "hold");
  assert.ok(gcNm(...h.ll, ...destPoint(FIELD, 0, 60)) < 6);   // a 4-min lap is ~4.5 nm across
  const stackAlts = s.flights.filter(x => x.holdMin > 0).map(x => flightAt(x, m, x.gateT + 0.5 * MIN).alt);
  assert.ok(new Set(stackAlts).size > 1);   // stacked 1000 ft apart
  const inb = flightAt(f, m, f.holdEnd + MIN);
  assert.equal(inb.phase, "inbound");
  assert.ok(inb.remNm < 60);
  assert.ok(flightAt(f, m, f.landT - 1000).remNm < 1);
  assert.equal(flightAt(f, m, f.landT), null);
  const now = simNow(s, f.gateT + MIN);
  assert.ok(now.hold >= 1 && now.holdBy.N === now.hold);
  assert.equal(now.air + now.landed + now.pending, 6);
});

t("assignStacks: overlapping holds get their own level", () => {
  const flights = Array.from({ length: 5 }, (_, i) => ({ id: i, callsign: "A" + i, stream: "N", U: T0 }));
  const s = assignStacks(runSim({ flights, models, aar: 10 }));
  const lv = s.flights.filter(f => f.holdMin > 0).map(f => f.stackLevel);
  assert.equal(new Set(lv).size, lv.length);
});

t("aarForDelay finds the lowest AAR that meets the delay target", () => {
  const hours = demandHours({ startMs: T0, hours: 2, peak: 50, shape: "flat" });
  const flights = makeFlights({ hours, streams: [{ id: "N", weight: 1 }, { id: "W", weight: 1 }], seed: 3 });
  const aar = aarForDelay({ flights, models, maxDelayMin: 10 });
  assert.ok(aar >= 40 && aar <= 70, String(aar));
  const worst = a => Math.max(...runSim({ flights, models, aar: a }).flights.map(f => f.delayMin));
  assert.ok(worst(aar) <= 10);
  assert.ok(worst(aar - 1) > 10);
});

t("runSim drops flights on a stream with no path", () => {
  const s = runSim({ flights: [{ id: 0, callsign: "A", stream: "Z", U: T0 }], models, aar: 40 });
  assert.equal(s.flights.length, 0);
  assert.equal(s.dropped.length, 1);
});

console.log(`\n${passed} passed`);
