#!/usr/bin/env node
/**
 * Regression: ramp management core (projection, states, queue, telex).
 * Usage: node scripts/test-ramp-core.mjs
 */
import { readFileSync } from "node:fs";
import {
  applyOp, composeStandTelex, deriveFlights, emptyState, indexLayout, locateOnChart,
  nearestStand, operatorFor, parseDm, parseDownlink, queueOrder, queueView, standStatuses,
  suggestStand, STATES, PUSH, TELEX_MAX,
} from "../shared/ramp-core.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);
}

const L = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KCVG.json", import.meta.url))));

/* ---------- layout ---------- */
assert(L.stands.length === 128, "128 stands");
assert(new Set(L.stands.map(s => s.id)).size === 128, "stand ids unique");
assert(L.stands.every(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)), "every stand has lat/lon (chart grid fills DHL)");
near(parseDm("N39-02.2"), 39.036667, 1e-5, "parse lat");
near(parseDm("W084-39.5"), -84.658333, 1e-5, "parse lon");
// Amazon chart georeference: RWY 36C end drawn at ~(70,345) vs published 39.0345,-84.6687.
{
  const g = L.proj.AZN.toLatLon(70, 345);
  near(g.lat, 39.0345, 0.0012, "AZN 36C lat");
  near(g.lon, -84.6687, 0.0005, "AZN 36C lon");
  const back = L.proj.AZN.toXY(g.lat, g.lon);
  near(back.x, 70, 0.5, "round trip x");
  near(back.y, 345, 0.5, "round trip y");
}
{
  const a01 = L.standById.get("A01");
  const hit = nearestStand(L, a01.lat, a01.lon);
  assert(hit && hit.stand.id === "A01", "nearest stand to A01 is A01");
  assert(locateOnChart(L, a01.lat, a01.lon).chart === "AZN", "A01 is on the Amazon chart");
  const s21 = L.standById.get("21");
  assert(locateOnChart(L, s21.lat, s21.lon).chart === "DHL", "21 is on the DHL chart");
  near(a01.noseHdg, 90, 1, "A row noses east (away from taxilane A)");
  near(L.standById.get("C05").noseHdg, 270, 1, "C row noses west");
  assert(L.standById.get("55").ramp === "DHL-R" && L.spotById.get("55"), "stand 55 and spot 55 both exist, separately");
}

/* ---------- operators ---------- */
assert(operatorFor(L, "DHK123", "").group === "DHL", "DHK is DHL");
assert(operatorFor(L, "ATN3401", "OPR/AMAZON").group === "Amazon", "remarks win");
assert(operatorFor(L, "GTI8801", "").group === "?", "shared carrier is ambiguous");

/* ---------- telex ---------- */
{
  const t = composeStandTelex(L, "C07");
  assert(t === "KCVG AMAZON RAMP: PARK STAND C07. ENTER AT SPOT 74 VIA TAXILANE C. CTC AMAZON RAMP 130.5 AT SPOT 74.", "C07 telex: " + t);
  const d = composeStandTelex(L, "21");
  assert(d === "KCVG DHL RAMP: PARK STAND 21. ENTER AT SPOT 56 VIA DHL 2. CTC DHL RAMP 129.475 AT SPOT 56.", "21 telex: " + d);
  assert(L.stands.every(s => composeStandTelex(L, s.id).length <= TELEX_MAX), "every stand telex fits the budget");
}
assert(parseDownlink("REQ PUSH") === "push", "REQ PUSH");
assert(parseDownlink("ready for pushback") === "push", "ready for pushback");
assert(parseDownlink("REQUEST STAND") === "stand", "REQUEST STAND");
assert(parseDownlink("REQ GATE PLS") === "stand", "REQ GATE");
assert(parseDownlink("HELLO") === "other", "other");

/* ---------- reducer + queue ---------- */
{
  const s = emptyState("KCVG");
  assert(applyOp(s, { op: "assign", callsign: "gti1", stand: "c07" }, "T", 1).ok, "assign");
  assert(s.flights.GTI1.stand === "C07", "assign upcases");
  assert(!applyOp(s, { op: "assign", callsign: "ABX2", stand: "C07" }, "T", 2).ok, "no double assignment");
  applyOp(s, { op: "push", callsign: "A1", push: "REQ" }, "T", 100);
  applyOp(s, { op: "push", callsign: "B2", push: "REQ" }, "T", 200);
  applyOp(s, { op: "push", callsign: "C3", push: "REQ" }, "T", 300);
  assert(queueOrder(s).join() === "A1,B2,C3", "call order");
  applyOp(s, { op: "push", callsign: "A1", push: "HELD" }, "T", 400);
  assert(queueOrder(s).join() === "A1,B2,C3", "hold keeps its place");
  let v = queueView(s, 500);
  assert(v[0].status === "HELD" && v[1].status === "READY" && v[2].status === "WAIT", "next non-held is READY");
  applyOp(s, { op: "push", callsign: "A1", push: "REQ" }, "T", 450);
  assert(s.flights.A1.callTime === 100, "re-request keeps the original call time");
  applyOp(s, { op: "move", callsign: "C3", dir: -1 }, "T", 600);
  assert(queueOrder(s).join() === "A1,C3,B2", "manual move");
  assert(s.flights.C3.moved, "move is flagged");
  applyOp(s, { op: "resort" }, "T", 700);
  assert(queueOrder(s).join() === "A1,B2,C3", "resort restores call order");
  applyOp(s, { op: "settings", spacingSec: 60 }, "T", 800);
  applyOp(s, { op: "push", callsign: "A1", push: "APPROVED" }, "T", 1000);
  v = queueView(s, 31000);
  assert(v[1].status === "SPACING" && v[1].wait === 30, "spacing wait after an approval");
  applyOp(s, { op: "settings", holdAll: true }, "T", 32000);
  v = queueView(s, 200000);
  assert(v.slice(1).every(r => r.status === "HELD"), "hold all");
  assert(!applyOp(s, { op: "settings", spacingSec: 5000 }, "T", 1).ok, "spacing bound");
  assert(!applyOp(s, { op: "assign", callsign: "x y", stand: "C01" }, "T", 1).ok, "callsign validated");
  const rev = s.rev;
  applyOp(s, { op: "push", callsign: "A1", push: null }, "T", 1);
  assert(s.rev === rev + 1 && s.flights.A1.callTime === null, "clear push");
}

