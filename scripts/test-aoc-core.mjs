#!/usr/bin/env node
/**
 * Regression: Dispatch Center core (operator matching, phases, OOOI, alerts, telex).
 * Usage: node scripts/test-aoc-core.mjs
 */
import { readFileSync } from "node:fs";
import {
  PHASE, TELEX_MAX, TEMPLATES, airportIndex, allMessages, applyOp, classifyDownlink, composeTelex, deriveFlights,
  distNm, emptyState, gcPoint, hhmmToMin, isHolding, loadMemory, makeWatch, matchFlight, movePoint, nearestAirport,
  parseFiledAlt, pendingReply, primeMemory, saveMemory, stdMs, ARRIVED_DWELL_MS, LOST_MS, KEEP_ARRIVED_MS,
} from "../shared/aoc-core.js";

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
  rows = step({ groundspeed: 280, altitude: 9000, latitude: dfw.lat + 0.2 });
  assert(rows[0].phase === PHASE.CLIMB, "climbing");
  rows = step({ groundspeed: 280, altitude: 9000, latitude: dfw.lat + 0.2 }, 6000);
  assert(rows[0].phase === PHASE.CLIMB, "same snapshot re-derived between feeds: still climbing");
  // Cruise.
  const mid = gcPoint(dfw, atl, 0.5);
  rows = step({ groundspeed: 460, altitude: 36000, latitude: mid.lat, longitude: mid.lon }, 20 * 60000);
  rows = step({ groundspeed: 460, altitude: 36000, latitude: mid.lat, longitude: mid.lon + 0.1 });
  rows = step({ groundspeed: 460, altitude: 36010, latitude: mid.lat, longitude: mid.lon + 0.2 });
  assert(rows[0].phase === PHASE.CRUISE, "cruise when level");
  assert(rows[0].eta > t && rows[0].distToGo > 250 && rows[0].distToGo < 400, "ETA from distance and speed");
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
  // Squawk 7700; connected at the destination; fuel.
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
  assert(rows[0].alerts.some(a => a.key === "fuel"), "low fuel: 4 h endurance, 4 h flown, 40 min to go");
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

console.log(`test-aoc-core: ${passed} checks passed`);
