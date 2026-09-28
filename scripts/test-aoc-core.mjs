#!/usr/bin/env node
/**
 * Regression: Dispatch Center core (operator matching, phases, OOOI, alerts, telex).
 * Usage: node scripts/test-aoc-core.mjs
 */
import { readFileSync } from "node:fs";
import {
  PHASE, TELEX_MAX, TEMPLATES, airportIndex, allMessages, applyOp, classifyDownlink, composeTelex, deriveFlights,
  distNm, bearing, emptyState, makeAirportWatch, airportLabel, gcPoint, hhmmToMin, isHolding, loadMemory, makeWatch, matchFlight, movePoint, nearestAirport,
  parseFiledAlt, pendingReply, primeMemory, saveMemory, stdMs, ARRIVED_DWELL_MS, LOST_MS, KEEP_ARRIVED_MS,
  createRouteResolver, routeMetrics, routeLength, distToSegmentNm,
} from "../shared/aoc-core.js";
import { seedNavData, preferredRoute } from "../shared/route-engine.js";
import { demoOfpJson, fetchOfp, matchOfp, parseOfp, simbriefUrl } from "../shared/aoc-simbrief.js";
import { equivalentType, estimateFuel, gcdAllowanceNm, tableFuelKg, KG_TO_LB } from "../shared/aoc-fuel.js";
import { autoAdvisoryTargets, composeTmiTelex, demoAdvisory, demoBoard, restrictionsFor, tmiAlerts, tmiIndex, AUTO_ADVISORY_MAX } from "../shared/aoc-tmi.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);
}

const OPS = JSON.parse(readFileSync(new URL("../data/aoc/operators.json", import.meta.url)));
const idx = airportIndex(JSON.parse(readFileSync(new URL("../data/nav/runways.json", import.meta.url))));
const A = icao => idx.get(icao) || null;

/* ---------- data ---------- */
for (const [code, o] of Object.entries(OPS)) {
  if (code.startsWith("_")) continue;
  assert(/^[A-Z]{3}$/.test(code), `${code}: 3-letter code`);
  assert(o.name && o.telephony, `${code}: name and telephony`);
  assert(o.station && o.station.length <= 8, `${code}: station <= 8 chars`);
  for (const h of o.hubs || []) assert(idx.has(h), `${code}: hub ${h} in runways.json`);
  assert(o.fleet && o.fleet.mainline && o.fleet.mainline.length, `${code}: demo fleet`);
}

/* ---------- geometry ---------- */
near(distNm(32.8998, -97.0403, 33.6367, -84.4281), 632, 6, "DFW-ATL distance");
{
  const a = A("KDFW"), b = A("KATL");
  const m = gcPoint(a, b, 0.5);
  near(distNm(a.lat, a.lon, m.lat, m.lon), distNm(m.lat, m.lon, b.lat, b.lon), 0.5, "midpoint is halfway");
  const p = movePoint(a.lat, a.lon, 90, 60);
  near(distNm(a.lat, a.lon, p.lat, p.lon), 60, 0.2, "movePoint distance");
}
assert(nearestAirport(idx, A("KDFW").lat + 0.01, A("KDFW").lon, 6).icao === "KDFW", "nearest airport");
assert(nearestAirport(idx, 30, -40, 6) === null, "no airport mid-Atlantic");

/* ---------- parsing ---------- */
assert(parseFiledAlt("FL350") === 35000 && parseFiledAlt("35000") === 35000 && parseFiledAlt("350") === 35000, "filed alt");
assert(parseFiledAlt("") === null, "no filed alt");
assert(hhmmToMin("0215") === 135 && hhmmToMin("45") === 45 && hhmmToMin("0000") === null, "hhmm");
{
  const now = Date.UTC(2026, 8, 28, 23, 30);
  assert(stdMs("0010", now) === Date.UTC(2026, 8, 29, 0, 10), "STD after midnight is tomorrow");
  assert(stdMs("2300", now) === Date.UTC(2026, 8, 28, 23, 0), "STD earlier today");
  assert(stdMs("0000", now) === null, "blank STD");
}

/* ---------- matching ---------- */
{
  const W = makeWatch(OPS, "aal", ["n123ab"]);
  assert(W.code === "AAL" && W.known && W.station === "AALOPS", "watch from file");
  assert(matchFlight(W, "AAL123", "")?.via === "mainline", "mainline");
  assert(matchFlight(W, "AAL1A", "")?.via === "mainline", "alphanumeric flight number");
  assert(!matchFlight(W, "AALX", ""), "prefix alone is not a flight");
  assert(!matchFlight(W, "AAL", ""), "code alone is not a flight");
  assert(matchFlight(W, "ENY3401", "")?.carrier === "Envoy", "regional partner");
  assert(!matchFlight(W, "ENY3401", "", { regionals: false }), "regionals off");
  assert(!matchFlight(W, "SKW5001", "/V/"), "shared regional without remarks");
  assert(matchFlight(W, "SKW5001", "/V/ AMERICAN EAGLE")?.via === "remarks", "shared regional with remarks");
  assert(matchFlight(W, "RPA4400", "OPR/AAL /V/")?.via === "remarks", "OPR/code remark");
  assert(matchFlight(W, "N123AB", "")?.via === "watch", "watched callsign");
  assert(!matchFlight(W, "DAL100", ""), "other airline");
  const V = makeWatch(OPS, "xyz");
  assert(!V.known && V.station === "XYZOPS" && V.family.size === 0, "unknown code still works");
  assert(matchFlight(V, "XYZ42", "")?.via === "mainline", "virtual airline callsign");
}

