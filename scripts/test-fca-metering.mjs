#!/usr/bin/env node
/**
 * Regression tests for shared/fca-metering.js (v2 engine).
 * Usage: node scripts/test-fca-metering.mjs
 */

import {
  isCrossingAhead,
  hasPassedFca,
  isConnectedPilot,
  computeSequence,
  computeTowerDepartures,
  groundCrossing,
  sepSeconds,
  crossingEtaSec,
  profileTransitSec,
  seedAirports,
  markReady,
  clearReady,
  getRelease,
  READY_BUFFER_SEC,
  COMPLIANCE_LATE_MS,
} from "../shared/fca-metering.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} ±${tol})`);
}

seedAirports({
  KMIA: [25.7959, -80.2870],
  KFLL: [26.0726, -80.1527],
  KPBI: [26.6832, -80.0956],
  KJFK: [40.6413, -73.7781],
  KATL: [33.6367, -84.4281],
  KDCA: [38.8512, -77.0402],
  KMSY: [29.9934, -90.2580],
  KJAX: [30.4941, -81.6879],
  KSDF: [38.1740, -85.7365],
});

const fixedNow = Date.parse("2026-07-03T20:00:00Z");

/* ============================================================
   1. Geometry gates (unchanged behavior)
   ============================================================ */
const FCA_SB = {
  id: "fca4", name: "FCA 4", enabled: true, dir: "S",
  points: [[26.5, -82.0], [26.5, -79.5]],
  minFL: 0, maxFL: 999, mode: "rate", rate: 12,
};
const crossOnLine = { lat: 26.5, lon: -80.2 };
const pastSouth = {
  callsign: "TEST01", phase: "air", lat: 26.0, lon: -80.15, hdg: 185,
  gs: 420, alt: 28000, arr: "KMIA", dep: "KJFK", route: "DCT", tas: 450, fpAlt: 28000,
};
assert(!isCrossingAhead(pastSouth, crossOnLine), "crossing behind aircraft should not be ahead");
assert(hasPassedFca(pastSouth, FCA_SB), "south of SB FCA heading south = passed");

const approaching = { ...pastSouth, callsign: "TEST02", lat: 27.2, lon: -80.15, hdg: 180 };
assert(isCrossingAhead(approaching, crossOnLine), "crossing ahead when approaching SB FCA");
assert(!hasPassedFca(approaching, FCA_SB), "north of SB FCA is not passed");

const seq1 = computeSequence(FCA_SB, [pastSouth, approaching], [], { includeEdct: false, nowMs: fixedNow });
assert(seq1.items.some(c => c.p.callsign === "TEST02"), "approaching aircraft in sequence");
assert(!seq1.items.some(c => c.p.callsign === "TEST01"), "past aircraft excluded");

const bypass = {
  callsign: "BYPASS", phase: "air", lat: 30, lon: -85, hdg: 270, gs: 420,
  alt: 35000, dep: "KATL", arr: "KMSY", route: "DCT", tas: 450, fpAlt: 35000,
};
const aikenFca = {
  id: "aiken", enabled: true, dir: "any",
  points: [[34.8, -81.72], [35.8, -81.72]], mode: "mit", mit: 45, minFL: 0, maxFL: 999,
};
assert(!computeSequence(aikenFca, [bypass], [], { includeEdct: false, nowMs: fixedNow })
  .items.some(c => c.p.callsign === "BYPASS"), "route not crossing FCA is excluded");

assert(!isConnectedPilot({ prefile: true }), "prefile flagged as not connected");
assert(isConnectedPilot({ prefile: false }), "connected pilot");

/* ============================================================
   2. Profile ETA engine
   ============================================================ */
// 300nm, cruise FL350, TAS 450, still air:
// seg A: 10000ft @2000fpm = 300s @250kt = 20.8nm
// seg B: 25000ft @1500fpm = 1000s @290kt = 80.6nm
// seg C: 198.6nm @450kt = 1589s  => total ≈ 2889s (~48 min)
approx(profileTransitSec(300, 0, 35000, 450, null), 2889, 60, "300nm/FL350/450kt profile ≈ 48 min");
// naive 250kt flat would say 4320s — assert we're nowhere near that
assert(Math.abs(profileTransitSec(300, 0, 35000, 450, null) - 4320) > 600,
  "profile ETA is not the old flat-250 estimate");
