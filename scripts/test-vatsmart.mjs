#!/usr/bin/env node
/**
 * Regression tests for shared/vatsmart.js.
 * Usage: node scripts/test-vatsmart.mjs
 */
import assert from "node:assert/strict";
import {
  capacityFor, queueProjection, tmiTier, edctCompliance, groundStopsFor, nearestZulu, rebalanceSuggestion,
  groundOrigins, buildSituation, fmtZ,
} from "../shared/vatsmart.js";
import { normPrograms } from "../shared/mit-monitor.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const NOW = Date.UTC(2026, 9, 9, 23, 0);
const MIN = 60000;
const APT = "KMCO", APT_LL = [28.43, -81.31];

/* n airborne arrivals over a gate, spread evenly so the first lands in `fromMin` and the last by `toMin` */
function inbound(gate, n, fromMin, toMin, prefix = gate) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const etaMin = fromMin + (toMin - fromMin) * (n === 1 ? 0 : i / (n - 1));
    const dist = Math.max(10, etaMin * 7);              // 420 kt groundspeed
    out.push({ callsign: prefix + i, lat: APT_LL[0] + dist / 60, lon: APT_LL[1], gs: 420, alt: 30000, phase: "air",
      dep: "KATL", arr: APT, type: "B738", route: `KATL DCT ${gate}1 ${APT}` });
  }
  return out;
}

t("capacity uses the program AAR, else the local one, cut for weather", () => {
  assert.deepEqual(capacityFor({ prog: { aar: 40 } }).capacity, 40);
  assert.equal(capacityFor({ prog: null, localAar: 30 }).source, "local");
  assert.equal(capacityFor({ prog: null }).capacity, 0);
  const ifr = capacityFor({ prog: { aar: 40 }, wx: { cat: "IFR", thunderPct: 0, gust: 0 } });
  assert.equal(ifr.capacity, 34);
  assert.ok(ifr.reasons[0].startsWith("IFR"));
});

t("queue carries the backlog forward", () => {
  const flights = Array.from({ length: 20 }, (_, i) => ({ eta: NOW + i * MIN }));   // 20 in the first 15 min... and 5 more
  const q = queueProjection(flights, NOW, 40, 60, 15);
  assert.equal(q.bins[0].n, 15);
  assert.equal(q.bins[0].backlog, 5);                   // 15 vs 10 per 15 min
  assert.equal(q.bins[1].backlog, 0);                   // 5 + 5 - 10
  assert.equal(q.maxDelay, 8);                          // 5 / 40 * 60
  assert.equal(queueProjection(flights, NOW, 0).maxDelay, 0);
});

t("TMI tier thresholds match the Event planner", () => {
  assert.equal(tmiTier(0.9, 0).id, "none");
  assert.equal(tmiTier(1.1, 5).id, "mit");
  assert.equal(tmiTier(1.1, 20).id, "fca");
  assert.equal(tmiTier(1.5, 0).id, "gdp");
});

t("EDCT compliance: early, late, waiting", () => {
  const pilots = [
    { callsign: "AAL1", arr: APT, dep: "KCLT", phase: "air", gs: 400 },
    { callsign: "DAL2", arr: APT, dep: "KATL", phase: "gnd", gs: 0 },
    { callsign: "UAL3", arr: APT, dep: "KEWR", phase: "gnd", gs: 0 },
    { callsign: "SWA4", arr: "KTPA", dep: "KBWI", phase: "gnd", gs: 0 },
  ];
  const edcts = {
    a: { cs: "AAL1", t: NOW + 30 * MIN }, b: { cs: "DAL2", t: NOW - 20 * MIN },
    c: { cs: "UAL3", t: NOW + 10 * MIN }, d: { cs: "SWA4", t: NOW - 60 * MIN },
  };
  const r = edctCompliance({ edcts, airport: APT, pilots, now: NOW });
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.early.map(x => x.cs), ["AAL1"]);
  assert.deepEqual(r.late.map(x => x.cs), ["DAL2"]);
  assert.deepEqual(r.waiting.map(x => x.cs), ["UAL3"]);
});