/* ---------- phases and OOOI ---------- */
const W = makeWatch(OPS, "AAL");
const ctx = { W, A, idx };
const dfw = A("KDFW"), atl = A("KATL");
const FP = { aircraft_short: "A321", departure: "KDFW", arrival: "KATL", alternate: "KBHM", altitude: "FL360",
  deptime: "1400", enroute_time: "0200", fuel_time: "0400", route: "DCT", remarks: "/V/" };
const T0 = Date.UTC(2026, 8, 28, 13, 50);
function pilot(over) {
  return { callsign: "AAL100", cid: 1, latitude: dfw.lat, longitude: dfw.lon, altitude: 600, groundspeed: 0, heading: 0,
    transponder: "2000", flight_plan: FP, ...over };
}
{
  const mem = new Map();
  let t = T0;
  const step = (p, dt = 15000, feed = null) => { t += dt; return deriveFlights(ctx, feed || { pilots: [pilot(p)] }, mem, t); };
  // Prefile only.
  let rows = deriveFlights(ctx, { pilots: [], prefiles: [{ callsign: "AAL100", flight_plan: FP }] }, mem, t);
  assert(rows.length === 1 && rows[0].phase === PHASE.SCHED, "prefile is SCHED");
  assert(rows[0].std === Date.UTC(2026, 8, 28, 14, 0), "STD from deptime");
  assert(rows[0].filedEta === Date.UTC(2026, 8, 28, 16, 0), "filed ETA = STD + EET");
  // Connected at the gate.
  rows = step({});
  assert(rows[0].phase === PHASE.GATE && rows[0].out == null, "at gate");
  // Late at the gate.
  rows = step({}, 26 * 60000);
  assert(rows[0].alerts.some(a => a.key === "late"), "late departure alert after STD+15");
  // Push.
  rows = step({ groundspeed: 4, latitude: dfw.lat + 0.001 });
  assert(rows[0].phase === PHASE.TAXI_OUT && rows[0].out === t, "OUT on first move (moved > 80 m)");
  const out = t;
  rows = step({ groundspeed: 15, latitude: dfw.lat + 0.004 });
  assert(rows[0].phase === PHASE.TAXI_OUT && rows[0].out === out, "still taxiing, OUT unchanged");
  assert(rows[0].delay === Math.round((out - rows[0].std) / 60000), "departure delay = OUT - STD");
  // Takeoff.
  rows = step({ groundspeed: 160, altitude: 1200, latitude: dfw.lat + 0.02 });
  assert(rows[0].off === t && rows[0].phase !== PHASE.GATE, "OFF at first airborne snapshot");
  const off = t;
  assert(rows[0].eta === off + 120 * 60000, "just airborne at 160 kt: ETA = OFF + filed EET, not distance / GS");
  assert(rows[0].delay === Math.round((off - rows[0].std) / 60000), "delay in the climb = how late it took off");
  rows = step({ groundspeed: 280, altitude: 9000, latitude: dfw.lat + 0.2 });
  assert(rows[0].phase === PHASE.CLIMB, "climbing");
  assert(rows[0].eta === off + 120 * 60000, "still climbing: OFF + EET");
  rows = step({ groundspeed: 280, altitude: 9000, latitude: dfw.lat + 0.2 }, 6000);
  assert(rows[0].phase === PHASE.CLIMB, "same snapshot re-derived between feeds: still climbing");
  rows = step({ groundspeed: 380, altitude: 24000, latitude: dfw.lat + 0.4 });
  rows = step({ groundspeed: 385, altitude: 24010, latitude: dfw.lat + 0.45 });
  assert(rows[0].eta === off + 120 * 60000, "level at FL240 with FL360 filed (a temporary level-off): still OFF + EET");
  // Cruise.
  const mid = gcPoint(dfw, atl, 0.5);
  rows = step({ groundspeed: 460, altitude: 36000, latitude: mid.lat, longitude: mid.lon }, 20 * 60000);
  rows = step({ groundspeed: 460, altitude: 36000, latitude: mid.lat, longitude: mid.lon + 0.1 });
  rows = step({ groundspeed: 460, altitude: 36010, latitude: mid.lat, longitude: mid.lon + 0.2 });
  assert(rows[0].phase === PHASE.CRUISE, "cruise when level");
  assert(rows[0].eta > t && rows[0].distToGo > 250 && rows[0].distToGo < 400, "ETA from distance and speed");
  near(rows[0].eta, t + (rows[0].distToGo / 460) * 3600000, 3 * 60000, "at cruise: ETA = now + distance to go / GS");
  assert(rows[0].track.length >= 2, "track recorded");
  // Descent and approach.
  const late = gcPoint(dfw, atl, 0.85);
  rows = step({ groundspeed: 420, altitude: 30000, latitude: late.lat, longitude: late.lon });
  rows = step({ groundspeed: 400, altitude: 26000, latitude: late.lat, longitude: late.lon + 0.05 });
  assert(rows[0].phase === PHASE.DESCENT, "descending");
  const fin = movePoint(atl.lat, atl.lon, 270, 20);
  rows = step({ groundspeed: 220, altitude: 6000, latitude: fin.lat, longitude: fin.lon });
  assert(rows[0].phase === PHASE.APPROACH, "approach inside 40 nm below 12 000 ft");
  // Land, taxi, park.
  rows = step({ groundspeed: 120, altitude: 1000, latitude: atl.lat, longitude: atl.lon });
  rows = step({ groundspeed: 40, altitude: 1000, latitude: atl.lat, longitude: atl.lon });
  assert(rows[0].phase === PHASE.LANDED && rows[0].on === t, "ON at touchdown");
  assert(rows[0].alerts.length === 0, "landed at destination: no alert");
  rows = step({ groundspeed: 14, latitude: atl.lat + 0.002, longitude: atl.lon });
  assert(rows[0].phase === PHASE.TAXI_IN, "taxi in");
  rows = step({ groundspeed: 0, latitude: atl.lat + 0.003, longitude: atl.lon });
  const stop = t;
  assert(rows[0].phase === PHASE.TAXI_IN && rows[0].in == null, "stopped, not in yet");
  rows = step({ groundspeed: 0, latitude: atl.lat + 0.003, longitude: atl.lon }, ARRIVED_DWELL_MS);
  assert(rows[0].phase === PHASE.ARRIVED && rows[0].in === stop, "IN = when it stopped");
  // Disconnects: stays arrived, then drops.
  rows = step(null, 60000, { pilots: [] });
  assert(rows.length === 1 && rows[0].phase === PHASE.ARRIVED && !rows[0].connected, "arrived stays after disconnect");
  rows = step(null, KEEP_ARRIVED_MS, { pilots: [] });
  assert(rows.length === 0, "arrived drops off after 2 h");

  // Memory survives a reload.
  const saved = JSON.parse(JSON.stringify(saveMemory(mem, t)));
  assert(loadMemory(saved, t).size === mem.size, "memory round trip");
}
{
  // Connected mid-flight: no OUT/OFF known; next leg starts fresh.
  const mem = new Map();
  const mid = gcPoint(dfw, atl, 0.5);
  let rows = deriveFlights(ctx, { pilots: [pilot({ groundspeed: 450, altitude: 36000, latitude: mid.lat, longitude: mid.lon })] }, mem, T0);
  assert(rows[0].off == null && rows[0].out == null, "no OFF when not seen on the ground");
  // Diversion: arrival changed in flight.
  rows = deriveFlights(ctx, { pilots: [pilot({ groundspeed: 450, altitude: 36000, latitude: mid.lat, longitude: mid.lon, flight_plan: { ...FP, arrival: "KBHM" } })] }, mem, T0 + 15000);
  assert(rows[0].alerts.some(a => a.key === "div-KBHM"), "diversion alert");
  // Lost contact.
  rows = deriveFlights(ctx, { pilots: [] }, mem, T0 + 60000);
  assert(rows[0].phase === PHASE.LOST && rows[0].alerts[0].key === "lost", "lost when disconnected airborne");
  rows = deriveFlights(ctx, { pilots: [] }, mem, T0 + 60000 + LOST_MS + 1000);
  assert(rows.length === 0, "lost drops after 15 min");
}
{
  // Landed somewhere else.
  const mem = new Map();
  const bhm = A("KBHM");
  deriveFlights(ctx, { pilots: [pilot({ groundspeed: 300, altitude: 8000, latitude: bhm.lat + 0.3, longitude: bhm.lon })] }, mem, T0);
  const rows = deriveFlights(ctx, { pilots: [pilot({ groundspeed: 40, altitude: 700, latitude: bhm.lat, longitude: bhm.lon })] }, mem, T0 + 15000);
  assert(rows[0].alerts.some(a => a.key === "ldg-KBHM"), "landed-elsewhere alert");
}
{
  // New leg after arriving.
  const mem = new Map();
  primeMemory(mem, { AAL100: { leg: "KDFW-KATL", out: T0 - 3e6, off: T0 - 2.9e6, on: T0 - 6e5, in: T0 - 5e5 } }, T0);
  const rows = deriveFlights(ctx, { pilots: [pilot({ latitude: atl.lat, longitude: atl.lon, flight_plan: { ...FP, departure: "KATL", arrival: "KDFW" } })] }, mem, T0);
  assert(rows[0].phase === PHASE.GATE && rows[0].out == null, "next leg starts at the gate");
}
{
  // Squawk 7700; connected at the destination; no fuel alert.
  const mem = new Map();
  let rows = deriveFlights(ctx, { pilots: [pilot({ transponder: "7700", groundspeed: 400, altitude: 30000, latitude: 33, longitude: -90 })] }, mem, T0);
  assert(rows[0].alerts.some(a => a.key === "sq7700" && a.level === "bad"), "7700 alert");
  const m2 = new Map();
  rows = deriveFlights(ctx, { pilots: [pilot({ latitude: atl.lat, longitude: atl.lon })] }, m2, T0);
  assert(rows[0].phase === PHASE.ARRIVED, "connected on the ground at destination = arrived");
  const m3 = new Map();
  primeMemory(m3, { AAL100: { leg: "KDFW-KATL", out: T0 - 4.2 * 36e5, off: T0 - 4 * 36e5 } }, T0);
  const far = gcPoint(dfw, atl, 0.5);
  rows = deriveFlights(ctx, { pilots: [pilot({ groundspeed: 450, altitude: 36000, latitude: far.lat, longitude: far.lon })] }, m3, T0);
  assert(!rows[0].alerts.some(a => a.key === "fuel"), "no fuel alerts (4 h endurance, 4 h flown, 40 min to go)");
}
{
  // Holding.
  const now = T0;
  const h = [];
  for (let i = 0; i < 20; i++) h.push({ t: now - 400000 + i * 20000, h: (i * 18) % 360 });
  assert(isHolding(h, now), "a full turn is holding");
  assert(!isHolding(h.map(x => ({ ...x, h: 90 })), now), "straight is not");
}

