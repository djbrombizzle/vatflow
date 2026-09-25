#!/usr/bin/env node
/**
 * Regression: ramp management core (projection, states, queue, telex).
 * Usage: node scripts/test-ramp-core.mjs
 */
import { readFileSync } from "node:fs";
import {
  applyOp, composeStandTelex, deriveFlights, entrySpotFor, emptyState, indexLayout, locateOnChart,
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
assert(L.stands.length === 215, "215 stands (33 Amazon, 95 DHL, 87 terminal)");
assert(new Set(L.stands.map(s => s.id)).size === 215, "stand ids unique");
assert(new Set(L.callSpots.map(s => s.id)).size === L.callSpots.length, "call spot ids unique");
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

// Terminal chart georeference: RWY 18L/36R edge at x=1331 vs published -84.6468; 18C/36C at x=80 vs -84.6686.
{
  near(L.proj.PAX.toLatLon(1331, 500).lon, -84.6468, 0.0002, "PAX 36R lon");
  near(L.proj.PAX.toLatLon(80, 500).lon, -84.6686, 0.0002, "PAX 36C lon");
  const b15 = L.standById.get("B15");
  assert(locateOnChart(L, b15.lat, b15.lon).chart === "PAX", "B15 is on the terminal chart");
  assert(nearestStand(L, b15.lat, b15.lon).stand.id === "B15", "nearest stand to B15 is B15");
  near(L.standById.get("A6").noseHdg, 180, 1, "Concourse A north gates nose south (away from 1S)");
  near(L.standById.get("B15").noseHdg, 0, 1, "Concourse B south gates nose north (away from 3)");
  assert(L.standById.get("T-A10").label === "A10" && L.standById.get("A10").chart === "AZN", "A10 on both ramps, separate ids");
}

/* ---------- operators ---------- */
assert(operatorFor(L, "DHK123", "").group === "DHL", "DHK is DHL");
assert(operatorFor(L, "ATN3401", "OPR/AMAZON").group === "Amazon", "remarks win");
assert(operatorFor(L, "GTI8801", "").group === "?", "shared carrier is ambiguous");
assert(operatorFor(L, "DAL1234", "").group === "Terminal", "DAL parks at the terminal");

/* ---------- telex ---------- */
{
  const t = composeStandTelex(L, "C07");
  assert(t === "KCVG AMAZON RAMP: PARK STAND C07. ENTER AT SPOT 74 VIA TAXILANE C. CTC AMAZON RAMP 130.5 AT SPOT 74.", "C07 telex: " + t);
  const d = composeStandTelex(L, "21");
  assert(d === "KCVG DHL RAMP: PARK STAND 21. ENTER AT SPOT 56 VIA DHL 2. CTC DHL RAMP 129.475 AT SPOT 56.", "21 telex: " + d);
  assert(L.stands.every(s => composeStandTelex(L, s.id).length <= TELEX_MAX), "every stand telex fits the budget");
  const ta10 = composeStandTelex(L, "T-A10");
  const b15 = composeStandTelex(L, "B15");
  assert(b15 === "KCVG RAMP: PARK STAND B15. ENTER AT SPOT 5 VIA RAMP 3 TAXILANE. CTC RAMP 130.375 AT SPOT 5.", "Ramp 3 taxilane frequency: " + b15);
  assert(ta10 === "KCVG RAMP: PARK STAND A10. ENTER AT SPOT 2 VIA RAMP 1S TAXILANE. CTC RAMP 130.9 AT SPOT 2.", "terminal telex uses the chart name: " + ta10);
}
assert(parseDownlink("REQ PUSH") === "push", "REQ PUSH");
assert(parseDownlink("ready for pushback") === "push", "ready for pushback");
assert(parseDownlink("REQUEST STAND") === "stand", "REQUEST STAND");
assert(parseDownlink("REQ GATE PLS") === "stand", "REQ GATE");
assert(parseDownlink("HELLO") === "other", "other");
for (const t of ["PUSH", "push", "PUSH BACK", "PUSHBACK", "PUSH C4", "PUSH C4 BLUES", "PUSH PLS", "PUSH AND START",
  "READY TO PUSH", "REQUESTING PUSHBACK", "RDY PUSH", "UAL1128 REQ PUSH A6D BLUES"]) assert(parseDownlink(t) === "push", "push: " + t);
for (const t of ["CANCEL PUSH", "NO PUSH REQ", "UNABLE PUSH", "PUSHED BACK", "DISREGARD PUSH"]) assert(parseDownlink(t) === "other", "not push: " + t);

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
  // Stopped away from every known stand, never taxied: parked (with its push request), not taxiing.
  {
    const s2 = emptyState("KCVG");
    const m2 = new Map();
    applyOp(s2, { op: "push", callsign: "UAL9", push: "REQ" }, "TELEX", 1);
    const far = [{ callsign: "UAL9", latitude: 39.0470, longitude: -84.6600, groundspeed: 0, altitude: 896, flight_plan: { departure: "KCVG", arrival: "KSEA" } }];
    let r9 = deriveFlights(L, far, s2, m2, 0)[0];
    assert(r9.state === STATES.PUSH_REQ && r9.unknownStand && !r9.atStand, `parked off-stand keeps its push request (got ${r9.state})`);
    far[0].groundspeed = 15;
    deriveFlights(L, far, s2, m2, 0);
    far[0].groundspeed = 0;
    r9 = deriveFlights(L, far, s2, m2, 0)[0];
    assert(r9.state === STATES.TAXI_OUT, `a stop after taxiing is a hold, not parking (got ${r9.state})`);
  }
  const sug = suggestStand(L, rows, operatorFor(L, "DHK9", ""));
  assert(sug && sug.group === "DHL", "suggests a DHL stand");
  const pax = suggestStand(L, rows, operatorFor(L, "EDV1", ""));
  assert(pax && pax.group === "Terminal", "suggests a terminal stand");
  L.stands.filter(s => (s.tags || []).includes("closed")).forEach(s => assert(s.id !== pax.id, "never suggests a closed stand"));
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
    // Simulated push calls get the hub's automatic acknowledgement.
    const called = Object.entries(d.getState().flights).find(([, e]) => e.msgs.some(m => m.by === "AUTO"));
    assert(!called || called[1].msgs.find(m => m.by === "AUTO").text.includes("PUSH REQUEST RECEIVED, NUMBER"), "demo auto-ack text");
    const sent = await d.sendTelex("GTI1890", "kcvg amazon ramp: test");
    assert(sent.ok && d.getState().flights.GTI1890.msgs.some(m => m.dir === "dn" && m.text === "ROGER"), "demo pilot answers a telex");
    assert(d.getHoppie().GTI1890 === true && d.getHoppie().GTI408 === false, "demo Hoppie status");
    const off = await d.sendTelex("GTI408", "KCVG AMAZON RAMP: TEST");
    assert(!off.ok && off.offline, "telex to a callsign not on Hoppie is refused");
    // Only uplinks count: the simulator may have had GTI408 call for push by now.
    const ups = () => (d.getState().flights.GTI408?.msgs || []).filter(m => m.dir === "up").length;
    const downs = () => (d.getState().flights.GTI408?.msgs || []).filter(m => m.dir === "dn").length;
    assert(ups() === 0, "nothing sent when refused");
    const before = downs();
    const forced = await d.sendTelex("GTI408", "KCVG AMAZON RAMP: TEST", { force: true });
    assert(forced.ok && ups() === 1 && downs() === before, "send anyway logs it, and nobody answers");
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
  }
}
/* ---------- KIAD, and the airport index ---------- */
{
  const index = JSON.parse(readFileSync(new URL("../data/ramp/index.json", import.meta.url)));
  assert(index.airports.map(a => a.icao).join() === "KCVG,KIAD,KDCA", "index lists KCVG, KIAD and KDCA");
  for (const a of index.airports) {
    const A = indexLayout(JSON.parse(readFileSync(new URL(`../data/ramp/${a.icao}.json`, import.meta.url))));
    assert(A.icao === a.icao, `${a.icao} file matches the index`);
    assert(new Set(A.stands.map(s => s.id)).size === A.stands.length, `${a.icao} stand ids unique`);
    assert(A.stands.every(s => Number.isFinite(s.lat) && s.noseHdg != null), `${a.icao} stands have lat/lon and a push lane`);
    // Every stand whose push lane has reporting points / call spots gets one.
    assert(A.stands.every(s => entrySpotFor(A, s) || !((A.laneSpots || {})[s.chart] || {})[s.pushTo]), `${a.icao} every stand has an entry spot`);
    assert(A.stands.every(s => composeStandTelex(A, s.id).length <= TELEX_MAX), `${a.icao} telex budget`);
    assert((A.views || []).length && A.demo.fleet.every(f => !f.stand || A.standById.has(f.stand)) &&
      A.demo.fleet.every(f => !f.assigned || A.standById.has(f.assigned)), `${a.icao} views and demo fleet stands exist`);
  }
  const I = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KIAD.json", import.meta.url))));
  assert(I.stands.length === 163, "KIAD 163 stands");
  // RWY 1C/19C centreline drawn at x~85; published -77.45955.
  near(I.proj.IAD.toLatLon(85, 500).lon, -77.45955, 0.0002, "KIAD 1C lon");
  near(I.standById.get("B41").noseHdg, 180, 1, "A/B north gates nose south, away from taxilane B");
  near(I.standById.get("C4").noseHdg, 0, 1, "C/D south gates nose north, away from taxilane E");
  assert(entrySpotFor(I, I.standById.get("B79")).id === "72" && entrySpotFor(I, I.standById.get("A15")).id === "73", "nearer spot on the lane");
  const t = composeStandTelex(I, "C4");
  assert(t === "KIAD SOUTH AREA RAMP: PARK STAND C4. ENTER AT SPOT 83 VIA TAXILANE E. CTC SOUTH AREA RAMP 130.55 AT SPOT 83.", "KIAD telex: " + t);
  const n = composeStandTelex(I, "B41");
  assert(n.includes("NORTH AREA RAMP") && n.includes("119.12") && n.includes("SPOT 72"), "north ramp telex: " + n);
  assert(operatorFor(I, "UAL924", "").group === "Terminal", "UAL at the terminal");
  // A KIAD demo inbound lands, waits at a spot, and parks once it has a stand.
  const { createDemoStore } = await import("../shared/ramp-demo.js");
  let now = Date.parse("2026-09-24T19:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const d = createDemoStore(I);
    d.seed();
    const mem = new Map();
    const rowOf = cs => deriveFlights(I, d.getPilots(), d.getState(), mem, now).find(r => r.callsign === cs);
    rowOf("UAL2041");
    for (let i = 0; i < 200 && rowOf("UAL2041")?.state !== STATES.PARKED; i++) { now += 1000; d.tick(); }
    assert(rowOf("UAL2041").atStand === "C24", "KIAD demo inbound parks at C24");
    assert(d.me.callsign === "KIAD_RMP", "demo works as KIAD_RMP");
  } finally {
    Date.now = realNow;
  }
}
/* ---------- KDCA ---------- */
{
  const D = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KDCA.json", import.meta.url))));
  assert(D.stands.length === 66, "KDCA 66 stands");
  // Runway 15/33 centreline crosses the N38-51.5 grid line (y 69) at x~510 on the chart.
  near(D.proj.DCA.toXY(38 + 51.5 / 60, -77.0405).x, 510, 8, "KDCA 15/33 at 51.5'");
  assert(entrySpotFor(D, D.standById.get("D38")).id === "5" && entrySpotFor(D, D.standById.get("E55")).id === "9" && entrySpotFor(D, D.standById.get("E53")).id === "10", "nearest reporting point on the alley");
  const t = composeStandTelex(D, "C30");
  assert(t === "KDCA RAMP: PARK STAND C30. ENTER AT SPOT 1 VIA B/C ALLEY.", "KDCA telex has no CTC line without a frequency: " + t);
  assert(composeStandTelex(D, "A5") === "KDCA RAMP: PARK STAND A5. ENTER VIA TAXIWAY K.", "A gates: via K, no spot, no frequency: " + composeStandTelex(D, "A5"));
  assert(operatorFor(D, "AAL1846", "").group === "Terminal" && !operatorFor(D, "AAL1", "").ramps.includes("DCA-SH"), "airlines stay off the hangar ramp");
}
console.log(`test-ramp-core (with demo): ${passed} passed`);
