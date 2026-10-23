#!/usr/bin/env node
/**
 * Regression: departure taxi sequencer (SID + next fix, diverging intervals, CPS search).
 * Usage: node scripts/test-taxi-sequencer.mjs
 */
import { readFileSync } from "node:fs";
import {
  angleDiff, bearingDeg, courseColor, departureFix, departureGate, fixClocks, gateBearings, isTrail, milesSec, pairInterval, readySec, releaseFloor,
  runwayRelation, scheduleOrder, sequenceRunway, wakeOf, DEFAULT_INTERVALS,
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

/* ---------- intervals (FAA JO 7110.65) ---------- */
const N = { id: "N", fix: "NORTH", bearing: 0 };
const N12 = { id: "N12", fix: "NORTH12", bearing: 12 };
const N15 = { id: "N15", fix: "NORTH15", bearing: 15 };
const S = { id: "S", fix: "SOUTH", bearing: 180 };
assert(pairInterval(N, { ...N, id: "x" }).kind === "same", "same fix is in trail (5-5-4)");
assert(pairInterval(N, N12).kind === "same", "12 deg conventional: in trail");
assert(milesSec(1) === 21 && milesSec(3) === 64, "miles at 170 kt: 1 NM 21 s, 3 NM 64 s");
const d15 = pairInterval(N, N15);
assert(d15.kind === "diverge" && d15.sec === 45 && d15.rule === "3-9-6a", "15 deg same runway: runway separation binds, not the 1 mile: " + JSON.stringify(d15));
const c15 = pairInterval(N, N15, undefined, "close");
assert(c15.sec === 21 && c15.rule === "5-8-3a", "15 deg off a close parallel: 1 mile, no runway separation");
const r12 = pairInterval({ ...N, rnav: true }, { ...N12, rnav: true });
assert(r12.kind === "diverge" && r12.sec === 45, "both RNAV SIDs: 10 deg is enough (5-8-3b)");
assert(pairInterval({ ...N, rnav: true }, { ...N12, rnav: true }, { rwySep: 10 }).rule === "5-8-3b", "5-8-3b named when the mile binds");
const tr = pairInterval(N, { ...N, id: "y" });
assert(tr.sec === 64 && tr.rule === "5-5-4", "in trail: 3 NM is 64 s");
assert(pairInterval(N, { ...N, id: "y" }, { trailNm: 5 }).sec === 106, "a departure MIT raises the in-trail time");
assert(pairInterval({ ...N, rnav: true }, N12).kind === "same", "only one on an RNAV SID: still 15 deg");
assert(pairInterval({ ...N, rnav: true }, { ...N12, rnav: true }, undefined, "close").kind === "same", "RNAV 10 deg is same runway only");
assert(pairInterval(N, S).sec === DEFAULT_INTERVALS.rwySep, "diverging off the same runway: runway separation");
const hv = pairInterval({ ...S, wake: "heavy" }, N);
assert(hv.kind === "wake" && hv.sec === 120 && hv.rule === "3-9-6f", "2 minutes behind a heavy (3-9-6f)");
assert(pairInterval({ ...S, wake: "super" }, N).sec === 180, "3 minutes behind a super");
assert(pairInterval(N, { ...S, fix: "", bearing: NaN }).kind === "unknown", "unknown course: in trail");
assert(pairInterval(N, N15, undefined, "far").kind === "simul", "far parallels diverging: simultaneous (5-8-3a2)");
assert(pairInterval(N, N12, undefined, "far").sec === 64, "far parallels not diverging: in trail");
assert(pairInterval({ ...S, wake: "heavy" }, N, undefined, "far").sec === 0, "no wake rule between far runways");

/* ---------- runway relations (KATL ends from data/nav/runways.json) ---------- */
const end = (id, lat, lon, hdg) => ({ id, lat, lon, hdg });
const r26L = end("26L", 33.6468, -84.4055, 270), r26R = end("26R", 33.6495, -84.4095, 270);
const r27R = end("27R", 33.6347, -84.4089, 270), r08R = end("08R", 33.6468, -84.4384, 90);
assert(runwayRelation(r26L, r26L) === "same", "same end");
assert(runwayRelation(r26L, r08R) === "same", "reciprocal is the same runway");
assert(runwayRelation(r26L, r26R) === "close", "26L/26R ~1,000 ft apart are close parallels");
assert(runwayRelation(r26L, r27R) === "far", "26L/27R ~4,400 ft apart are independent");

const fl = releaseFloor(N, [{ fix: "NORTH", bearing: 0, agoSec: 30, relation: "far" }, { ...S, agoSec: 10, relation: "same" }]);
assert(fl === 35, "floor: runway separation behind S (45-10) beats in trail behind the far-runway NORTH (64-30): " + fl);
assert(releaseFloor(N, [{ ...S, agoSec: 10, relation: "far" }]) === -Infinity, "far and diverging: nothing holds it");

/* ---------- schedule ---------- */
const sch = scheduleOrder([{ ...N, ready: 0 }, { ...S, ready: 0 }, { ...N, id: "N3", ready: 0 }]);
assert(sch.slots.map(s => s.t).join() === "0,45,90", "N S N alternates at runway separation: " + sch.slots.map(s => s.t));
const floor = scheduleOrder([{ ...N, ready: 0, floor: 45 }]);
assert(floor.slots[0].t === 45 && floor.slots[0].held, "release floor from departures already gone holds");
const behind = scheduleOrder([{ ...N, ready: 0 }], { lastDep: { fix: "NORTH", bearing: 0, agoSec: 30 } });
assert(behind.slots[0].t === 34, "last departure's clock carries over (64 - 30)");

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
assert(lr.moves.every(m => m.ahead.length > 0), "every listed move jumps someone");

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
assert(clocks.NORTH === 14 && clocks.SOUTH === 0, "fix clocks: " + JSON.stringify(clocks));

/* ---------- KATL departure gates ---------- */
assert(departureGate("KATL", "PLMMR3") === "E1" && departureGate("katl", "JACCC2") === "E1", "E1 by SID base");
assert(departureGate("KATL", "PENCL2") === "N1" && departureGate("KATL", "VRSTY3") === "S1", "N1, S1");
assert(departureGate("KATL", "ZELAN4") === "" && departureGate("KJFK", "DEEZZ6") === "", "no gate");
const gb = gateBearings("KATL", procs, ATL);
assert(Object.keys(gb).length === 8, "eight gates: " + Object.keys(gb));
assert(angleDiff(gb.N1, 0) < 60 && angleDiff(gb.S2, 180) < 60 && angleDiff(gb.E1, 90) < 60 && angleDiff(gb.W1, 270) < 60,
  "gates point their way: " + JSON.stringify(gb));
const E1a = { id: "E1a", gate: "E1", fix: "E1", bearing: 95 }, E1b = { id: "E1b", gate: "E1", fix: "E1", bearing: 95 };
const E2 = { id: "E2", gate: "E2", fix: "E2", bearing: 100 };
assert(pairInterval(E1a, E1b).kind === "same", "E1 behind E1 is in trail");
assert(pairInterval(E1a, E2).kind === "diverge", "E1 then E2 is split, however close their bearings");
// E1 E1 E2 E2 all at the hold short: split them so no gate goes behind itself.
const gq = [
  { ...E1a, ready: 0 }, { ...E1b, ready: 1 }, { ...E2, ready: 2 }, { ...E2, id: "E2b", ready: 3 },
];
const gr = sequenceRunway(gq, { trailPenalty: 600 });
assert(gr.best.trail === 0 && gr.fcfs.trail === 2, "no gate behind itself: " + gr.order.map(a => a.id));
assert(gr.best.slots.every(x => !isTrail(x.pair)), "every pair split");
// A big penalty splits even when the other gate is still taxiing in.
const far = sequenceRunway([{ ...E1a, ready: 0 }, { ...E1b, ready: 0 }, { ...E2, ready: 240 }], { trailPenalty: 600 });
assert(far.order.map(a => a.id).join() === "E1a,E2,E1b", "waits for E2 rather than E1 behind E1: " + far.order.map(a => a.id));
const nopen = sequenceRunway([{ ...E1a, ready: 0 }, { ...E1b, ready: 0 }, { ...E2, ready: 240 }]);
assert(nopen.order.map(a => a.id).join() === "E1a,E1b,E2", "without the penalty it keeps first-come");

console.log(`taxi-sequencer: ${passed} passed`);