/* ---------- shared state ---------- */
{
  const s = emptyState("AAL");
  assert(applyOp(s, { op: "note", callsign: "aal1", note: "gate change" }, "me", 1).ok, "note");
  assert(s.flights.AAL1.note === "gate change", "note stored under normalised callsign");
  assert(applyOp(s, { op: "ack", callsign: "AAL1", key: "late" }, "me", 2).ok && s.flights.AAL1.ack.late === 2, "ack");
  applyOp(s, { op: "msg", callsign: "AAL1", dir: "up", text: "aal ops: request eta" }, "me", 3);
  applyOp(s, { op: "msg", callsign: "AAL2", dir: "dn", text: "req gate" }, "me", 4);
  assert(allMessages(s)[0].callsign === "AAL2" && allMessages(s)[1].text === "AAL OPS: REQUEST ETA", "messages newest first, upper case");
  assert(!applyOp(s, { op: "bogus", callsign: "AAL1" }, "me", 5).ok, "unknown op rejected");
  assert(pendingReply(s.flights.AAL1, 3 + 11 * 60000)?.level === "warn", "unanswered request");
  applyOp(s, { op: "msg", callsign: "AAL1", dir: "dn", text: "ETA 1600Z FUEL 8.1" }, "me", 6);
  assert(pendingReply(s.flights.AAL1, 6 + 20 * 60000) === null, "answered");
}

