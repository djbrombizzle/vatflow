#!/usr/bin/env node
/**
 * Regression: departure taxi sequencer (SID + next fix, diverging intervals, CPS search).
 * Usage: node scripts/test-taxi-sequencer.mjs
 */
import { readFileSync } from "node:fs";
import {
  angleDiff, bearingDeg, courseColor, departureFix, fixClocks, pairInterval, readySec,
  scheduleOrder, sequenceRunway, wakeOf, DEFAULT_INTERVALS,
} from "../shared/taxi-sequencer.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

/* ---------- geometry ---------- */
assert(Math.round(bearingDeg(0, 0, 1, 0)) === 0, "north");
assert(Math.round(bearingDeg(0, 0, 0, 1)) === 90, "east");
assert(angleDiff(350, 10) === 20, "wraps through north");
assert(angleDiff(90, 270) === 180, "opposite");
assert(courseColor(200).startsWith("hsl(200"), "hue is the bearing");
assert(wakeOf("H/B744/L") === "heavy" && wakeOf("A388") === "super" && wakeOf("B738/L") === "", "wake");

/* ---------- SID + next fix from the real nav data ---------- */
const procs = JSON.parse(readFileSync(new URL("../data/nav/procedures.json", import.meta.url)));
const fixes = JSON.parse(readFileSync(new URL("../data/nav/fixes.json", import.meta.url)));
const ATL = [33.6367, -84.4281];
const nav = { procs, fixes, icao: "KATL", fieldLL: ATL };

const t = departureFix({ ...nav, route: "BANNG3 LUCKK Q22 TEUFL" });
assert(t.sid === "BANNG3" && t.fix === "LUCKK" && t.source === "transition", "transition fix: " + JSON.stringify(t));
assert(t.bearing > 150 && t.bearing < 200, "LUCKK is south of ATL: " + t.bearing);
assert(t.label === "BANNG3·LUCKK", "label");

const e = departureFix({ ...nav, route: "BANNG3 J52 VUZ" });
assert(e.fix === "BANNG" && e.source === "exit", "airway after SID falls back to the SID exit: " + JSON.stringify(e));

const nosid = departureFix({ ...nav, route: "DCT LUCKK" });
assert(nosid.sid === "" && nosid.fix === "LUCKK" && nosid.source === "route", "no SID uses first fix");

const junk = departureFix({ ...nav, route: "" });
assert(junk.fix === "" && junk.label === "—·?", "empty route");

/* ---------- intervals ---------- */
const N = { id: "N", fix: "NORTH", bearing: 0 };
const N2 = { id: "N2", fix: "NORTH2", bearing: 10 };
const NE = { id: "NE", fix: "NE", bearing: 30 };
const S = { id: "S", fix: "SOUTH", bearing: 180 };
assert(pairInterval(N, { ...N, id: "x" }).kind === "same", "same fix");
assert(pairInterval(N, N2).kind === "same", "under 15 deg is in trail");
assert(pairInterval(N, NE).kind === "partial", "15-45 partial");
assert(pairInterval(N, S).sec === DEFAULT_INTERVALS.diverge, "diverging 1 minute");
assert(pairInterval({ ...S, wake: "heavy" }, N).kind === "wake", "heavy ahead wins");

/* ---------- schedule ---------- */
const sch = scheduleOrder([{ ...N, ready: 0 }, { ...S, ready: 0 }, { ...N, id: "N3", ready: 0 }]);
assert(sch.slots.map(s => s.t).join() === "0,60,120", "N S N alternates at 60 s: " + sch.slots.map(s => s.t));
const floor = scheduleOrder([{ ...N, ready: 0 }], { fixFloors: { NORTH: 45 } });
assert(floor.slots[0].t === 45 && floor.slots[0].held, "fix floor from another runway holds");
const behind = scheduleOrder([{ ...N, ready: 0 }], { lastDep: { fix: "NORTH", bearing: 0, agoSec: 30 } });
assert(behind.slots[0].t === 90, "last departure's clock carries over");

/* ---------- sequencing ---------- */
// Everyone at the hold short: N N S S -> N S N S saves time.
const q = [
  { id: "A", fix: "NORTH", bearing: 0, ready: 0 },
  { id: "B", fix: "NORTH", bearing: 0, ready: 1 },
  { id: "C", fix: "SOUTH", bearing: 180, ready: 2 },
  { id: "D", fix: "SOUTH", bearing: 180, ready: 3 },
];
const r = sequenceRunway(q);
assert(r.order.map(a => a.id).join("") === "ACBD", "interleaves the fixes: " + r.order.map(a => a.id).join(""));
assert(r.savedSec > 0, "saves time");
assert(r.moves.length === 1 && r.moves[0].id === "C" && r.moves[0].ahead[0] === "B", "C moves ahead of B");

// Nobody jumps more than MAX_SHIFT places.
const long = Array.from({ length: 10 }, (_, i) => ({ id: "X" + i, fix: i < 7 ? "NORTH" : "SOUTH", bearing: i < 7 ? 0 : 180, ready: i }));
const lr = sequenceRunway(long);
const fi = new Map(lr.fcfsOrder.map((a, i) => [a.id, i]));
assert(lr.order.every((a, i) => Math.abs(fi.get(a.id) - i) <= 2), "constrained position shift");
assert(lr.best.total <= lr.fcfs.total, "never worse than first-come");

// Already alternating: nothing to change.
const alt = sequenceRunway([{ ...N, ready: 0 }, { ...S, ready: 1 }, { ...N, id: "N9", ready: 2 }]);
assert(alt.savedSec === 0 && alt.moves.length === 0, "no change when already split");

/* ---------- readiness and clocks ---------- */
assert(readySec({ lat: 0, lon: 0, gs: 0 }, { lat: 0, lon: 0 }) === 90, "parked: spool only");
assert(readySec({ lat: 0, lon: 0, gs: 12 }, { lat: 0, lon: 0 }) === 0, "moving at the runway: 0");
assert(readySec({ lat: 0.008, lon: 0, gs: 0, moved: true }, { lat: 0, lon: 0 }) === 0, "holding in line near the runway: ready now");
assert(readySec({ lat: 0.008, lon: 0, gs: 0 }, { lat: 0, lon: 0 }) > 90, "parked near the runway still spools and taxis");
assert(readySec({ lat: 0.03, lon: 0, gs: 14, moved: true }, { lat: 0, lon: 0 }) > 300, "taxiing 1.8 nm out");
const clocks = fixClocks([{ fix: "NORTH", agoSec: 50 }, { fix: "SOUTH", agoSec: 500 }]);
assert(clocks.NORTH === 70 && clocks.SOUTH === 0, "fix clocks: " + JSON.stringify(clocks));

console.log(`taxi-sequencer: ${passed} passed`);
