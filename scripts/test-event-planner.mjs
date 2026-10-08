#!/usr/bin/env node
/**
 * Regression tests for shared/event-planner.js.
 * Usage: node scripts/test-event-planner.mjs
 */
import assert from "node:assert/strict";
import {
  expectedPeak, holidayPeriod, seasonPct, gridWindow, weatherAarFactor, parseValidTime,
  starEntries, gateForOrigin, originMix, gateSharesFromOrigins, demandCurve, baselineFromHist,
  recommendTmis, ringPoints, compassName, pickBasisEvent, peakFromEvent, eventLikeness, likelyEvents,
} from "../shared/event-planner.js";
import { mergeHistory } from "./build-event-history.mjs";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

t("expectedPeak: default without history, lifted median with history", () => {
  assert.equal(expectedPeak("fno", null).value, 70);
  assert.equal(expectedPeak("none", null).value, 0);
  const p = expectedPeak("fno", [{ arr: 50 }, { arr: 60 }, { arr: 40 }, { arr: 10 }]);
  assert.equal(p.value, Math.round(50 * 1.15));
  assert.ok(p.fromHistory);
  assert.equal(expectedPeak("event", [{ arr: 50 }, { arr: 60 }, { arr: 40 }]).value, Math.round(50 * 1.15 * 0.55));
});

t("calendar: US holidays and season", () => {
  assert.equal(holidayPeriod(Date.UTC(2026, 10, 26)), "Thanksgiving");
  assert.equal(holidayPeriod(Date.UTC(2026, 11, 24)), "Winter holidays");
  assert.equal(holidayPeriod(Date.UTC(2026, 4, 23)), "Memorial Day weekend");
  assert.equal(holidayPeriod(Date.UTC(2026, 9, 9)), "");
  assert.equal(seasonPct(Date.UTC(2026, 0, 10)), 10);
  assert.equal(seasonPct(Date.UTC(2026, 6, 10)), -5);
  assert.equal(seasonPct(Date.UTC(2026, 9, 10)), 0);
});

t("gridWindow: worst conditions inside the window only", () => {
  assert.deepEqual(parseValidTime("2026-10-08T00:00:00+00:00/P1DT6H"), [Date.UTC(2026, 9, 8), Date.UTC(2026, 9, 9, 6)]);
  const props = {
    probabilityOfThunder: { values: [{ validTime: "2026-10-08T20:00:00+00:00/PT4H", value: 60 }, { validTime: "2026-10-09T05:00:00+00:00/PT3H", value: 90 }] },
    ceilingHeight: { values: [{ validTime: "2026-10-08T22:00:00+00:00/PT2H", value: 250 }] },        // m → ~800 ft
    visibility: { values: [{ validTime: "2026-10-08T20:00:00+00:00/PT6H", value: 9656 }] },
    windGust: { values: [{ validTime: "2026-10-08T20:00:00+00:00/PT6H", value: 64.8 }] },            // km/h → 35 kt
    windSpeed: { values: [] },
  };
  const w = gridWindow(props, Date.UTC(2026, 9, 8, 23), Date.UTC(2026, 9, 9, 3));
  assert.equal(w.thunderPct, 60);        // the 90% is after the window
  assert.equal(w.cat, "IFR");
  assert.equal(w.gust, 35);
  const f = weatherAarFactor(w);
  assert.ok(Math.abs(f.factor - 0.85 * 0.65 * 0.85) < 1e-9);
  assert.equal(gridWindow(props, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21)), null);
});

const procs = {
  NORTH1: { type: "STAR", apt: ["KTST"], common: [["NNNNN", 31, -80]], transitions: { AAAAA: [["AAAAA", 33, -80], ["NNNNN", 31, -80]] } },
  EASTT2: { type: "STAR", apt: ["KTST"], common: [["EEEEE", 30, -78]], transitions: {} },
  OTHER1: { type: "STAR", apt: ["KXXX"], common: [["XXXXX", 10, 10]], transitions: {} },
};
const field = [30, -80];
const ll = { KNTH: [35, -80.5], KEST: [30.5, -75], KSTH: [25, -80], KTST: field };

t("gates: STAR entries by bearing, origins mapped to the nearest", () => {
  const e = starEntries(procs, "KTST", field);
  assert.deepEqual([...new Set(e.map(x => x.gate))].sort(), ["EASTT", "NORTH"]);
  assert.equal(gateForOrigin(e, field, ll.KNTH), "NORTH");
  assert.equal(gateForOrigin(e, field, ll.KEST), "EASTT");
  const mix = originMix({ hist: null, fieldIcao: "KTST", fieldLL: field, airportLL: i => ll[i],
    byAirport: { KNTH: { totalDep: 300 }, KEST: { totalDep: 100 }, KTST: { totalDep: 999 } } });
  assert.deepEqual(mix.list.map(x => x[0]), ["KNTH", "KEST"]);
  const gs = gateSharesFromOrigins(mix.list, e, field, i => ll[i]);
  assert.ok(Math.abs(gs.shares.NORTH - 0.75) < 1e-9 && Math.abs(gs.shares.EASTT - 0.25) < 1e-9);
  const hist = originMix({ hist: { peakOrigins: [["KEST", 30]], origins: [["KNTH", 99]] }, fieldIcao: "KTST", fieldLL: field, airportLL: i => ll[i], byAirport: {} });
  assert.deepEqual(hist.list, [["KEST", 30]]);
});