/* ---------- telex ---------- */
{
  const r = { callsign: "AAL100", dep: "KDFW", arr: "KATL", altn: "KBHM", type: "A321", filedAlt: 36000, eet: 120 };
  for (const t of TEMPLATES) {
    const text = composeTelex(t.id, W, r, { gate: "T12", metar: "KATL 281752Z 27008KT 10SM FEW050 30/19 A3001 RMK AO2 " + "X".repeat(300) });
    assert(text.startsWith("AAL OPS:") && text.length <= TELEX_MAX, `${t.id}: prefix and length (${text.length})`);
  }
  assert(composeTelex("release", W, r) === "AAL OPS: RELEASE AAL100 KDFW-KATL A321. ALTN KBHM. FL360. EET 0200. HAVE A GOOD FLIGHT.", "release text");
  assert(composeTelex("gate", W, r, { gate: "T12" }) === "AAL OPS: ARR GATE T12 AT KATL. REPLY WILCO.", "gate text");
  assert(composeTelex("wx", W, r, { metar: "x".repeat(400) }).endsWith("..."), "long METAR cut");
}
{
  const c = t => classifyDownlink(t);
  assert(c("WILCO").kind === "wilco" && c("unable").kind === "unable" && c("roger thx").kind === "roger", "acks");
  assert(c("REQ GATE").kind === "gate" && c("request arrival gate pls").kind === "gate", "gate request");
  assert(c("REQ WX KDFW").kind === "wx" && c("REQ WX KDFW").icao === "KDFW", "wx with station");
  assert(c("KATL METAR?").icao === "KATL", "station before METAR");
  assert(c("DIVERTING TO KBHM FUEL").kind === "divert" && c("DIVERTING TO KBHM").icao === "KBHM", "divert");
  assert(c("DELAY 20 MIN MX").kind === "delay", "delay");
  assert(c("hello there").kind === "other", "other");
}

/* ---------- filed route (route-engine, FAA NASR) ---------- */
{
  const nav = f => JSON.parse(readFileSync(new URL(`../data/nav/${f}.json`, import.meta.url)));
  const resolve0 = createRouteResolver(A);
  assert(resolve0({ departure: "KDFW", arrival: "KATL", route: "DCT" }) === null, "no route before nav data loads");
  seedNavData({ meta: nav("meta"), fixes: nav("fixes"), navaids: nav("navaids"), airways: nav("airways"), procedures: nav("procedures"), preferred: nav("preferred") });
  const pref = preferredRoute("KDFW", "KATL");
  assert(/AKUNA\d/.test(pref) && pref === preferredRoute("DFW", "ATL"), "preferred route by ICAO or FAA id");
  assert(preferredRoute("KDFW", "EGLL") === "", "no preferred route");
  const resolve = createRouteResolver(A);
  const fpR = { ...FP, route: pref };
  const rt = resolve(fpR);
  assert(rt && rt.anchors.length >= 6 && !rt.unresolved.length, `route expands (${rt && rt.anchors.map(a => a.name).join(" ")})`);
  assert(rt.anchors[0].name === "KDFW" && rt.anchors[rt.anchors.length - 1].name === "KATL", "route runs airport to airport");
  assert(resolve(fpR) === rt, "cached");
  const gc = distNm(dfw.lat, dfw.lon, atl.lat, atl.lon);
  const len = routeLength(rt.anchors);
  assert(len > gc && len < gc * 1.3, `route longer than great circle (${Math.round(len)} vs ${Math.round(gc)})`);
  // On the route, over a fix in the middle.
  const k = Math.floor(rt.anchors.length / 2);
  const fix = rt.anchors[k];
  const nxt = rt.anchors[k + 1];
  const hdg = bearing(fix.ll[0], fix.ll[1], nxt.ll[0], nxt.ll[1]);
  const mm = routeMetrics(rt.anchors, fix.ll[0], fix.ll[1], hdg);
  near(mm.xtNm, 0, 1, "on the route: no cross-track");
  assert(mm.remainingNm < len && mm.remainingNm > distNm(fix.ll[0], fix.ll[1], atl.lat, atl.lon) - 1, "remaining along the route");
  assert(rt.anchors.slice(k).some(a => a.name === mm.next), "next fix is ahead");
  near(distToSegmentNm(fix.ll[0] + 1, fix.ll[1], [fix.ll[0], fix.ll[1] - 2], [fix.ll[0], fix.ll[1] + 2]), 60, 2, "cross-track of a point 1 deg north");
  // Through deriveFlights: ETA from route distance, next fix, off-route alert.
  const rctx = { W, A, idx, routeFor: resolve };
  const mem = new Map();
  primeMemory(mem, { AAL100: { leg: "KDFW-KATL", out: T0 - 3e6, off: T0 - 2.8e6, arr: "KATL" } }, T0);
  let rows = deriveFlights(rctx, { pilots: [pilot({ flight_plan: fpR, groundspeed: 450, altitude: 36000, heading: hdg, latitude: fix.ll[0], longitude: fix.ll[1] })] }, mem, T0);
  assert(rows[0].nextFix && rows[0].routeAnchors === rt.anchors, "row carries route and next fix");
  near(rows[0].distToGo, mm.remainingNm, 0.5, "distance to go follows the route");
  assert(!rows[0].alerts.some(a => a.key === "route"), "on route: no alert");
  const off = movePoint(fix.ll[0], fix.ll[1], (hdg + 90) % 360, 60);
  rows = deriveFlights(rctx, { pilots: [pilot({ flight_plan: fpR, groundspeed: 450, altitude: 36000, heading: hdg, latitude: off.lat, longitude: off.lon })] }, mem, T0 + 15000);
  assert(rows[0].alerts.some(a => a.key === "route"), `60 nm off route: alert (xt ${Math.round(rows[0].xtNm)})`);
  rows = deriveFlights(rctx, { pilots: [pilot({ flight_plan: { ...fpR, arrival: "KBHM" }, groundspeed: 450, altitude: 36000, heading: hdg, latitude: off.lat, longitude: off.lon })] }, mem, T0 + 30000);
  assert(!rows[0].alerts.some(a => a.key === "route") && rows[0].alerts.some(a => a.key === "div-KBHM"), "diverting: no off-route alert");
  const bad = resolve({ ...FP, route: "NOTAFIX J999 ZZZZZ" });
  assert(bad.unresolved.length > 0, "unknown tokens reported");
}

