#!/usr/bin/env node
/**
 * Tests for the event tools: shared/arrival-track.js (landings, holding),
 * shared/merge-points.js, shared/event-debrief.js and the airborne ETA allowance.
 * Usage: node scripts/test-event-tools.mjs
 */
import assert from "node:assert/strict";
import { createArrivalState, updateArrivals, holdingNow, landingRate } from "../shared/arrival-track.js";
import { buildMergePoints, upstreamWalk } from "../shared/merge-points.js";
import { buildDebrief, tmiTimeline, describeProgramChange } from "../shared/event-debrief.js";
import { airborneEtaMin, normRate, rollingGateDemand } from "../shared/mit-monitor.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const MIN = 60000, NOW = Date.UTC(2026, 9, 10, 0, 0);
const APT = "KMCO", LL = [28.43, -81.31];
const ac = (cs, dLat, gs, hdg, extra = {}) => ({ callsign: cs, lat: LL[0] + dLat, lon: LL[1], gs, alt: gs > 60 ? 8000 : 100, hdg, arr: APT, dep: "KATL", route: "KATL DCT GRNCH5 KMCO", ...extra });

t("airborne ETA allowance: grows with distance, capped at 12 min", () => {
  assert.equal(+airborneEtaMin(0, 200).toFixed(2), 0);
  assert.ok(Math.abs(airborneEtaMin(30, 300) - (6 + 5.4)) < 0.01);
  assert.ok(Math.abs(airborneEtaMin(300, 450) - (40 + 12)) < 0.01);
  assert.ok(airborneEtaMin(41, 300) > airborneEtaMin(39, 300));
});

t("landing: airborne near the field, then slow on it", () => {
  const s = createArrivalState(NOW);
  updateArrivals(s, [ac("DAL1", 0.1, 140, 180)], APT, LL, NOW);
  const r = updateArrivals(s, [ac("DAL1", 0.01, 30, 180)], APT, LL, NOW + 30000);
  assert.equal(r.landed.length, 1);
  assert.equal(r.landed[0].gate, "GRNCH");
  assert.equal(r.landed[0].t, NOW + 15000);
  /* a bounce back above 60 kt and down again isn't a second landing */
  updateArrivals(s, [ac("DAL1", 0.01, 70, 180)], APT, LL, NOW + 45000);
  assert.equal(updateArrivals(s, [ac("DAL1", 0.01, 20, 180)], APT, LL, NOW + 60000).landed.length, 0);
  const rate = landingRate(s, NOW + 60000);
  assert.equal(rate.last60, 1);
});

t("holding: a full turn 25-200 nm out is a hold, a 180 isn't", () => {
  const s = createArrivalState(NOW);
  for (let i = 0; i <= 16; i++) updateArrivals(s, [ac("HOLD1", 1, 230, (i * 25) % 360), ac("TURN1", 1.2, 230, Math.min(180, i * 15))], APT, LL, NOW + i * 15000);
  const h = holdingNow(s, NOW + 16 * 15000);
  assert.deepEqual(h.map(x => x.cs), ["HOLD1"]);
  assert.equal(h[0].dir, "N");
  /* flies straight for 4+ minutes: the hold ends and is logged */
  let ended = [];
  for (let i = 17; i <= 40; i++) ended = ended.concat(updateArrivals(s, [ac("HOLD1", 1 - (i - 16) * 0.01, 230, 180)], APT, LL, NOW + i * 15000).ended);
  assert.equal(ended.length, 1);
  assert.equal(holdingNow(s, NOW + 40 * 15000).length, 0);
  /* close in, turns are the approach */
  const s2 = createArrivalState(NOW);
  for (let i = 0; i <= 16; i++) updateArrivals(s2, [ac("APP1", 0.2, 180, (i * 25) % 360)], APT, LL, NOW + i * 15000);
  assert.equal(holdingNow(s2, NOW + 16 * 15000).length, 0);
});

t("landing rate: scales a partly watched hour, nothing under 20 minutes", () => {
  const s = createArrivalState(NOW);
  s.landings = [1, 2, 3, 4, 5].map(i => ({ cs: "A" + i, t: NOW + i * MIN }));
  s.covered = [[NOW, NOW + 30 * MIN]];
  const r = landingRate(s, NOW + 30 * MIN);
  assert.equal(r.covered, 30);
  assert.equal(r.perHr, 10);
  s.covered = [[NOW + 15 * MIN, NOW + 30 * MIN]];
  assert.equal(landingRate(s, NOW + 30 * MIN).perHr, null);
});

/* merge points on a toy network: two airways join at MERGE, then GATE */
const FIX = { A1: [31.5, -84.0], A2: [31.0, -83.0], B1: [32.5, -81.5], B2: [31.5, -81.6], MERGE: [30.2, -82.0], GATE: [29.5, -81.8] };
const anchorsOf = p => [{ name: p.dep, ll: [34, -84], kind: "apt" }, ...p.path.map(n => ({ name: n, ll: FIX[n], kind: n === "GATE" ? "star" : "fix", via: p.via })),
  { name: APT, ll: LL, kind: "apt" }];