// short hop that never leaves segment A
approx(profileTransitSec(10, 0, 35000, 450, null), (10 / 250) * 3600, 5, "short dist stays in 250kt segment");
// from altitude mid-climb
assert(profileTransitSec(200, 20000, 35000, 450, null) < profileTransitSec(200, 0, 35000, 450, null),
  "starting higher = faster to the line");

/* ============================================================
   3. Taxi-speed bug regression
   ============================================================ */
const FCA_ANY = {
  id: "any1", enabled: true, dir: "any",
  points: [[28.0, -82.5], [28.0, -78.5]], mode: "rate", rate: 12, minFL: 0, maxFL: 999,
};
const parked = {
  callsign: "PARKED", phase: "gnd", lat: 25.80, lon: -80.28, gs: 0,
  dep: "KMIA", arr: "KJFK", fpAlt: 36000, tas: 450, route: "DCT", deptime: "",
};
const taxiing = { ...parked, callsign: "TAXI", gs: 22 };
const gParked = groundCrossing(parked, FCA_ANY, fixedNow);
const gTaxi = groundCrossing(taxiing, FCA_ANY, fixedNow);
assert(gParked && gTaxi, "both ground aircraft get crossings");
approx(gTaxi.transitSec, gParked.transitSec, 2,
  "taxi groundspeed must NOT change route transit (old v1 bug)");
assert(gTaxi.transitSec < 3600, "taxiing aircraft ETA is not hours out");
approx(gParked.etaSec, crossingEtaSec(gParked.dist, gParked.gs), 1, "eta = dist / avg gs identity");

/* ============================================================
   4. THE 2100Z SCENARIO — air priority at the line
   Overflight crosses at ~T+60min; ground departure's unrestricted
   ETA is also ~T+60min. Ground MUST take the delay; air takes none.
   ============================================================ */
const FCA_N = {
  id: "n1", enabled: true, dir: "any",
  points: [[31.5, -84.0], [31.5, -79.0]],   // E-W line north of FL/GA
  mode: "rate", rate: 12,                    // 5-minute spacing
  minFL: 0, maxFL: 999,
};
// place the overflight so its crossing ETA ≈ a KJAX departure's profile ETA
const groundB = {
  callsign: "GNDB", phase: "gnd", lat: 30.49, lon: -81.69, gs: 0,
  dep: "KJAX", arr: "KDCA", fpAlt: 36000, tas: 450, route: "DCT", deptime: "",
};
const gB = groundCrossing(groundB, FCA_N, fixedNow);
const groundEta = READY_BUFFER_SEC + gB.transitSec;
// overflight at cruise, gs 450, aimed north across the line
const distNeeded = (groundEta / 3600) * 450;
const overA = {
  callsign: "AIRA", phase: "air",
  lat: 31.5 - distNeeded / 60, lon: -81.69, hdg: 0, gs: 450, alt: 34000,
  dep: "KMIA", arr: "KDCA", fpAlt: 34000, tas: 450, route: "DCT",
};
const seq2100 = computeSequence(FCA_N, [overA, groundB], [], { includeEdct: true, nowMs: fixedNow });
const aA = seq2100.items.find(c => c.p.callsign === "AIRA");
const bB = seq2100.items.find(c => c.p.callsign === "GNDB");
assert(aA && bB, "both aircraft in the 2100z sequence");
approx(aA.eta, bB.eta, 90, "scenario setup: both would hit the line together");
assert(aA.delay < 1, "airborne aircraft is NEVER delayed");
assert(aA.sched === aA.eta, "airborne crossing time is fixed at its ETA");
assert(bB.delay >= sepSeconds(FCA_N, bB) - 91, "ground aircraft absorbs the spacing delay");
assert(Math.abs(bB.sched - aA.sched) >= sepSeconds(FCA_N, bB) - 1, "spacing held at the line");
assert(bB.edctMs > fixedNow, "EDCT is in the future");
approx(bB.edctMs, fixedNow + (bB.sched - bB.transitSec) * 1000, 1500, "EDCT = crossing slot minus transit");

/* ============================================================
   5. Airborne ordering by ETA (not distance) + conflict flags
   ============================================================ */