/* ---------- SimBrief OFP ---------- */
{
  assert(simbriefUrl("jsmith") === "https://www.simbrief.com/api/xml.fetcher.php?username=jsmith&json=1", "username URL");
  assert(simbriefUrl(" 123456 ").includes("userid=123456"), "numeric pilot ID uses userid");
  assert(parseOfp({ fetch: { status: "Error: Unknown UserID" } }).error === "SimBrief has no user by that name or ID.", "unknown user");
  assert(parseOfp({ fetch: { status: "Error: No flight plan on file for the specified user" } }).error === "That SimBrief user has no flight plan on file.", "no plan on file");
  // A SimBrief-shaped reply: strings for numbers, one-element lists as bare objects, epoch-second times.
  const raw = {
    fetch: { status: "Success" },
    params: { request_id: "123", time_generated: "1790000000", units: "kgs" },
    general: { icao_airline: "DAL", flight_number: "401", route: "AKUNA9 MLC", initial_altitude: "36000", costindex: "25", route_distance: "712" },
    atc: { callsign: "DAL401" },
    origin: { icao_code: "KDFW", plan_rwy: "17R" }, destination: { icao_code: "KATL", plan_rwy: "26R" },
    alternate: { icao_code: "KBHM" },
    aircraft: { icaocode: "A321", reg: "N301DN" },
    fuel: { plan_ramp: "12400", taxi: "200", enroute_burn: "7100", contingency: "360", alternate_burn: "1500", reserve: "1400", extra: "", min_takeoff: "12200", plan_landing: "5100" },
    weights: { pax_count: "180", cargo: "2100", est_zfw: "68300", est_tow: "80500", est_ldw: "73400", max_tow: "93500" },
    times: { sched_out: "1790003600", sched_in: "1790012000", est_time_enroute: "6300" },
    navlog: { fix: { ident: "MLC", pos_lat: "34.8", pos_long: "-95.7", time_total: "2400", fuel_plan_onboard: "9000" } },
    tlr: {
      takeoff: { conditions: { planned_runway: "17R", planned_weight: "80500" },
        runway: [{ identifier: "13L", speeds_v1: "130" }, { identifier: "17R", flap_setting: "CONF 1+F", thrust_setting: "FLEX", flex_temperature: "48", speeds_v1: "141", speeds_vr: "143", speeds_v2: "147" }] },
      landing: { conditions: { planned_runway: "26R", planned_weight: "73400" }, distance_dry: { flap_setting: "CONF FULL", speeds_vref: "134", factored_distance: "5600" } },
    },
  };
  const o = parseOfp(raw);
  assert(o.ok && o.units === "KGS" && o.callsign === "DAL401", "parsed header and units");
  assert(o.fuel.ramp === 12400 && o.fuel.trip === 7100 && o.fuel.extra === null, "fuel numbers; blank is null");
  assert(o.weights.pax === 180 && o.weights.tow === 80500, "weights");
  assert(o.times.schedOut === 1790003600000 && o.times.eetMin === 105, "epoch seconds to ms, EET in minutes");
  assert(o.navlog.length === 1 && o.navlog[0].ident === "MLC" && o.navlog[0].timeTotal === 2400, "single navlog fix as an object");
  assert(o.altn === "KBHM" && o.type === "A321" && o.reg === "N301DN", "alternate and aircraft");
  assert(o.tlr.takeoff.runway === "17R" && o.tlr.takeoff.v1 === 141 && o.tlr.takeoff.flex === 48, "takeoff data for the planned runway");
  assert(o.tlr.landing.runway === "26R" && o.tlr.landing.vref === 134, "landing data");
  assert(parseOfp({ ...raw, tlr: undefined }).tlr === null, "no TLR without runway analysis");
  // Match against the live flight.
  const row = { callsign: "DAL401", dep: "KDFW", arr: "KATL", type: "A321" };
  assert(matchOfp(o, row, 1790000000000 + 3600000).ok, "matching OFP");
  const mm = matchOfp(o, { ...row, callsign: "DAL402", arr: "KMCO" }, 1790000000000 + 30 * 3600000);
  assert(!mm.ok && mm.issues.length === 3, `callsign, destination and age flagged (${mm.issues.join("; ")})`);
  // Telex from the OFP.
  const W2 = makeWatch(OPS, "DAL");
  const ls = composeTelex("loadsheet", W2, row, { ofp: o });
  assert(ls === "DAL OPS: LOADSHEET DAL401 KDFW-KATL A321 N301DN. PAX 180. ZFW 68.3 TOW 80.5 LDW 73.4. BLOCK FUEL 12.4 TRIP 7.1. KGS X1000. CI 25.", `loadsheet text: ${ls}`);
  const to = composeTelex("todata", W2, row, { ofp: o });
  assert(to === "DAL OPS: T/O DATA KDFW RWY 17R. TOW 80.5. CONF 1+F. FLEX 48. V1 141 VR 143 V2 147. FROM SIMBRIEF, VERIFY.", `takeoff text: ${to}`);
  assert(composeTelex("lddata", W2, row, { ofp: o }) === "DAL OPS: LDG DATA KATL RWY 26R. LDW 73.4. CONF FULL. VREF 134. FROM SIMBRIEF, VERIFY.", "landing text");
  assert(/RUNWAY ANALYSIS OFF/.test(composeTelex("todata", W2, row, { ofp: parseOfp({ ...raw, tlr: undefined }) })), "says when there is no TLR");
  for (const id of ["loadsheet", "todata", "lddata"]) assert(composeTelex(id, W2, { ...row, callsign: "DAL4011" }, { ofp: o }).length <= TELEX_MAX, `${id} fits`);
  // Demo OFP round-trips through the same parser.
  const d = parseOfp(demoOfpJson({ callsign: "AAL100", dep: "KDFW", arr: "KATL", altn: "KBHM", type: "A321", distTotal: 700, filedAlt: 36000, std: 1790000000000 }));
  assert(d.ok && d.callsign === "AAL100" && d.tlr.takeoff.v1 && d.fuel.ramp > d.fuel.trip && d.weights.tow > d.weights.zfw, "demo OFP");
  assert(d.weights.zfw < d.weights.maxZfw && d.weights.tow < d.weights.maxTow && d.weights.ldw < d.weights.maxLdw, "demo OFP within its limits");
  // fetchOfp: network error and HTTP 400 handled.
  const e1 = await fetchOfp("x", async () => { throw new Error("offline"); });
  assert(!e1.ok && /could not be reached/.test(e1.error), "network error");
  const e2 = await fetchOfp("x", async () => ({ status: 400, json: async () => ({ fetch: { status: "Error: Unknown UserID" } }) }));
  assert(!e2.ok && /no user/.test(e2.error), "unknown user over HTTP");
  assert(!(await fetchOfp("  ")).ok, "blank username");
}