t("ground stop end time resolves to the nearest occurrence", () => {
  assert.equal(nearestZulu("2330", NOW), NOW + 30 * MIN);
  assert.equal(nearestZulu("2230z", NOW), NOW - 30 * MIN);
  assert.equal(nearestZulu("0100", NOW), NOW + 120 * MIN);   // past midnight
  assert.equal(nearestZulu("25", NOW), null);
  const gs = groundStopsFor({ x: { id: "x", airport: "MCO", until: "2230", scope: "ZTL" }, y: { id: "y", airport: "KTPA", until: "2359" } }, APT, NOW);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].expired, true);
});

t("rebalance moves demand from the tightest gate to one with room", () => {
  const win = { total: 50, unassigned: 0, entries: [["GRNCH", 30], ["OMN", 14], ["PRICY", 6]] };
  const rb = rebalanceSuggestion(win, 40);
  assert.ok(rb);
  assert.equal(rb.from, "GRNCH");
  assert.equal(rb.to, "PRICY");
  assert.equal(rb.move, 12);
  assert.equal(rb.queueBefore, 10);
  assert.equal(rb.queueAfter, 5);
  assert.equal(rebalanceSuggestion({ total: 30, unassigned: 0, entries: [["A", 20], ["B", 10]] }, 40), null);
});

t("ground origins: only ground and prefiled flights in the window", () => {
  const live = [
    { status: "GROUND", dep: "KATL", eta: NOW + 10 * MIN }, { status: "PREFILE", dep: "KATL", eta: NOW + 20 * MIN },
    { status: "GROUND", dep: "KCLT", eta: NOW + 30 * MIN }, { status: "AIRBORNE", dep: "KJFK", eta: NOW + 5 * MIN },
    { status: "GROUND", dep: "KBOS", eta: NOW + 90 * MIN },
  ];
  assert.deepEqual(groundOrigins(live, NOW, NOW + 60 * MIN), [["KATL", 2], ["KCLT", 1]]);
});

t("quiet field: no TMI needed", () => {
  const prog = normPrograms({ [APT]: { aar: 40 } })[APT];
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog, pilots: inbound("GRNCH", 10, 5, 55), now: NOW });
  assert.equal(s.tier.id, "none");
  assert.equal(s.recs[0].id, "ok");
  assert.equal(s.counts.airborne, 10);
});

t("busy field: tier, gate MIT start and a missing program", () => {
  const pilots = [...inbound("GRNCH", 36, 5, 50), ...inbound("OMN", 14, 5, 50)];
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog: null, localAar: 40, pilots, now: NOW });
  assert.equal(s.peakWin.total, 50);
  assert.notEqual(s.tier.id, "none");
  const ids = s.recs.map(r => r.id);
  assert.ok(ids.includes("tier"));
  assert.ok(ids.includes("no-prog"));
  const g = s.recs.find(r => r.id === "gate-GRNCH");
  assert.ok(g && /Start \d+ MIT on GRNCH now/.test(g.title), g && g.title);
  assert.equal(s.recs[0].sev, "action");
});

t("program MIT that's no longer needed gets a stop", () => {
  const prog = normPrograms({ [APT]: { aar: 40, gates: [{ name: "GRNCH4", mit: 30 }] } })[APT];
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog, pilots: inbound("GRNCH", 6, 5, 55), now: NOW });
  const g = s.recs.find(r => r.id === "gate-GRNCH");
  assert.ok(g && g.title.startsWith("Stop MIT on GRNCH"), g && g.title);
});

t("no AAR anywhere asks for one", () => {
  const s = buildSituation({ airport: APT, aptLL: APT_LL, pilots: inbound("GRNCH", 5, 5, 55), now: NOW });
  assert.deepEqual(s.recs.map(r => r.id), ["no-aar"]);
});

t("upcoming event compares a past one to capacity", () => {
  const prog = normPrograms({ [APT]: { aar: 40 } })[APT];
  const events = [{ name: "Orlando FNO", startMs: NOW + 2 * 3600000, endMs: NOW + 5 * 3600000, airports: [APT] }];
  const pastEvents = [{ id: 1, name: "Orlando FNO", startMs: NOW - 90 * 86400000, endMs: NOW - 90 * 86400000 + 3 * 3600000, fields: [APT], peakArr: 48 }];
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog, pilots: [], now: NOW, events, pastEvents });
  const r = s.recs.find(x => x.id === "event");
  assert.ok(r);
  assert.equal(r.sev, "watch");
  assert.match(r.why, /about 55\/hr/);
  assert.equal(fmtZ(NOW), "2300z");
});

console.log(`\n${passed} passed`);