const slowClose = {
  callsign: "SLOW", phase: "air", lat: 30.6, lon: -81.0, hdg: 0, gs: 130, alt: 8000,
  dep: "KMIA", arr: "KDCA", fpAlt: 8000, tas: 130, route: "DCT",
};
const fastFar = {
  callsign: "FAST", phase: "air", lat: 29.8, lon: -81.5, hdg: 0, gs: 490, alt: 35000,
  dep: "KMIA", arr: "KDCA", fpAlt: 35000, tas: 470, route: "DCT",
};
const etaSeq = computeSequence(FCA_N, [slowClose, fastFar], [], { includeEdct: false, nowMs: fixedNow });
const slow = etaSeq.items.find(c => c.p.callsign === "SLOW");
const fast = etaSeq.items.find(c => c.p.callsign === "FAST");
assert(slow.dist < fast.dist, "setup: SLOW is closer in nm");
assert(fast.eta < slow.eta, "setup: FAST arrives first anyway");
assert(etaSeq.items.indexOf(fast) < etaSeq.items.indexOf(slow), "airborne ordered by ETA, not distance");
assert(fast.delay < 1 && slow.delay < 1, "no fictional airborne delays");

// two airborne violating the rate -> flagged, not rescheduled
const twin1 = { ...fastFar, callsign: "TWIN1", lat: 29.80 };
const twin2 = { ...fastFar, callsign: "TWIN2", lat: 29.78 };
const twinSeq = computeSequence(FCA_N, [twin1, twin2], [], { includeEdct: false, nowMs: fixedNow });
assert(twinSeq.conflicts >= 1, "airborne pair inside spacing is flagged as conflict");
twinSeq.items.forEach(c => assert(c.sched === c.eta, "conflicted air still crosses at its own ETA"));

/* ============================================================
   6. Ready-now releases
   ============================================================ */
const fcaR = { ...FCA_N, id: "r1", releases: {}, excluded: [], order: [] };
const gndX = { ...groundB, callsign: "GNDX" };
const gndY = { ...groundB, callsign: "GNDY" };

// advisory pass: Y floats behind X (both unready, same eta -> one gets pushed)
let advSeq = computeSequence(fcaR, [gndX, gndY], [], { includeEdct: true, nowMs: fixedNow });
const advX = advSeq.items.find(c => c.p.callsign === "GNDX");
const advY = advSeq.items.find(c => c.p.callsign === "GNDY");
assert(!advX.frozen && !advY.frozen, "unready ground is advisory (not frozen)");
assert(Math.abs(advX.sched - advY.sched) >= sepSeconds(fcaR, advY) - 1, "advisory pair still spaced");

// Y calls ready: it claims the EARLIEST slot even though advisory X was projected there
const relY = markReady(fcaR, "GNDY", [gndX, gndY], fixedNow);
assert(relY && getRelease(fcaR, "GNDY"), "markReady stores a frozen release");
const yCta0 = relY.ctaMs, yEdct0 = relY.edctMs;   // snapshot (release objects mutate in place)
const readyEta = READY_BUFFER_SEC + gB.transitSec;
approx((relY.ctaMs - fixedNow) / 1000, readyEta, 5, "ready aircraft gets the unrestricted earliest slot");
assert(relY.edctMs >= fixedNow + READY_BUFFER_SEC * 1000 - 1000, "EDCT respects the 3-min ready buffer");

// recompute: Y frozen at the front, X floats behind it
let seqR = computeSequence(fcaR, [gndX, gndY], [], { includeEdct: true, nowMs: fixedNow });
const rX = seqR.items.find(c => c.p.callsign === "GNDX");
const rY = seqR.items.find(c => c.p.callsign === "GNDY");
assert(rY.frozen && rY.ready, "ready aircraft is frozen in the sequence");
assert(rY.sched < rX.sched, "ready aircraft jumped ahead of the unready one");
assert(rX.sched - rY.sched >= sepSeconds(fcaR, rX) - 1, "unready aircraft re-floated behind the release");

// freeze stability: 60s later the EDCT has not moved
const later = fixedNow + 60000;
const seqR2 = computeSequence(fcaR, [gndX, gndY], [], { includeEdct: true, nowMs: later });
const rY2 = seqR2.items.find(c => c.p.callsign === "GNDY");
assert(rY2.edctMs === yEdct0, "frozen EDCT does not churn between refreshes");

// second ready aircraft slots BEHIND the first release
markReady(fcaR, "GNDX", [gndX, gndY], fixedNow);
const relX = getRelease(fcaR, "GNDX");
assert(relX.ctaMs - yCta0 >= sepSeconds(fcaR, rX) * 1000 - 1500, "second release spaced behind the first");

// compliance: blow the +5 window -> release recomputes later
const stale = yEdct0 + COMPLIANCE_LATE_MS + 60000;
computeSequence(fcaR, [gndX, gndY], [], { includeEdct: true, nowMs: stale });
const relY3 = getRelease(fcaR, "GNDY");
assert(relY3.edctMs > yEdct0, "missed +5 window forces a later recomputed EDCT");