/* ---------- ICAO fuel estimate ---------- */
{
  const FD = JSON.parse(readFileSync(new URL("../data/aoc/icao-fuel.json", import.meta.url)));
  assert(FD.distancesNm.length === 20 && Object.keys(FD.types).length > 300, "table loaded");
  for (const [icao, eq] of Object.entries(FD.icaoTypes)) {
    const r = FD.types[eq];
    assert(r && r.every((v, i) => i === 0 || v > r[i - 1]), `${icao} (${eq}) row rises with distance`);
  }
  assert(equivalentType(FD, "a20n") === "32N" && equivalentType(FD, "B738/L") === "738" && equivalentType(FD, "C172") === null, "type mapping");
  // Straight lines between the table's distances.
  assert(tableFuelKg(FD, "738", 750).kg === 6221, "on a table point");
  near(tableFuelKg(FD, "738", 875).kg, (6221 + 7749) / 2, 0.5, "halfway between 750 and 1000 nm");
  assert(tableFuelKg(FD, "E75", 2000).beyond, "past the type's listed range is flagged");
  // ICAO allowance: +50 km under 550 km, +100 km to 5,500 km, +125 km beyond.
  near(gcdAllowanceNm(200), 50 / 1.852, 0.01, "short");
  near(gcdAllowanceNm(1000), 100 / 1.852, 0.01, "medium");
  near(gcdAllowanceNm(4000), 125 / 1.852, 0.01, "long");
  const e = estimateFuel(FD, { type: "B738", gcNm: 632, altnGcNm: 120 });
  assert(e.ok && e.basis === "gcd", "estimate from great circle");
  near(e.distNm, 632 + 100 / 1.852, 0.01, "distance with allowance");
  assert(e.tripKg > 5000 && e.tripKg < 7000, `737-800 DFW-ATL burn in a sane range (${Math.round(e.tripKg)} kg)`);
  assert(e.burnKgPerHour > 2000 && e.burnKgPerHour < 3500, `737-800 cruise burn per hour sane (${Math.round(e.burnKgPerHour)})`);
  near(e.totalKg, e.tripKg + e.altnKg + e.reserveKg, 0.01, "total = trip + alternate + reserve");
  const er = estimateFuel(FD, { type: "B738", gcNm: 632, routeNm: 700 });
  assert(er.basis === "route" && er.distNm === 700 && er.altnKg === 0, "filed route length used when drawn; no alternate given");
  assert(!estimateFuel(FD, { type: "C172", gcNm: 100 }).ok, "unknown type");
  assert(!estimateFuel(FD, { type: "B738" }).ok, "no distance");
  const W3 = makeWatch(OPS, "AAL");
  const r3 = { callsign: "AAL100", dep: "KDFW", arr: "KATL", type: "B738" };
  const tx = composeTelex("fuelest", W3, r3, { fuel: { est: e, units: "LBS" } });
  assert(tx.startsWith("AAL OPS: FUEL EST KDFW-KATL B738 686NM. TRIP ") && tx.length <= TELEX_MAX, `fuel telex: ${tx}`);
  near(Number(tx.match(/TRIP ([\d.]+)/)[1]), (e.tripKg * KG_TO_LB) / 1000, 0.06, "telex in thousands of lbs");
  assert(/KGS X1000/.test(composeTelex("fuelest", W3, r3, { fuel: { est: e, units: "KGS" } })), "kg option");
  assert(/NO FUEL ESTIMATE/.test(composeTelex("fuelest", W3, r3, {})), "no estimate");
}