function mergeCase(nA, nB, capacity) {
  const flights = [], pil = {};
  const add = (cs, path, via, k) => {
    const gateEta = NOW + 20 * MIN + k * 3 * MIN;
    flights.push({ callsign: cs, gate: "GATE", gateEta, eta: gateEta + 15 * MIN, status: "AIRBORNE", airborne: true, prefiled: false, dep: "KXXX" });
    pil[cs] = { callsign: cs, dep: "KXXX", path, via };
  };
  for (let i = 0; i < nA; i++) add("A" + i, ["A1", "A2", "MERGE", "GATE"], "Q85", i);
  for (let i = 0; i < nB; i++) add("B" + i, ["B1", "B2", "MERGE", "GATE"], "Q83", i + 0.5);
  const roll = rollingGateDemand({ flights, now: NOW, horizonMin: 180 });
  return buildMergePoints({ flights, routeOf: cs => pil[cs], anchorsFor: anchorsOf, gateIndex: a => a.findIndex(x => x.name === "GATE"),
    artccFor: (lat) => (lat > 30.8 ? "ZTL" : "ZJX"), originCenter: () => "ZDC", aptLL: LL, windows: roll.windows, capacity, now: NOW });
}

t("upstream walk: fixes back from the gate with the time each is passed", () => {
  const a = anchorsOf({ dep: "KXXX", path: ["A1", "A2", "MERGE", "GATE"], via: "Q85" });
  const w = upstreamWalk(a, 4, NOW + 30 * MIN);
  assert.deepEqual(w.fixes.map(f => f.name), ["GATE", "MERGE", "A2", "A1"]);
  assert.ok(w.fixes[1].t < w.fixes[0].t);
  assert.equal(w.fromOrigin, true);
});

t("merge over the gate's share: per-stream MIT and who to ask", () => {
  const ms = mergeCase(12, 10, 15);                 // one gate, 22 an hour into a 15 an hour field
  const m = ms.find(x => x.fix === "MERGE");
  assert.ok(m, "merge found");
  assert.equal(m.status, "over");
  assert.equal(m.peak.n, 22);
  assert.equal(m.branches.length, 2);
  assert.equal(m.branches[0].label, "Q85 (A2)");
  assert.equal(m.branches[0].center, "ZTL");
  assert.ok(m.branches.every(b => b.mit >= 45), "both streams limited");
  assert.deepEqual(m.branches[0].from, [["ZDC", 12]]);
});

t("merge within the share: ok, no MIT", () => {
  const m = mergeCase(3, 3, 60).find(x => x.fix === "MERGE");
  assert.equal(m.status, "ok");
  assert.ok(m.branches.every(b => !b.mit));
});

t("debrief: TMI words, landings against the AAR, spacing against the MIT", () => {
  assert.deepEqual(describeProgramChange(normRate({ aar: 40, gates: [{ name: "GRNCH5", mit: 20 }] }), normRate({ aar: 36, gates: [{ name: "GRNCH5", mit: 25 }, { name: "SNFLD", mit: 15 }] })),
    ["AAR 40 → 36", "GRNCH 20 MIT → 25 MIT", "SNFLD 15 MIT"]);
  const tl = tmiTimeline([{ t: NOW, kind: "program", value: { aar: 40 } }, { t: NOW + MIN, kind: "edct", cs: "DAL1", value: NOW + 30 * MIN },
    { t: NOW + 2 * MIN, kind: "gs", value: [{ scope: "ZTL", until: "0100" }] }]);
  assert.deepEqual(tl.map(e => e.kind), ["program", "edct", "gs"]);
  const doc = { field: APT, event: { name: "Test" }, recorded: [[NOW, NOW + 60 * MIN]],
    tmi: [{ t: NOW - MIN, kind: "program", value: { aar: 40, gates: [{ name: "GRNCH", mit: 20 }] } }],
    flights: {
      A: { cs: "A", dep: "KATL", gate: "GRNCH", cross: { t: NOW + 10 * MIN, gs: 360 }, land: NOW + 25 * MIN, pos: [] },
      B: { cs: "B", dep: "KATL", gate: "GRNCH", cross: { t: NOW + 12 * MIN, gs: 360 }, land: NOW + 27 * MIN, pos: [] },
      C: { cs: "C", dep: "KATL", gate: "GRNCH", cross: { t: NOW + 16 * MIN, gs: 360 }, land: NOW + 31 * MIN, pos: [] },
    },
    landings: [{ cs: "A", t: NOW + 25 * MIN }, { cs: "B", t: NOW + 27 * MIN }, { cs: "C", t: NOW + 31 * MIN }], holds: [], taxi: [] };
  const d = buildDebrief(doc, LL);
  assert.equal(d.totals.landed, 3);
  assert.equal(d.bins[1].n, 2);
  assert.equal(d.bins[1].aar, 40);
  const g = d.gates[0];
  assert.equal(g.gate, "GRNCH");
  assert.deepEqual(g.pairs.map(p => p.gap), [12, 24]);
  assert.equal(g.short, 1);                          // 12 nm against 20 MIT
  assert.equal(doc.flights.A.delay, undefined, "the log isn't changed");
});

console.log(`\n${passed} passed`);