// departure consumes the release
const gndYAir = { ...gndY, phase: "air", gs: 180, alt: 2500, lat: 30.55, lon: -81.69, hdg: 0 };
computeSequence(fcaR, [gndX, gndYAir], [], { includeEdct: true, nowMs: stale });
assert(!getRelease(fcaR, "GNDY"), "airborne aircraft's release is consumed");
assert(clearReady(fcaR, "GNDX") && !getRelease(fcaR, "GNDX"), "clearReady removes the release");

/* ============================================================
   7. Airborne encroachment bumps a frozen release LATER only
   ============================================================ */
const fcaE = { ...FCA_N, id: "e1", releases: {}, excluded: [], order: [] };
const relE = markReady(fcaE, "GNDX", [gndX], fixedNow);
const eCta0 = relE.ctaMs;                          // snapshot before mutation
const ctaSec = (eCta0 - fixedNow) / 1000;
// pop an overflight whose ETA lands exactly on the frozen CTA
const encroachDist = (ctaSec / 3600) * 450;
const intruder = {
  callsign: "POPUP", phase: "air", lat: 31.5 - encroachDist / 60, lon: -81.69,
  hdg: 0, gs: 450, alt: 34000, dep: "KMIA", arr: "KDCA", fpAlt: 34000, tas: 450, route: "DCT",
};
const seqE = computeSequence(fcaE, [gndX, intruder], [], { includeEdct: true, nowMs: fixedNow });
const relE2 = getRelease(fcaE, "GNDX");
const air = seqE.items.find(c => c.p.callsign === "POPUP");
assert(air.delay < 1, "intruding airborne keeps its ETA");
assert(relE2.ctaMs > eCta0, "frozen release bumped later, never earlier");
assert((relE2.ctaMs - fixedNow) / 1000 - air.sched >= sepSeconds(fcaE, seqE.items.find(c => c.p.callsign === "GNDX")) - 31,
  "bumped release clears the airborne crossing");
assert(seqE.releasesChanged, "encroachment flagged so pages can cloudPush");

/* ============================================================
   8. Deptime honored for unready aircraft
   ============================================================ */
const futureDep = new Date(fixedNow + 40 * 60000);
const dep4 = String(futureDep.getUTCHours()).padStart(2, "0") + String(futureDep.getUTCMinutes()).padStart(2, "0");
const lateFiler = { ...groundB, callsign: "LATE", deptime: dep4 };
const seqD = computeSequence({ ...FCA_N, id: "d1", releases: {} }, [lateFiler], [], { includeEdct: true, nowMs: fixedNow });
const lf = seqD.items.find(c => c.p.callsign === "LATE");
assert(lf.eta >= 40 * 60 + gB.transitSec - 60, "future filed deptime pushes unrestricted ETA");

/* ============================================================
   9. MIT uses predicted crossing speed
   ============================================================ */
const fcaMit = { ...FCA_N, id: "m1", mode: "mit", mit: 30, releases: {} };
const sepFast = sepSeconds(fcaMit, { crossSpd: 450 });
const sepSlow = sepSeconds(fcaMit, { crossSpd: 150 });
approx(sepFast, (30 / 450) * 3600, 1, "MIT->time at 450kt crossing speed");
assert(sepSlow > sepFast * 2.5, "slower crosser needs proportionally more time");

/* ============================================================
   10. Tower departures view
   ============================================================ */
const twrFca = { ...FCA_N, id: "t1", name: "T1", color: "#fff", releases: {}, excluded: [], order: [] };
const twrRes = computeTowerDepartures("KJAX", [twrFca], [overA, gndX, gndY]);
assert(twrRes.total === 2, "two undeparted at the field");
assert(twrRes.departures.length === 2, "both metered");
twrRes.departures.forEach(d => {
  assert(d.edctMs != null && d.ctaMs != null, "rows carry EDCT/CTA");
  assert(typeof d.frozen === "boolean" && typeof d.ready === "boolean", "rows carry ready/frozen flags");
});
const dList = twrRes.departures;
assert(Math.abs(dList[1].sched - dList[0].sched) >= sepSeconds(twrFca, dList[1]) - 1,
  "tower rows respect line spacing");

/* ============================================================
   11. Inclusion-gate fixes (event regression 2026-07)
   ============================================================ */
