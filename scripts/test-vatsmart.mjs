#!/usr/bin/env node
/**
 * Regression tests for shared/vatsmart.js.
 * Usage: node scripts/test-vatsmart.mjs
 */
import assert from "node:assert/strict";
import {
  capacityFor, queueProjection, tmiTier, edctCompliance, groundStopsFor, nearestZulu, rebalanceSuggestion,
  groundOrigins, buildSituation, fmtZ, trackTaxi, taxiSummary, tafFromNwsProduct, starOptions, routeRecommendations,
  landingSlots, slotBalance, slotMoveHow,
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
  const what = capacityFor({ prog: { aar: 62 }, localAar: 45 });     // the page's what-if wins over the program
  assert.equal(what.capacity, 45); assert.equal(what.source, "local"); assert.equal(what.programAar, 62);
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

t("weather cut is a note on the clear-weather AAR, not advice to lower it", () => {
  const wx = { cat: "IFR", thunderPct: 0, gust: 0 };
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog: null, localAar: 30, wx, pilots: inbound("GRNCH", 3, 5, 55), now: NOW });
  const r = s.recs.find(x => x.id === "wx-aar");
  assert.equal(s.cap.capacity, 26);
  assert.ok(r && r.sev === "info" && !/Lower/.test(r.title), r && r.title);
});

t("landing slots are clock-aligned quarter hours; overdue lands in the first", () => {
  const now = Date.UTC(2026, 9, 9, 23, 7);
  const sl = landingSlots([{ eta: now - 5 * MIN }, { eta: Date.UTC(2026, 9, 9, 23, 15) }, { eta: Date.UTC(2026, 9, 9, 23, 29, 59) }], now);
  assert.equal(sl[0].start, Date.UTC(2026, 9, 9, 23, 0));
  assert.equal(sl[0].total, 1); assert.equal(sl[1].total, 2);
});

t("slot balancing: delay off the busiest STAR into the next slot, pull only airborne and far out", () => {
  const T = Date.UTC(2026, 9, 9, 23, 0), now = T + 2 * MIN;
  const f = (cs, gate, etaMin, status = "AIRBORNE", dist = 200) => ({ callsign: cs, gate, eta: T + etaMin * MIN, status, dist });
  /* 40/hr = 10 per slot; 23:15 slot has 12 (8 GRNCH), 23:30 has 9 so room for 1, 23:00 has 9 so room for 1 */
  const flights = [
    ...Array.from({ length: 9 }, (_, i) => f("A" + i, "OMN", 3 + i)),
    ...Array.from({ length: 8 }, (_, i) => f("G" + i, "GRNCH", 15 + i, i === 7 ? "GROUND" : "AIRBORNE")),
    ...Array.from({ length: 4 }, (_, i) => f("B" + i, "BITHO", 16 + i)),
    ...Array.from({ length: 9 }, (_, i) => f("C" + i, "OMN", 31 + i)),
  ];
  const [b] = slotBalance(flights, now, 40);
  assert.equal(b.start, T + 15 * MIN); assert.equal(b.count, 12); assert.equal(b.allow, 10);
  assert.equal(b.moves.length, 2);
  assert.ok(b.moves.every(m => m.gate === "GRNCH"), JSON.stringify(b.moves));
  const later = b.moves.find(m => m.shiftMin > 0), earlier = b.moves.find(m => m.shiftMin < 0);
  assert.equal(later.callsign, "G7"); assert.equal(later.to, T + 30 * MIN); assert.equal(later.shiftMin, 8);
  assert.match(slotMoveHow(later), /hold the departure 8 min/);
  assert.equal(earlier.callsign, "G0"); assert.equal(earlier.to, T); assert.equal(earlier.shiftMin, -1);
  assert.equal(b.left, 0);
  assert.deepEqual(slotBalance(flights.slice(0, 9), now, 40), []);
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

t("taxi-out is timed from 7 kt to 60 kt near the field", () => {
  const sess = {};
  const at = (gs, alt = 0, lat = APT_LL[0]) => [{ callsign: "DAL1", dep: APT, arr: "KATL", lat, lon: APT_LL[1], gs, alt }];
  assert.deepEqual(trackTaxi(sess, at(0), APT, APT_LL, NOW), []);
  assert.equal(sess.DAL1.phase, "watching");
  trackTaxi(sess, at(15), APT, APT_LL, NOW + 5 * MIN);
  assert.equal(sess.DAL1.phase, "rolling");
  const done = trackTaxi(sess, at(140, 400), APT, APT_LL, NOW + 27 * MIN);
  assert.equal(done.length, 1);
  assert.equal(done[0].durationMs, 22 * MIN);
  assert.equal(sess.DAL1, undefined);
  /* already airborne when first seen: not timed */
  assert.deepEqual(trackTaxi(sess, at(250, 5000), APT, APT_LL, NOW), []);
  assert.deepEqual(sess, {});
});

t("taxi summary flags slow taxi-out", () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ callsign: "A" + i, startMs: NOW - (40 + i) * MIN, endMs: NOW - (15 + i) * MIN, durationMs: 25 * MIN }));
  samples.push({ ...samples[0] });                                             // same flight from two sources
  samples.push({ callsign: "OLD", startMs: NOW - 5 * 3600000, endMs: NOW - 4.5 * 3600000, durationMs: 60 * MIN });
  const sessions = { UAL9: { phase: "rolling", startMs: NOW - 31 * MIN }, SWA2: { phase: "watching" } };
  const tx = taxiSummary({ samples, sessions, now: NOW });
  assert.equal(tx.sampleCount, 6);
  assert.equal(tx.avgMin, 25);
  assert.equal(tx.groundQueue, 2);
  assert.equal(tx.longestCs, "UAL9");
  assert.equal(tx.longestMin, 31);
  const prog = normPrograms({ [APT]: { aar: 40 } })[APT];
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog, pilots: [], now: NOW, taxi: tx });
  const r = s.recs.find(x => x.id === "taxi");
  assert.ok(r && r.title === "Taxi-out averaging 25 min at KMCO", r && r.title);
  assert.equal(taxiSummary({ samples: [], sessions: {}, now: NOW }), null);
});