t("demand curve and TMI tiers", () => {
  const start = Date.UTC(2026, 9, 9, 23), end = Date.UTC(2026, 9, 10, 3);
  const apt = { days: { 5: { 22: { arr: 20 } } } };      // Friday 22z: 20 over 10 weeks = 2/hr
  const base = baselineFromHist(apt, 10);
  assert.equal(base(Date.UTC(2026, 9, 9, 22)), 2);
  const hours = demandCurve({ startMs: start, endMs: end, peak: 40, baselineFn: base });
  assert.equal(hours.length, 7);                       // 1 before, 4 event hours, 2 after
  assert.equal(hours[0].demand, Math.round(10 + 1));   // 25% of 40 + half the 2/hr normal
  assert.equal(Math.max(...hours.map(h => h.demand)), 40);
  const shares = { NORTH: 0.75, EASTT: 0.25 };
  assert.equal(recommendTmis({ hours, aar: 50, shares }).tier.id, "none");
  assert.equal(recommendTmis({ hours, aar: 37, shares }).tier.id, "mit");
  const gdp = recommendTmis({ hours, aar: 20, shares });
  assert.equal(gdp.tier.id, "gdp");
  assert.ok(gdp.gates.metered);
  const north = gdp.gates.rows.find(r => r.gate === "NORTH"), east = gdp.gates.rows.find(r => r.gate === "EASTT");
  assert.equal(north.slice, 15); assert.equal(north.mit, 25);
  assert.equal(east.slice, 5); assert.equal(east.mit, 60);
  assert.ok(gdp.window && gdp.window.startMs < start);
});

t("ring points and compass", () => {
  const r = ringPoints([30, -80], 300);
  assert.equal(r.length, 8);
  assert.ok(Math.abs(r[0].ll[0] - 35) < 0.1);
  assert.equal(compassName(r[3].brg), "SE");
});

t("past events: most recent usable event of a similar length", () => {
  const h = 3600000;
  const evs = [
    { id: 1, name: "Marathon", startMs: 10 * h * 100, endMs: 10 * h * 100 + 11 * h, fields: ["KTST"], peakArr: 13 },
    { id: 2, name: "Network-wide", startMs: 9 * h * 100, endMs: 9 * h * 100 + 4 * h, fields: Array(22).fill("K"), peakArr: 4 },
    { id: 3, name: "Spotlight", startMs: 8 * h * 100, endMs: 8 * h * 100 + 3 * h, fields: ["KTST"], peakArr: 41 },
  ];
  assert.equal(pickBasisEvent(evs, "", 4 * h).id, 3);
  assert.equal(pickBasisEvent(evs, "", 10 * h).id, 1);
  assert.equal(pickBasisEvent(evs, "2", 4 * h).id, 2);           // the controller's pick wins
  assert.equal(pickBasisEvent([], "", 4 * h), null);
  assert.equal(peakFromEvent(evs[2]).value, Math.round(41 * 1.15));
});

t("past events: likeness to the planned event, likely references", () => {
  const h = 3600000;
  const plan = { name: "28th Annual Boston Tea Party", startMs: Date.UTC(2026, 7, 1, 16), endMs: Date.UTC(2026, 7, 1, 22), fields: ["KBOS", "KBDL", "KPVD"] };
  const lastYear = { id: 1, name: "27th Annual Boston Tea Party - Live", startMs: Date.UTC(2025, 7, 2, 16), endMs: Date.UTC(2025, 7, 2, 22), fields: ["KBOS", "KBDL", "KPVD", "KACK"], peakArr: 60 };
  const fno = { id: 2, name: "Northeast FNO", startMs: Date.UTC(2026, 2, 6, 23), endMs: Date.UTC(2026, 2, 7, 3), fields: ["KBOS", "KJFK", "KPHL", "KDCA", "KBWI", "KIAD", "KEWR"], peakArr: 40 };
  const sat = { id: 3, name: "Summer Saturday Spotlight", startMs: Date.UTC(2026, 6, 4, 16), endMs: Date.UTC(2026, 6, 4, 22), fields: ["KBOS", "KJFK"], peakArr: 30 };
  const a = eventLikeness(lastYear, plan);
  assert.deepEqual(a.reasons, ["same name", "same length", "same day and time", "same time of year", "similar field count"]);
  assert.equal(eventLikeness(fno, plan).score, 0);
  assert.deepEqual(eventLikeness(sat, plan).reasons, ["same length", "same day and time", "same time of year", "similar field count"]);
  assert.deepEqual(likelyEvents([fno, sat, lastYear], plan).map(x => x.ev.id), [1, 3]);
  // a generic word ("FNO", "Annual") alone isn't a series match
  assert.ok(!eventLikeness({ ...fno, name: "Annual FNO" }, { ...plan, name: "Southwest FNO" }).reasons.includes("same name"));
  assert.deepEqual(likelyEvents([fno], { name: "", startMs: 0, endMs: 4 * h }), []);
});

t("event history: merge keeps events StatSim no longer lists", () => {
  const prev = { KBOS: [{ id: 1, startMs: 100, origins: [["KJFK", 3]] }, { id: 0, startMs: 50 }], KOLD: [{ id: 9, startMs: 10 }] };
  const fresh = { KBOS: [{ id: 2, startMs: 200 }, { id: 1, startMs: 100, arr: 5 }] };
  const m = mergeHistory(fresh, prev, 3);
  assert.deepEqual(m.KBOS.map(e => e.id), [2, 1, 0]);
  assert.equal(m.KBOS[1].arr, 5);                                   // fresh record wins
  assert.deepEqual(m.KBOS[1].origins, [["KJFK", 3]]);               // origins carry over
  assert.deepEqual(m.KOLD.map(e => e.id), [9]);
  assert.deepEqual(mergeHistory(fresh, prev, 1).KBOS.map(e => e.id), [2]);
});

console.log(`\n${passed} passed`);