import { explainFcaExclusion, fcaMatchesDest, airportCodesMatch, fcaLookaheadNm, LOOKAHEAD_NM } from "../shared/fca-metering.js";

// long-haul crossing beyond the old 1200nm cap must now be metered
const luaFca = { id:"lua", name:"LUA", enabled:true, dir:"any", mode:"mit", mit:50,
  minFL:0, maxFL:999, points:[[49.0,-91.2],[28.5,-91.2]], releases:{}, excluded:[], order:[] };
const slcMia = { callsign:"WEST1", phase:"air", lat:41.0, lon:-112.4, hdg:120, gs:470, alt:35000,
  dep:"KSLC", arr:"KMIA", fpAlt:35000, tas:460, route:"KDEN KDFW KMSY" };
seedAirports({ KSLC:[40.7884,-111.9778], KDEN:[39.8617,-104.6731], KDFW:[32.8969,-97.0381] });
const luaSeq = computeSequence(luaFca, [slcMia], [], { includeEdct:false, nowMs: fixedNow });
assert(luaSeq.items.some(c => c.p.callsign === "WEST1"), "1300nm-out crossing is inside the new lookahead");
assert(LOOKAHEAD_NM >= 2000, "default lookahead covers continental FCA lines");
assert(fcaLookaheadNm({ lookaheadNm: 800 }) === 800, "per-FCA lookahead override honored");
const shortFca = { ...luaFca, id:"short", lookaheadNm: 800 };
assert(!computeSequence(shortFca, [slcMia], [], { includeEdct:false, nowMs: fixedNow })
  .items.length, "per-FCA short lookahead still filters distant traffic");

// dest filter: 3-letter entries match filed ICAO and vice versa
assert(airportCodesMatch("MIA", "KMIA") && airportCodesMatch("KMIA", "MIA"), "MIA <-> KMIA equivalence");
assert(!airportCodesMatch("MIA", "KMSY"), "no false positives");
assert(fcaMatchesDest({ dests:["MIA","EWR"] }, "KMIA"), "dests=['MIA'] matches filed KMIA");
assert(fcaMatchesDest({ dests:["KEWR"] }, "EWR"), "dests=['KEWR'] matches filed EWR");
assert(!fcaMatchesDest({ dests:["MIA"] }, "KEWR"), "dest filter still filters");

// altitude band: airborne matches on current OR filed cruise
const bandFca = { ...luaFca, id:"band", minFL:240, maxFL:350 };
const climber = { callsign:"CLMB", phase:"air", lat:38.0, lon:-101.0, hdg:100, gs:380, alt:19000,
  dep:"KDEN", arr:"KMIA", fpAlt:35000, tas:460, route:"KDFW KMSY" };
assert(computeSequence(bandFca, [climber], [], { includeEdct:false, nowMs: fixedNow })
  .items.some(c => c.p.callsign === "CLMB"), "climber below band included via filed cruise");
const highCruiser = { ...climber, callsign:"HIGH", alt:37100, fpAlt:37100 };
assert(!computeSequence(bandFca, [highCruiser], [], { includeEdct:false, nowMs: fixedNow })
  .items.some(c => c.p.callsign === "HIGH"), "cruiser above band (current AND filed) still excluded");

// explain diagnostic reports the failing gate
let ex = explainFcaExclusion({ ...luaFca, dests:["KEWR"] }, slcMia);
assert(!ex.included && ex.reason === "dest-filter", "explain: dest filter identified");
ex = explainFcaExclusion(shortFca, slcMia);
assert(!ex.included && ex.reason === "beyond-lookahead" && ex.distNm > 800, "explain: lookahead identified with distance");
ex = explainFcaExclusion(bandFca, highCruiser);
assert(!ex.included && ex.reason === "alt-filter", "explain: altitude band identified");
ex = explainFcaExclusion(luaFca, slcMia);
assert(ex.included && ex.reason === "included", "explain: included aircraft confirmed");
ex = explainFcaExclusion(luaFca, { ...slcMia, callsign:"BYP", arr:"KDEN", route:"" });
assert(!ex.included && (ex.reason === "no-crossing" || ex.reason === "crossing-behind"), "explain: non-crossing route identified");

/* ============================================================
   14. Departure-airport (origins) filter — "all KMCO departures 10 MIT"
   ============================================================ */