t("TAF text comes out of the NWS product", () => {
  const prod = "\n000\nFTUS42 KMLB 091120\nTAFMCO\nTAF\nKMCO 091120Z 0912/1018 11005KT P6SM FEW009 SCT250\n     FM091400 13008KT P6SM SCT015\n      TEMPO 0920/0924 4SM TSRA BR BKN025CB\n     FM101400 17009KT P6SM SCT030 BKN120=\n$$\n";
  const taf = tafFromNwsProduct(prod, "KMCO");
  assert.ok(taf.startsWith("KMCO 091120Z 0912/1018"));
  assert.ok(taf.includes("TEMPO 0920/0924"));
  assert.ok(taf.endsWith("BKN120"));
  assert.equal(tafFromNwsProduct("nothing here", "KMCO"), "");
});

t("STAR options come from navdata transitions and the common route", () => {
  const procs = {
    GRNCH5: { type: "STAR", apt: [APT], transitions: { CRG: [["CRG", 30.33, -81.51]], IRQ: [["IRQ", 33.71, -82.16]] }, common: [["GRNCH", 28.9, -81.6]] },
    SNFLD3: { type: "STAR", apt: [APT], transitions: {}, common: [["OMN", 29.30, -81.11]] },
    GRNCH: { type: "STAR", apt: [APT], transitions: {}, common: [["GRNCH", 28.9, -81.6]] },   // un-numbered duplicate: skipped
    XYZ1: { type: "STAR", apt: ["KTPA"], transitions: {}, common: [["XYZ", 28, -82]] },
  };
  const opts = starOptions(procs, APT, APT_LL);
  assert.deepEqual(opts.map(o => o.star + ":" + o.fix), ["GRNCH5:CRG", "GRNCH5:IRQ", "GRNCH5:GRNCH", "SNFLD3:OMN"]);
  assert.equal(opts[3].gate, "SNFLD");
});

t("reroutes: CDR for ground flights, STAR swap for airborne", () => {
  const stars = [
    { star: "GRNCH5", gate: "GRNCH", fix: "CRG", ll: [30.33, -81.51] },
    { star: "SNFLD3", gate: "SNFLD", fix: "OMN", ll: [29.30, -81.11] },
    { star: "PRICY5", gate: "PRICY", fix: "PRICY", ll: [27.0, -80.6] },
  ];
  const air = inbound("GRNCH", 30, 25, 55);                     // north of the field, 175-385 nm out
  const ground = Array.from({ length: 4 }, (_, i) => ({ callsign: "GND" + i, lat: 33.64, lon: -84.43, gs: 0, alt: 1000, phase: "gnd",
    dep: "KATL", arr: APT, type: "B738", route: "KATL DCT POUNC GRNCH5 " + APT, tas: 450 }));
  const cdrs = { KATL: [["ATLMCOPC", "POUNC", "POUNC2 POUNC GRGIA MGMRY DEEDA GRNCH5", "2", "N", ""],
    ["ATLMCOGA", "IRQ", "GAIRY2 IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3", "2", "N", ""]] };
  const prog = normPrograms({ [APT]: { aar: 24 } })[APT];
  const airportLL = c => ({ KATL: [33.64, -84.43] })[c] || null;
  const s = buildSituation({ airport: APT, aptLL: APT_LL, prog, pilots: [...air, ...ground], airportLL, now: NOW, routing: { stars, cdrs } });
  assert.ok(s.reroutes.length, "a reroute");
  const r = s.reroutes[0];
  assert.equal(r.gate, "GRNCH");
  const cdr = r.moves.filter(m => m.kind === "cdr");
  assert.ok(cdr.length >= 1);
  assert.equal(cdr[0].code, "ATLMCOGA");
  assert.equal(cdr[0].to, "SNFLD");
  assert.ok(r.moves.every(m => m.to !== "GRNCH"));
  assert.ok(r.moves.filter(m => m.kind === "star").every(m => m.extraNm <= 60));
  const rec = s.recs.find(x => x.id === "reroute-GRNCH");
  assert.ok(rec && /CDR ATLMCOGA/.test(rec.why), rec && rec.why);
  assert.ok(!s.recs.some(x => x.id === "rebalance"));
  /* no stars known: nothing concrete */
  assert.deepEqual(routeRecommendations({ sit: s, stars: [], cdrs }), []);
});

console.log(`\n${passed} passed`);