function opsPrefixOf(w) { return composeTelex("free", w, {}).trim(); }

/* ---------- airport watch (all airlines at one field) ---------- */
{
  assert(airportLabel("KDFW") === "DFW" && airportLabel("PANC") === "PANC" && airportLabel("EGLL") === "EGLL", "telex label");
  const AW = makeAirportWatch("kdfw", ["n123ab"]);
  assert(AW.kind === "airport" && AW.station === "DFWOPS" && opsPrefixOf(AW) === "DFW OPS:", "station and prefix");
  const fpD = { departure: "KDFW", arrival: "KATL" }, fpA = { departure: "KORD", arrival: "KDFW" }, fpX = { departure: "KORD", arrival: "KATL" };
  assert(matchFlight(AW, "UAL1", "", {}, fpA)?.via === "arr" && matchFlight(AW, "SWA2", "", {}, fpD)?.via === "dep", "any airline, both ways");
  assert(!matchFlight(AW, "UAL1", "", {}, fpX), "not this airport");
  assert(!matchFlight(AW, "UAL1", "", { dir: "dep" }, fpA) && matchFlight(AW, "SWA2", "", { dir: "dep" }, fpD), "departures only");
  assert(!matchFlight(AW, "SWA2", "", { dir: "arr" }, fpD) && matchFlight(AW, "UAL1", "", { dir: "arr" }, fpA), "arrivals only");
  assert(matchFlight(AW, "UAL1", "", { prevArr: "KDFW" }, { departure: "KORD", arrival: "KOKC" })?.via === "arr", "diverted away: still shown");
  assert(matchFlight(AW, "N123AB", "", {}, fpX)?.via === "watch", "watched callsign");
  // Through deriveFlights: mixed airlines and a diversion away from the field.
  const mem = new Map();
  const dfwA = A("KDFW"), ord = A("KORD");
  const mid = gcPoint(ord, dfwA, 0.5);
  const feed = { pilots: [
    { callsign: "UAL1", latitude: mid.lat, longitude: mid.lon, altitude: 36000, groundspeed: 450, heading: 200, transponder: "1200", flight_plan: { ...fpA, deptime: "1300", enroute_time: "0200" } },
    { callsign: "SWA2", latitude: dfwA.lat, longitude: dfwA.lon, altitude: 600, groundspeed: 0, heading: 0, transponder: "1200", flight_plan: fpD },
    { callsign: "DAL3", latitude: 40, longitude: -100, altitude: 36000, groundspeed: 450, heading: 90, transponder: "1200", flight_plan: fpX },
  ] };
  primeMemory(mem, { UAL1: { leg: "KORD-KDFW", out: T0 - 4e6, off: T0 - 3.8e6, arr: "KDFW" } }, T0);
  let rows = deriveFlights({ W: AW, A, idx }, feed, mem, T0);
  assert(rows.map(r => r.callsign).sort().join() === "SWA2,UAL1", "board: flights in and out of KDFW, any airline");
  rows = deriveFlights({ W: AW, A, idx, dir: "arr" }, feed, mem, T0 + 15000);
  assert(rows.map(r => r.callsign).join() === "UAL1", "arrivals toggle");
  feed.pilots[0].flight_plan = { ...feed.pilots[0].flight_plan, arrival: "KOKC" };
  rows = deriveFlights({ W: AW, A, idx }, feed, mem, T0 + 30000);
  const u = rows.find(r => r.callsign === "UAL1");
  assert(u && u.alerts.some(a => a.key === "div-KOKC"), "diverted away from KDFW: still on the board, with the alert");
  assert(composeTelex("free", AW, u) === "DFW OPS: ", "telex prefix DFW OPS");
}