import { fcaMatchesOrigin } from "../shared/fca-metering.js";
seedAirports({ KMCO:[28.4294,-81.3089], KJAXX:[30.4941,-81.6879] });
const mcoFca = { id:"mco", name:"MCO 10MIT", enabled:true, dir:"any", mode:"mit", mit:10,
  minFL:0, maxFL:999, origins:["KMCO"], points:[[31.5,-84.0],[31.5,-79.0]], releases:{}, excluded:[], order:[] };
const mcoDep = { callsign:"MCO1", phase:"gnd", lat:28.43, lon:-81.31, gs:0,
  dep:"KMCO", arr:"KDCA", fpAlt:36000, tas:450, route:"DCT", deptime:"" };
const jaxDep = { ...mcoDep, callsign:"JAX1", dep:"KJAX", lat:30.49, lon:-81.69 };
const mcoAir = { callsign:"MCO2", phase:"air", lat:29.5, lon:-81.3, hdg:0, gs:440, alt:33000,
  dep:"KMCO", arr:"KDCA", fpAlt:33000, tas:450, route:"DCT" };
let oSeq = computeSequence(mcoFca, [mcoDep, jaxDep, mcoAir], [], { includeEdct:true, nowMs: fixedNow });
assert(oSeq.items.some(c=>c.p.callsign==="MCO1"), "KMCO ground departure metered");
assert(oSeq.items.some(c=>c.p.callsign==="MCO2"), "KMCO airborne departure metered");
assert(!oSeq.items.some(c=>c.p.callsign==="JAX1"), "non-KMCO departure NOT metered by origins filter");
assert(fcaMatchesOrigin({ origins:["MCO"] }, "KMCO"), "origins tolerant: MCO matches filed KMCO");
assert(fcaMatchesOrigin({ origins:[] }, "KJAX") && fcaMatchesOrigin({}, "KJAX"), "blank origins = all departures");
let oEx = explainFcaExclusion(mcoFca, jaxDep);
assert(!oEx.included && oEx.reason === "origin-filter", "explain: origin filter identified");

/* ============================================================
   15. Manual sequence + RDY releases (strip didn't update bug)
   ============================================================ */
const manFca = { id:"man", name:"MAN", enabled:true, dir:"any", mode:"rate", rate:10,
  minFL:0, maxFL:999, points:[[37.5,-82.5],[35.0,-80.0]], dests:["KDCA"],
  releases:{}, excluded:[], order:[], manualSeq:false };
const mA = { callsign:"MANA", phase:"gnd", lat:33.64, lon:-84.43, gs:0,
  dep:"KATL", arr:"KDCA", fpAlt:34000, tas:440, route:"DCT", deptime:"" };
const mB = { ...mA, callsign:"MANB" };
// controller drags into manual order [MANA, MANB]
manFca.order = ["MANA","MANB"]; manFca.manualSeq = true;
let mSeq = computeSequence(manFca, [mA, mB], [], { includeEdct:true, nowMs: fixedNow });
assert(mSeq.manual === true, "manual mode engaged");

// RDY on MANB: release must be honored by the manual scheduler (this was the bug)
const mRel = markReady(manFca, "MANB", [mA, mB], fixedNow);
assert(mRel, "markReady works in manual mode");
mSeq = computeSequence(manFca, [mA, mB], [], { includeEdct:true, nowMs: fixedNow });
const mItemB = mSeq.items.find(c=>c.p.callsign==="MANB");
const mItemA = mSeq.items.find(c=>c.p.callsign==="MANA");
assert(mItemB.frozen === true, "released strip shows FROZEN in manual mode");
assert(mItemB.edctMs === manFca.releases["MANB"].edctMs, "strip EDCT matches the frozen release");
assert(mItemB.sched >= mItemA.sched + sepSeconds(manFca, mItemB) - 2,
  "manual-mode release respects the controller's order (B stays behind A)");
const mEdct0 = manFca.releases["MANB"].edctMs;

// stability: 60s later the frozen time hasn't churned
mSeq = computeSequence(manFca, [mA, mB], [], { includeEdct:true, nowMs: fixedNow + 60000 });
assert(manFca.releases["MANB"].edctMs === mEdct0, "manual-mode frozen EDCT stable across refreshes");

// reorder released B to the FRONT: frozen time must NOT move earlier
manFca.order = ["MANB","MANA"];
mSeq = computeSequence(manFca, [mA, mB], [], { includeEdct:true, nowMs: fixedNow + 60000 });
assert(manFca.releases["MANB"].edctMs === mEdct0, "moving a released strip earlier never moves its frozen EDCT earlier");
const mA2 = mSeq.items.find(c=>c.p.callsign==="MANA");
const mB2 = mSeq.items.find(c=>c.p.callsign==="MANB");
assert(mA2.sched >= mB2.sched + sepSeconds(manFca, mA2) - 2, "unreleased strip re-chains behind the frozen release");