/* ---------- state derivation ---------- */
{
  const s = emptyState("KCVG");
  const mem = new Map();
  const c07 = L.standById.get("C07");
  const pilots = [
    { callsign: "ATN1", latitude: c07.lat, longitude: c07.lon, groundspeed: 0, altitude: 896, flight_plan: { departure: "KCVG", arrival: "KONT", aircraft_short: "B763" } },
    { callsign: "GTI2", latitude: 39.5, longitude: -85.2, groundspeed: 280, altitude: 9000, flight_plan: { departure: "KSDF", arrival: "KCVG", aircraft_short: "B744" } },
    { callsign: "DAL3", latitude: 40.6, longitude: -73.7, groundspeed: 0, altitude: 13, flight_plan: { departure: "KJFK", arrival: "KATL" } },
  ];
  applyOp(s, { op: "assign", callsign: "GTI2", stand: "A06" }, "T", 1);
  applyOp(s, { op: "push", callsign: "ATN1", push: "REQ" }, "T", 1);
  let rows = deriveFlights(L, pilots, s, mem, 0);
  const by = Object.fromEntries(rows.map(r => [r.callsign, r]));
  assert(!by.DAL3, "unrelated traffic ignored");
  assert(by.ATN1.state === STATES.PUSH_REQ && by.ATN1.atStand === "C07", "parked + push req");
  assert(by.GTI2.state === STATES.INBOUND && by.GTI2.etaMin > 0, "inbound with ETA");
  const st = standStatuses(L, rows);
  assert(st.get("C07").key === "pushreq" && st.get("A06").key === "assigned", "stand colours");
  // ATN1 pushes: slow, 30 m from the stand.
  pilots[0].latitude += 0.00027;
  pilots[0].groundspeed = 4;
  rows = deriveFlights(L, pilots, s, mem, 0);
  assert(rows.find(r => r.callsign === "ATN1").state === STATES.PUSHING, "pushing");
  pilots[0].latitude += 0.003;
  pilots[0].groundspeed = 15;
  rows = deriveFlights(L, pilots, s, mem, 0);
  assert(rows.find(r => r.callsign === "ATN1").state === STATES.TAXI_OUT, "taxi out");
  const sug = suggestStand(L, rows, operatorFor(L, "DHK9", ""));
  assert(sug && sug.group === "DHL", "suggests a DHL stand");
}

console.log(`test-ramp-core: ${passed} passed`);

/* ---------- demo simulator ---------- */
{
  const { createDemoStore } = await import("../shared/ramp-demo.js");
  let now = Date.parse("2026-09-24T19:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => { fn(); return 0; };
  try {
    const d = createDemoStore(L);
    d.seed();
    const mem = new Map();
    const step = n => { for (let i = 0; i < n; i++) { now += 1000; d.tick(); } };
    const rowOf = cs => deriveFlights(L, d.getPilots(), d.getState(), mem, now).find(r => r.callsign === cs);
    rowOf("DAE201");
    assert(rowOf("DAE201").state === STATES.INBOUND, "demo inbound");
    step(15);
    assert(rowOf("DAE201").state === STATES.TAXI_IN, "demo inbound landed and is taxiing in");
    step(40);
    const dae = rowOf("DAE201");
    assert(dae.state === STATES.PARKED && dae.atStand === "14", `demo inbound parks on its stand (got ${dae.state} ${dae.atStand})`);
    assert((await d.op({ op: "push", callsign: "ATN3401", push: PUSH.APPROVED })).ok, "approve");
    step(8);
    assert(rowOf("ATN3401").state === STATES.PUSHING, "demo push starts");
    let gone = false;
    for (let i = 0; i < 200 && !gone; i++) { step(1); gone = !rowOf("ATN3401"); }
    assert(gone && !d.getState().flights.ATN3401, "demo departure taxis to the spot and leaves the board");
    const sent = await d.sendTelex("GTI1890", "kcvg amazon ramp: test");
    assert(sent.ok && d.getState().flights.GTI1890.msgs.some(m => m.dir === "dn" && m.text === "ROGER"), "demo pilot answers a telex");
    assert(d.getHoppie().GTI1890 === true && d.getHoppie().GTI408 === false, "demo Hoppie status");
    const off = await d.sendTelex("GTI408", "KCVG AMAZON RAMP: TEST");
    assert(!off.ok && off.offline, "telex to a callsign not on Hoppie is refused");
    assert(!(d.getState().flights.GTI408?.msgs || []).length, "nothing logged when refused");
    const forced = await d.sendTelex("GTI408", "KCVG AMAZON RAMP: TEST", { force: true });
    assert(forced.ok && d.getState().flights.GTI408.msgs.length === 1, "send anyway logs it, and nobody answers");
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
  }
}
console.log(`test-ramp-core (with demo): ${passed} passed`);