/* ---------- VATUSA OIS TMIs ---------- */
{
  // Shapes as OIS serializes them (backend/src/models: PublicBoard, FlightAdvisory; snake_case, RFC 3339).
  const board = {
    ground_stops: [{ id: "g1", airport: "KATL", scope: "ZTL ZJX", until: "1900" }],
    gdps: [{ id: "d1", airport: "KDFW", aar: 40, scope: "", start_time: "1700", end_time: "2100", max_enroute_min: null,
      exempt_airborne: true, controlled: 12, avg_delay_min: 25, max_delay_min: 51, demand_60min: 55, over_capacity: true }],
    restrictions: [{ id: "r1", requesting: "ZFW", providing: "ZME", restriction: "DFW VIA BOOVE 20MIT", decoded: null, start_time: "2026-09-28T17:00:00Z", stop_time: null },
      { id: "r2", requesting: "ZNY", providing: "ZDC", restriction: "EWR 15MIT", decoded: null, start_time: "2026-09-28T17:00:00Z", stop_time: null }],
    programs: [{ icao: "KORD", aar: 60, trail: 0, mit: 0, gates: [], exclude_wake: [], exclude_types: [], jets_only: false, active_until: null, demand_60min: 71, over_capacity: true }],
    as_of: "2026-09-28T18:00:00Z",
  };
  const ix = tmiIndex(board);
  assert(ix.byAirport.get("KDFW").gdp.aar === 40 && ix.byAirport.get("KATL").groundStop.until === "1900" && ix.byAirport.get("KORD").program.aar === 60, "board indexed by airport");
  assert(ix.asOf === Date.parse("2026-09-28T18:00:00Z"), "as_of parsed");
  assert(tmiIndex({ ...board, as_of: "2026-09-28T20:00:08.470366082Z" }).asOf === Date.parse("2026-09-28T20:00:08.470Z"), "OIS nanosecond timestamps (as the live API sends them)");
  assert(restrictionsFor(ix, "KDFW").map(r => r.id).join() === "r1" && restrictionsFor(ix, "KEWR").map(r => r.id).join() === "r2", "NTML text matched by FAA id");
  assert(!restrictionsFor(ix, "KDF").length, "whole words only");
  const gate = { callsign: "AAL100", dep: "KMIA", arr: "KDFW", phase: "AT GATE", connected: true, std: 1790000000000, off: null, on: null };
  let al = tmiAlerts(ix, gate, null);
  assert(al.length === 1 && al[0].key === "tmi-gdp-d1" && al[0].level === "warn", "GDP at the destination, no EDCT known yet");
  const adv = { callsign: "AAL100", found: true, dep: "KMIA", arr: "KDFW", status: "ground",
    gdp: { airport: "KDFW", aar: 40, start_time: "1700", end_time: "2100", controlled: true, edct: "2026-09-28T18:45:00Z", cta: "2026-09-28T20:10:00Z", delay_min: 23 },
    ground_stop: null, rate_program: null,
    fcas: [{ fca_id: "f1", fca_name: "ZFW WEST", color: "#f59e0b", cross_time: "2026-09-28T19:40:00Z", delay_min: 9, edct: null, seq: 4 }],
    total_delay_min: 23, edct: "2026-09-28T18:45:00Z" };
  al = tmiAlerts(ix, gate, adv);
  assert(al.length === 1 && al[0].key === "tmi-edct-2026-09-28T18:45:00Z" && /EDCT 1845Z \(\+23 min\) · GDP KDFW/.test(al[0].text), `EDCT alert: ${al[0] && al[0].text}`);
  const moved = tmiAlerts(ix, gate, { ...adv, edct: "2026-09-28T18:55:00Z" });
  assert(moved[0].key !== al[0].key, "a changed EDCT is a new alert (not covered by an old acknowledgement)");
  assert(!tmiAlerts(ix, { ...gate, phase: "CRUISE", off: 1 }, adv).some(a => /edct|gdp/.test(a.key)), "no EDCT/GDP alert once airborne");
  const atl = { ...gate, callsign: "DAL5", arr: "KATL" };
  assert(tmiAlerts(ix, atl, null)[0].level === "bad" && /Ground stop KATL until 1900Z \(ZTL ZJX\)/.test(tmiAlerts(ix, atl, null)[0].text), "ground stop");
  assert(!tmiAlerts(ix, { ...atl, phase: "CRUISE", off: 1 }, null).length, "ground stop: airborne flights not flagged");
  assert(tmiAlerts(ix, { ...gate, arr: "KORD", phase: "CRUISE", off: 1 }, null)[0].key === "tmi-aar-KORD", "rate program over capacity, airborne too");
  assert(!tmiAlerts(ix, { ...gate, arr: "KLAX" }, null).length && !tmiAlerts(null, gate, null).length, "nothing for an unaffected airport or without a board");
  // Automatic lookups: ground flights bound for a TMI airport, soonest first, capped.
  const many = Array.from({ length: 12 }, (_, i) => ({ ...gate, callsign: "AAL" + (200 + i), std: 1790000000000 + (12 - i) * 60000 }));
  const tg = autoAdvisoryTargets(ix, [...many, { ...gate, callsign: "UAL1", arr: "KLAX" }, { ...gate, callsign: "UAL2", phase: "CRUISE", off: 1 }]);
  assert(tg.length === AUTO_ADVISORY_MAX && tg[0] === "AAL211" && !tg.includes("UAL1") && !tg.includes("UAL2"), "auto lookups capped, soonest first, only affected ground flights");
  // Telex.
  const P = "AAL OPS:";
  assert(composeTmiTelex(P, gate, adv, ix) === "AAL OPS: EDCT 1845Z (GDP KDFW +23 MIN). CTA 2010Z. PLAN PUSH ACCORDINGLY.", "EDCT telex");
  assert(composeTmiTelex(P, atl, null, ix) === "AAL OPS: GROUND STOP KATL UNTIL 1900Z. HOLD AT GATE, EXPECT UPDATE.", "ground stop telex");
  const rp = { ...adv, gdp: null, edct: null, rate_program: { airport: "KORD", aar: 60, delay_min: 12, sta: "2026-09-28T20:30:00Z", cfr: null } };
  assert(composeTmiTelex(P, { ...gate, arr: "KORD" }, rp, ix) === "AAL OPS: EXPECT ARRIVAL DELAY KORD ~12 MIN (AAR 60). STA 2030Z.", "rate program telex");
  assert(composeTmiTelex(P, { ...gate, arr: "KLAX" }, { found: true, fcas: [] }, ix) === "AAL OPS: NO TMI AFFECTING AAL100.", "no TMI");
  assert(composeTelex("tmi", makeWatch(OPS, "AAL"), gate, { tmiText: "AAL OPS: X" }) === "AAL OPS: X", "template passes the text through");
  // Demo board/advisory: same shapes, consistent with each other.
  const rows = [["KDFW", 5], ["KATL", 3], ["KORD", 2]].flatMap(([arr, n]) => Array.from({ length: n }, (_, i) => ({ ...gate, callsign: arr.slice(1) + i, arr })));
  const db = demoBoard(rows, 1790000000000);
  assert(db.gdps[0].airport === "KDFW" && db.ground_stops[0].airport === "KATL" && db.programs[0].icao === "KORD", "demo board picks the busiest destinations");
  const da = demoAdvisory(rows[0], db, 1790000000000);
  assert(da.found && da.edct && da.gdp.controlled && da.total_delay_min > 0, "demo advisory has an EDCT");
  assert(tmiAlerts(tmiIndex(db), rows[0], da)[0].key.startsWith("tmi-edct-"), "demo advisory drives an EDCT alert");
}

console.log(`test-aoc-core: ${passed} checks passed`);