// back to auto: release still honored by the auto scheduler
manFca.order = []; manFca.manualSeq = false;
mSeq = computeSequence(manFca, [mA, mB], [], { includeEdct:true, nowMs: fixedNow + 60000 });
assert(mSeq.items.find(c=>c.p.callsign==="MANB").frozen === true, "release survives switching back to auto");

/* ============================================================
   12. Route resolution fixes (nav-data corruption, 2026-07)
   NOTE: seeds nav data — keep this section LAST.
   ============================================================ */
import { seedNavData, buildRouteAnchorsForAircraft } from "../shared/route-engine.js";

seedAirports({ KAAA:[34.0,-118.0], KBBB:[40.6,-74.0] });
seedNavData({
  meta: { cycle: "test" },
  fixes: {
    ALPHA: [[36.0,-110.0]],
    BRAVO: [[37.0,-105.0]],
    // TYGER-style collision: CHRLY is BOTH an enroute fix and a STAR base name
    CHRLY: [[38.0,-100.0]],
    DELTA: [[39.0,-95.0]],
    ECHOO: [[39.5,-90.0]],
    // duplicate-name trap: nearest candidate is a continent away from the route
    ROGUE: [[61.0,-150.0]],
    WRONG1:[[38.6,-94.2]], WRONG2:[[39.3,-94.9]],
  },
  navaids: {},
  airways: {},
  procedures: {
    // digit-stripped alias exactly like the real data build produces
    CHRLY:  { type:"STAR", common: [["WRONG1",38.6,-94.2],["WRONG2",39.3,-94.9]] },
    CHRLY4: { type:"STAR", common: [["WRONG1",38.6,-94.2],["WRONG2",39.3,-94.9]] },
    GOODS2: { type:"STAR", common: [["DELTA",39.0,-95.0],["ECHOO",39.5,-90.0]] },
  },
  preferred: {},
});

// (a) mid-route bare CHRLY = the FIX, never the STAR expansion
const flt = { callsign:"NAV1", phase:"air", lat:36.5, lon:-108.0, hdg:80, gs:460, alt:36000,
  dep:"KAAA", arr:"KBBB", fpAlt:36000, tas:450,
  route:"BADSD9 ALPHA BRAVO CHRLY DELTA ECHOO" };
let ra = buildRouteAnchorsForAircraft(flt, { includeNow:true });
let names = ra.anchors.map(a=>a.name);
assert(names.includes("CHRLY"), "bare CHRLY kept as a route point");
assert(!names.includes("WRONG1") && !names.includes("WRONG2"),
  "mid-route bare name does NOT expand the colliding STAR");
assert(ra.anchors.find(a=>a.name==="CHRLY").kind === "fix", "CHRLY resolved as fix, not procedure");

// (b) digit token still expands its procedure (at the route edge)
const flt2 = { ...flt, callsign:"NAV2", route:"ALPHA BRAVO CHRLY GOODS2" };
ra = buildRouteAnchorsForAircraft(flt2, { includeNow:true });
names = ra.anchors.map(a=>a.name);
assert(names.includes("DELTA") && names.includes("ECHOO"), "GOODS2 STAR (with digit) still expands");

// (c) unknown SID (FSR9-style) is skipped silently — flight continues from next waypoint
ra = buildRouteAnchorsForAircraft(flt, { includeNow:true });
assert(ra.unresolved.includes("BADSD9"), "unknown SID reported unresolved");
assert(ra.anchors.length >= 3, "route still builds past the unknown SID");

// (d) wrong-candidate guard: ROGUE (Alaska) 2600nm off-route is skipped, no detour
const flt3 = { ...flt, callsign:"NAV3", route:"ALPHA BRAVO ROGUE CHRLY DELTA" };
ra = buildRouteAnchorsForAircraft(flt3, { includeNow:true });
names = ra.anchors.map(a=>a.name);
assert(!names.includes("ROGUE"), "900nm+ candidate jump rejected");
assert(ra.unresolved.includes("ROGUE"), "rejected jump reported unresolved");
assert(names.includes("CHRLY") && names.includes("DELTA"), "route continues cleanly after rejected token");

// (e) airborne crossing measured from NOW — never a backtrack through the filed route
const midFca = { id:"mid", name:"MID", enabled:true, dir:"any", mode:"rate", rate:10,
  minFL:0, maxFL:999, points:[[45.0,-102.0],[30.0,-102.0]], releases:{}, excluded:[], order:[] };
const ex2 = explainFcaExclusion(midFca, flt);
assert(ex2.included, "airborne aircraft crossing found with nav data loaded");
assert(ex2.distNm < 600, `crossing measured from current position, not departure (got ${Math.round(ex2.distNm)}nm)`);

/* ============================================================
   13. Departure continuity — delays must never collapse when the
   leader lifts off (event regression: ATL->DCA 45MIT)
   ============================================================ */
seedAirports({ KATL:[33.6367,-84.4281] });
const ztl = { id:"ztl", name:"ZTL_DCA", enabled:true, dir:"any", mode:"mit", mit:45,
  minFL:0, maxFL:600, dests:["KDCA"], points:[[37.5,-82.5],[35.0,-80.0]], releases:{}, excluded:[], order:[] };
const atlDep = cs => ({ callsign:cs, phase:"gnd", lat:33.64, lon:-84.43, gs:0,
  dep:"KATL", arr:"KDCA", fpAlt:34000, tas:440, route:"DCT", deptime:"" });

let zSeq = computeSequence(ztl, [atlDep("DAL1"), atlDep("DAL2"), atlDep("DAL3")], [], { includeEdct:true, nowMs: fixedNow });
const zSep = sepSeconds(ztl, zSeq.items[1]);
assert(zSeq.items[0].delay < 30 && zSeq.items[1].delay >= zSep - 30 && zSeq.items[2].delay >= 2*zSep - 60,
  "MIT queue on the ground: 0 / +sep / +2sep");

// leader departs on WEST ops — heading directly away from the crossing
const dal1West = { ...atlDep("DAL1"), phase:"air", gs:165, alt:1400, hdg:270, lat:33.63, lon:-84.48 };
zSeq = computeSequence(ztl, [dal1West, atlDep("DAL2"), atlDep("DAL3")], [], { includeEdct:true, nowMs: fixedNow + 120000 });
const z1 = zSeq.items.find(c => c.p.callsign === "DAL1");
const z2 = zSeq.items.find(c => c.p.callsign === "DAL2");
const z3 = zSeq.items.find(c => c.p.callsign === "DAL3");
assert(z1 && z1.phase === "air", "climbing departure tracked despite off-crossing heading");
assert(z2.sched - z1.sched >= zSep - 5, "trailer spacing at the line held behind the departed leader");
assert(z3.sched - z2.sched >= zSep - 5, "third aircraft spacing held too");
assert(z2.delay > 60, "trailer delay did NOT collapse to zero when the leader departed");

// carryover: frozen release of an untrackable departure keeps protecting the slot
const ztl2 = { ...ztl, id:"ztl2", releases:{} };
markReady(ztl2, "DAL1", [atlDep("DAL1"), atlDep("DAL2")], fixedNow);
const ghost = { ...atlDep("DAL1"), phase:"air", gs:45, alt:600, hdg:270 };   // below AIR_MIN_GS: untrackable
let cSeq = computeSequence(ztl2, [ghost, atlDep("DAL2")], [], { includeEdct:true, nowMs: fixedNow + 120000 });
assert(getRelease(ztl2, "DAL1"), "release retained while departure is untracked");
const c2 = cSeq.items.find(c => c.p.callsign === "DAL2");
assert(c2.delay > 60, "trailer stays delayed against the carryover slot");
// once tracked properly, the release is consumed
const solid = { ...ghost, gs: 180, hdg: 60 };
cSeq = computeSequence(ztl2, [solid, atlDep("DAL2")], [], { includeEdct:true, nowMs: fixedNow + 180000 });
assert(!getRelease(ztl2, "DAL1"), "release consumed once the departure is tracked airborne");
assert(cSeq.items.some(c => c.p.callsign === "DAL1" && c.phase === "air"), "tracked departure now in sequence as air");
// and long past the CTA an unconsumed carryover expires
const ztl3 = { ...ztl, id:"ztl3", releases:{} };
const rel3 = markReady(ztl3, "DAL1", [atlDep("DAL1")], fixedNow);
computeSequence(ztl3, [{ ...ghost }], [], { includeEdct:true, nowMs: rel3.ctaMs + 11*60000 });
assert(!getRelease(ztl3, "DAL1"), "stale carryover release expires after CTA + 10min");

console.log(`test-fca-metering: all ${passed} assertions passed`);
