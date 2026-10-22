#!/usr/bin/env node
/**
 * Regression: ramp management core (projection, states, queue, telex).
 * Usage: node scripts/test-ramp-core.mjs
 */
import { readFileSync } from "node:fs";
import {
  airlineFor, applyOp, composeStandTelex, deriveFlights, entrySpotFor, standConflicts, emptyState, indexLayout, locateOnChart,
  nearestStand, operatorFor, parseDm, parseDownlink, queueOrder, queueView, standStatuses,
  suggestStand, STATES, PUSH, TELEX_MAX, exitSpotFor, autoAssignStands, airlineStands, standForGate, ptimeMs, ptimeCountdown, standLabel,
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
  assert(t === "KCVG AMAZON RAMP: PARK STAND C07. ENTER AT SPOT 74. CTC AMAZON RAMP 130.5 AT SPOT 74 FOR TAXI.", "C07 telex: " + t);
  const d = composeStandTelex(L, "21");
  assert(d === "KCVG DHL RAMP: PARK STAND 21. ENTER AT SPOT 56. CTC DHL RAMP 129.475 AT SPOT 56 FOR TAXI.", "21 telex: " + d);
  assert(L.stands.every(s => composeStandTelex(L, s.id).length <= TELEX_MAX), "every stand telex fits the budget");
  const ta10 = composeStandTelex(L, "T-A10");
  const b15 = composeStandTelex(L, "B15");
  assert(b15 === "KCVG RAMP: PARK STAND B15. ENTER AT SPOT 5. CTC RAMP 130.375 AT SPOT 5 FOR TAXI.", "Ramp 3 taxilane frequency: " + b15);
  assert(ta10 === "KCVG RAMP: PARK STAND A10. ENTER AT SPOT 2. CTC RAMP 130.9 AT SPOT 2 FOR TAXI.", "terminal telex uses the chart name: " + ta10);
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

/* ---------- KFLL ---------- */
{
  const F = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KFLL.json", import.meta.url))));
  const count = r => F.stands.filter(s => s.ramp === r).length;
  assert(F.stands.length === 98 && count("FLL-G") === 14 && count("FLL-Z") === 13 && count("FLL-R") === 9 && count("FLL-BR") === 2,
    "KFLL 98 stands: Concourses A-G, Golf RON and the Remote RON areas");
  assert(F.stands.every(s => !s.approx && s.noseHdg != null), "every KFLL stand has real coordinates and a heading");
  assert(composeStandTelex(F, "A4") === "KFLL NORTH RAMP: PARK STAND A4. ENTER AT SPOT 0. CTC NORTH RAMP 118.175 AT SPOT 0 FOR TAXI.", "KFLL A4 telex: " + composeStandTelex(F, "A4"));
  // 10-9B North/South boundary at the tip of Concourse E: odd E gates north, even south.
  assert(composeStandTelex(F, "E9").includes("CTC NORTH RAMP 118.175") && composeStandTelex(F, "E10").includes("CTC SOUTH RAMP 129.875"), "KFLL E north/south split");
  assert(composeStandTelex(F, "D6A").includes("NORTH RAMP") && composeStandTelex(F, "G9").includes("CTC SOUTH RAMP 129.875 AT SPOT 11"), "KFLL D north, G south");
  assert(!/ CTC /.test(composeStandTelex(F, "Z3")), "KFLL Zulu RON has no frequency");
  assert(["D6A", "C6A", "R1A", "BR1"].every(id => F.standById.has(id)) && !["E8A", "E9A", "C8A", "D7A"].some(id => F.standById.has(id)), "KFLL chart gate list");
  const want = { SWA1: "FLL-C", DAL1: "FLL-D", JBU1: "FLL-EN", NKS1: "FLL-G", ACA1: "FLL-A" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(F, [], operatorFor(F, cs, ""), cs).ramp === ramp, `KFLL ${cs} on ${ramp}`);
}
/* ---------- KIND (FedEx hub) ---------- */
{
  const I = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KIND.json", import.meta.url))));
  const count = r => I.stands.filter(s => s.ramp === r).length;
  assert(I.stands.length === 82 && count("FDX-E") === 12 && count("FDX-P") === 8 && count("FDX-C") === 19 && count("FDX-W") === 26 && count("FDX-S") === 17,
    "KIND 82 FedEx stands from the two diagrams");
  assert(I.stands.every(s => !s.approx && s.noseHdg != null), "every KIND stand has coordinates and a heading");
  assert(["1", "2", "3", "4", "5", "6", "7", "7E", "7W", "8"].every(id => I.spotById.has(id)), "KIND spots 1-8, 7E, 7W");
  // Even rows nose southeast (to the sort building), odd rows northwest, as drawn.
  near(I.standById.get("40").noseHdg, 134, 4, "KIND 40 noses SE");
  near(I.standById.get("41").noseHdg, 316, 4, "KIND 41 noses NW");
  assert(composeStandTelex(I, "12") === "KIND FEDEX RAMP: PARK STAND 12. ENTER AT SPOT 2.", "KIND 12 telex: " + composeStandTelex(I, "12"));
  // In-only spots for arrivals, out-only spots for departures.
  const io = id => { const s = I.standById.get(id); return entrySpotFor(I, s).id + "/" + exitSpotFor(I, s).id; };
  assert(io("12") === "2/3" && io("44") === "4/5" && io("85") === "1/1" && io("65") === "6/7E" && io("110") === "8/7W", `KIND in/out spots (${["12", "44", "85", "65", "110"].map(io)})`);
  assert(suggestStand(I, [], operatorFor(I, "FDX123", ""), "FDX123").group === "FedEx", "KIND suggests a FedEx stand for FDX");
}
/* ---------- KATL (Concourses T, A-F) ---------- */
{
  const A = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KATL.json", import.meta.url))));
  assert(A.stands.length === 197 && A.stands.every(s => !s.approx && s.noseHdg != null), "KATL 197 stands with coordinates and headings");
  // One ramp frequency per alley between concourses, from the 10-9B.
  const freq = id => composeStandTelex(A, id).match(/CTC RAMP (\d) ([\d.]+)/).slice(1).join(" ");
  const want = { T5: "1 131.45", A12: "1 131.45", A11: "2 131.85", B12: "2 131.85", B11: "3 129.275", C12: "3 129.275",
    C13: "4 130.075", D12: "4 130.075", D9: "5 129.375", E12: "5 129.375", E15: "6 131.375", F12A: "8 128.975", F9: "9 131.875" };
  for (const [id, f] of Object.entries(want)) assert(freq(id) === f, `KATL ${id} on Ramp ${f} (${freq(id)})`);
  // 10-9B numbering where OSM differs, and the A lines that share a stand.
  assert(["B30", "D40A", "D17", "E37", "F12A"].every(id => A.standById.has(id)) && !["B22", "D24", "D13", "T13A"].some(id => A.standById.has(id)), "KATL chart gate list");
  assert(["T1A", "T2A", "E3A", "E27A", "E33A", "F3A"].every(g => standForGate(A, g)?.id === g.slice(0, -1)), "KATL A gates share their base stand");
  assert(entrySpotFor(A, A.standById.get("A2")).id === "1S" && entrySpotFor(A, A.standById.get("C55")).id === "4N", "KATL nearest ramp entry point");
  const al = { DAL1: "ATL-A", SWA1: "ATL-C", FFT1: "ATL-D", KLM1: "ATL-E" };
  for (const [cs, r] of Object.entries(al)) assert(suggestStand(A, [], operatorFor(A, cs, ""), cs).ramp.startsWith(r), `KATL ${cs} on ${r}`);
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
    // Only controller uplinks count: the simulator may have had GTI408 call for push by now,
    // and the automatic push acknowledgement (by AUTO) is an uplink too.
    const ups = () => (d.getState().flights.GTI408?.msgs || []).filter(m => m.dir === "up" && m.by !== "AUTO").length;
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
  assert(index.airports.map(a => a.icao).join() === "KCVG,KIAD,KDCA,KRDU,KMCO,KIAH,KAUS,KDFW,KMIA,KFLL,KIND,KATL", "index lists KCVG, KIAD, KDCA, KRDU, KMCO, KIAH, KAUS, KDFW, KMIA, KFLL, KIND and KATL");
  for (const a of index.airports) {
    const A = indexLayout(JSON.parse(readFileSync(new URL(`../data/ramp/${a.icao}.json`, import.meta.url))));
    assert(A.icao === a.icao, `${a.icao} file matches the index`);
    assert(new Set(A.stands.map(s => s.id)).size === A.stands.length, `${a.icao} stand ids unique`);
    assert(A.stands.every(s => Number.isFinite(s.lat) && s.noseHdg != null), `${a.icao} stands have lat/lon and a push lane`);
    // Every stand whose push lane has reporting points / call spots gets one.
    assert(A.stands.every(s => entrySpotFor(A, s) || !((A.laneSpots || {})[s.chart] || {})[s.pushTo] && !(A.rampSpots || {})[s.ramp]), `${a.icao} every stand has an entry spot`);
    assert(A.stands.every(s => composeStandTelex(A, s.id).length <= TELEX_MAX), `${a.icao} telex budget`);
    assert((A.airlines || []).every(x => x.ramps.every(id => A.rampById.has(id))), `${a.icao} airline ramps exist`);
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
  assert(t === "KIAD SOUTH AREA RAMP: PARK STAND C4. ENTER AT SPOT 83. CTC SOUTH AREA RAMP 130.55 AT SPOT 83 FOR TAXI.", "KIAD telex: " + t);
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
  assert(t === "KDCA RAMP: PARK STAND C30. ENTER AT SPOT 1.", "KDCA telex has no CTC line without a frequency: " + t);
  assert(composeStandTelex(D, "A5") === "KDCA RAMP: PARK STAND A5. ENTER VIA TAXIWAY K.", "A gates: via K, no spot, no frequency: " + composeStandTelex(D, "A5"));
  assert(operatorFor(D, "AAL1846", "").group === "Terminal" && !operatorFor(D, "AAL1", "").ramps.includes("DCA-SH"), "airlines stay off the hangar ramp");

  // Suggest by airline: at DCA each airline gets its own concourse, not the first free gate up north.
  {
    const want = { AAL100: "DCA-D", ENY4000: "DCA-E", JBU955: "DCA-C", DAL110: "DCA-B", UAL1: "DCA-B", ASA2: "DCA-B", SWA256: "DCA-A", ACA7: "DCA-A" };
    for (const [cs, ramp] of Object.entries(want)) {
      const st = suggestStand(D, [], operatorFor(D, cs, ""), cs);
      assert(st && st.ramp === ramp, `${cs} suggested on ${ramp} (got ${st && st.ramp})`);
    }
    assert(airlineFor(D, "AAL2769").name === "American", "airline name");
    // Full concourse: American spills from D to C.
    const dRows = D.stands.filter(s => s.ramp === "DCA-D").map((s, i) => ({ callsign: "X" + i, atStand: s.id, stand: s.id }));
    assert(suggestStand(D, dRows, operatorFor(D, "AAL1", ""), "AAL1").ramp === "DCA-C", "American spills over to C");
    // A controller working only B: an American flight still gets a B gate rather than nothing.
    assert(suggestStand(D, [], operatorFor(D, "AAL1", ""), "AAL1", new Set(["DCA-B"])).ramp === "DCA-B", "inside the selected ramps");
  }
  // A pilot spawns on an inbound's assigned gate: flagged until someone moves the inbound.
  {
    const rowsC = [
      { callsign: "JBU955", state: STATES.INBOUND, stand: "C27", atStand: null },
      { callsign: "N123AB", state: STATES.PARKED, stand: "C27", atStand: "C27" },
      { callsign: "AAL1", state: STATES.TAXI_IN, stand: "D38", atStand: null },
      { callsign: "DAL1", state: STATES.PARKED, stand: "B17", atStand: "B17" },
    ];
    const cf = standConflicts(rowsC);
    assert(cf.size === 1 && cf.get("C27").occupant === "N123AB" && cf.get("C27").inbound === "JBU955", "conflict on C27");
  }

  // DAL110 at KDCA: parked at B17, pushes into the B/C alley and stops at spot 2. The alley is
  // within 60 m of the B19 stand point, but a pushed-back aircraft lined up along the alley is
  // not parked at B19: it stays PUSHING until it taxis.
  {
    const s3 = emptyState("KDCA");
    const m3 = new Map();
    applyOp(s3, { op: "push", callsign: "DAL110", push: "APPROVED" }, "T", 1);
    const b17 = D.standById.get("B17");
    const at = (x, y) => D.proj.DCA.toLatLon(x, y);
    const pl = { callsign: "DAL110", latitude: b17.lat, longitude: b17.lon, groundspeed: 0, altitude: 15, heading: b17.noseHdg,
      flight_plan: { departure: "KDCA", arrival: "KBOS", aircraft_short: "A320" } };
    let t = 0;
    const step = (x, y, gs, hdg, dt = 5000) => {
      const g = at(x, y);
      Object.assign(pl, { latitude: g.lat, longitude: g.lon, groundspeed: gs, heading: hdg });
      t += dt;
      return deriveFlights(D, [pl], s3, m3, t)[0];
    };
    let r = deriveFlights(D, [pl], s3, m3, t)[0];
    assert(r.atStand === "B17" && r.state === STATES.PUSH_APPR, `DAL110 starts parked at B17 (got ${r.atStand} ${r.state})`);
    r = step(b17.x, b17.y - 20, 3, b17.noseHdg);
    assert(r.state === STATES.PUSHING, `pushing (got ${r.state})`);
    r = step(455, 470, 0, 68);
    assert(!r.atStand && r.state === STATES.PUSHING, `stopped in the alley: pushing, not parked at ${r.atStand} (got ${r.state})`);
    r = step(455, 470, 0, 68, 600000);
    assert(!r.atStand, "still not parked after ten minutes in the alley");
    r = step(530, 452, 15, 68);
    assert(r.state === STATES.TAXI_OUT, `then taxis out (got ${r.state})`);
  }
  // An arrival that taxis in and stops nose-in at its gate is parked straight away; one that
  // stops beside a gate pointing the wrong way is still taxiing until it has sat there 3 minutes.
  {
    const s4 = emptyState("KDCA");
    const m4 = new Map();
    const b21 = D.standById.get("B21");
    const pl = { callsign: "AAL9", latitude: 38.9, longitude: -77.0, groundspeed: 250, altitude: 5000, heading: 0,
      flight_plan: { departure: "KBOS", arrival: "KDCA" } };
    deriveFlights(D, [pl], s4, m4, 0);
    Object.assign(pl, { latitude: b21.lat, longitude: b21.lon, altitude: 15, groundspeed: 12, heading: 90 });
    deriveFlights(D, [pl], s4, m4, 1000);
    Object.assign(pl, { groundspeed: 0, heading: b21.noseHdg });
    let r = deriveFlights(D, [pl], s4, m4, 2000)[0];
    assert(r.atStand === "B21" && r.state === STATES.PARKED, `arrival nose-in at B21 is parked (got ${r.atStand} ${r.state})`);
    const m5 = new Map();
    Object.assign(pl, { latitude: 38.9, longitude: -77.0, groundspeed: 250, altitude: 5000 });
    deriveFlights(D, [pl], s4, m5, 0);
    Object.assign(pl, { latitude: b21.lat, longitude: b21.lon, altitude: 15, groundspeed: 12, heading: 70 });
    deriveFlights(D, [pl], s4, m5, 1000);
    pl.groundspeed = 0;
    r = deriveFlights(D, [pl], s4, m5, 2000)[0];
    assert(r.state === STATES.TAXI_IN && !r.atStand, `stopped beside the gate, wrong heading: still taxiing in (got ${r.state})`);
    r = deriveFlights(D, [pl], s4, m5, 2000 + 181000)[0];
    assert(r.atStand === "B21", "after 3 minutes there it counts as parked");
  }
}
/* ---------- KRDU ---------- */
{
  const R = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KRDU.json", import.meta.url))));
  assert(R.stands.length === 45, "KRDU 45 stands (C 19, D 17, A 9)");
  // Longitude comes from the runways, not the chart's misprinted labels. 5L/23R fixed the scale; 5R/23L is the
  // independent check: its centreline crosses the chart's bottom edge (y 1099) at x ~1311.
  const g = R.proj.RDU.toLatLon(1311, 1099);
  const t = (g.lat - 35.8646) / (35.8792 - 35.8646);
  near(g.lon, -78.7973 + t * (-78.7794 + 78.7973), 0.0002, "KRDU 5R/23L lines up");
  assert(composeStandTelex(R, "C9") === "KRDU RAMP TOWER: PARK STAND C9. ENTER AT SPOT 6. CTC RAMP TOWER 130.175 AT SPOT 6 FOR TAXI.", "KRDU T2 telex: " + composeStandTelex(R, "C9"));
  assert(composeStandTelex(R, "A5") === "KRDU GROUND: PARK STAND A5. ENTER VIA TAXIWAY A. CTC GROUND 121.9.", "KRDU T1 telex: " + composeStandTelex(R, "A5"));
  const want = { DAL1: "RDU-C", AAL1: "RDU-D", UAL1: "RDU-D", SWA1: "RDU-A", NKS1: "RDU-A" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(R, [], operatorFor(R, cs, ""), cs).ramp === ramp, `KRDU ${cs} on ${ramp}`);
  assert(operatorFor(R, "DAL1402", "").group === "Terminal", "an airline match sets the operator group (no 'operator ?')");
  assert(operatorFor(R, "N123AB", "").group === "?", "unknown callsigns stay '?'");
}
const C2 = () => indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KCVG.json", import.meta.url))));
/* ---------- auto gates and proposed departure times ---------- */
{
  const D = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KDCA.json", import.meta.url))));
  const st = emptyState("KDCA");
  const inb = (cs, dist) => ({ callsign: cs, latitude: D.field.lat + dist / 60, longitude: D.field.lon, altitude: 8000, groundspeed: 240,
    heading: 180, flight_plan: { departure: "KATL", arrival: "KDCA", aircraft_short: "A320" } });
  const parkedAt = (cs, id) => {
    const s = D.standById.get(id);
    return { callsign: cs, latitude: s.lat, longitude: s.lon, altitude: 15, groundspeed: 0, heading: s.noseHdg || 0,
      flight_plan: { departure: "KDCA", arrival: "KATL", aircraft_short: "A320", deptime: "1430" } };
  };
  const memo = new Map();
  const mem = new Map();
  const now = Date.UTC(2026, 8, 26, 14, 20);
  const derive = (pl, t = now) => autoAssignStands(D, deriveFlights(D, pl, st, mem, t), memo);
  let rs = derive([inb("DAL100", 20), inb("N123AB", 10), inb("DAL200", 40)]);
  const by = cs => rs.find(r => r.callsign === cs);
  const dalGates = airlineStands(D, by("DAL100"));
  assert(dalGates && dalGates.every(id => ["DCA-B", "DCA-B10"].includes(D.standById.get(id).ramp)), "Delta proposals come from the B gates");
  assert(by("DAL100").autoStand && by("DAL100").stand === dalGates[0], `nearest Delta arrival gets the first B gate (got ${by("DAL100").stand})`);
  assert(by("DAL200").stand === dalGates[1], "the next Delta arrival gets the next one");
  assert(!by("N123AB").stand && !by("N123AB").autoStand && !by("N123AB").noGate, "general aviation gets no proposal");
  const first = by("DAL100").stand;
  rs = derive([inb("DAL100", 18), inb("N123AB", 10), inb("DAL200", 38)]);
  assert(by("DAL100").stand === first, "a proposal sticks between renders");
  // Someone spawns on the proposed gate: the proposal moves, to another Delta gate.
  rs = derive([inb("DAL100", 16), inb("DAL200", 36), parkedAt("DAL999", first)]);
  assert(by("DAL100").stand !== first && dalGates.includes(by("DAL100").stand), `spawn on ${first}: proposal moves to another Delta gate (got ${by("DAL100").stand})`);
  assert(by("DAL200").stand === dalGates[1], "the other proposal holds");
  assert(standConflicts(rs).size === 0, "a proposal never shows as a conflict");
  // A board assignment wins and takes that gate out of the pool.
  applyOp(st, { op: "assign", callsign: "DAL200", stand: "B20" }, "T", now);
  rs = derive([inb("DAL100", 16), inb("DAL200", 36), parkedAt("DAL999", first)]);
  assert(by("DAL200").stand === "B20" && !by("DAL200").autoStand, "an assigned stand is not replaced");
  // Every Delta gate taken: flag it.
  const fill = dalGates.filter(id => id !== "B20").map((id, i) => parkedAt("DAL" + (500 + i), id));
  rs = derive([inb("DAL100", 16), inb("DAL200", 36), ...fill]);
  assert(by("DAL100").noGate && !by("DAL100").stand, "no free Delta gate: noGate, and no gate from another airline");
  assert(standStatuses(D, derive([inb("DAL300", 30)])).get(memo.get("DAL300"))?.key === "proposed", "proposed gates colour as proposed");
  // Real-world gates (FlightStats via the hub) come first when the stand exists and is free.
  {
    const m2 = new Map(), st2 = emptyState("KDCA"), mem2 = new Map();
    const real = { AAL2648: { gate: "D39", source: "arrival", flight: "AA2648" }, DAL7: { gate: "Z99", source: "arrival", flight: "DL7" } };
    const der = (pl) => autoAssignStands(D, deriveFlights(D, pl, st2, mem2, now), m2, real);
    let r2 = der([inb("AAL2648", 20), inb("DAL7", 25)]);
    const b2 = cs => r2.find(r => r.callsign === cs);
    assert(b2("AAL2648").stand === "D39" && b2("AAL2648").autoStand && b2("AAL2648").realGate?.flight === "AA2648", `AAL2648 gets real gate D39 (got ${b2("AAL2648").stand})`);
    assert(b2("DAL7").stand && !b2("DAL7").realGate, "a real gate not on the layout falls back to the airline gates");
    r2 = der([inb("AAL2648", 20), parkedAt("AAL999", "D39")]);
    assert(b2("AAL2648").stand !== "D39" && b2("AAL2648").realGate?.taken, "real gate occupied: airline proposal, flagged taken");
    r2 = der([parkedAt("AAL2648", "D43")]);
    assert(b2("AAL2648").atStand === "D43" && b2("AAL2648").realGate?.stand === "D39" && !b2("AAL2648").autoStand, "parked elsewhere: real gate shown, not proposed");
    assert(standForGate(D, "Gate D-39")?.id === "D39" && standForGate(D, "d39")?.id === "D39" && !standForGate(D, "D3"), "gate names match loosely");
    assert(standForGate(C2(), "A1")?.id === "A01", "A1 matches CVG A01");
  }
  // Cargo at CVG by operator: DHL by callsign, Amazon by remarks, shared carriers left alone.
  const C = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KCVG.json", import.meta.url))));
  const op = (cs, rmk) => ({ callsign: cs, op: operatorFor(C, cs, rmk) });
  assert(C.standById.get(airlineStands(C, op("DHK12", ""))[0]).group === "DHL", "CVG DHL by callsign");
  assert(C.standById.get(airlineStands(C, op("ATN3350", "OPR/AMAZON"))[0]).ramp === "AZN", "CVG Amazon by remarks");
  assert(airlineStands(C, op("ATN3350", "")) === null, "CVG ATN with no remarks: no proposal");
  assert(airlineStands(C, op("DAL12", "")).every(id => C.standById.get(id).ramp === "PAX-B"), "CVG Delta on B");
  assert(airlineStands(C, op("AAL12", "")).every(id => C.standById.get(id).ramp === "PAX-A"), "CVG American on A");
  // IAD: United Express on the A gates and regional pads, others on B.
  const I = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KIAD.json", import.meta.url))));
  const lab = (cs) => airlineStands(I, { callsign: cs, op: operatorFor(I, cs, "") }).map(id => standLabel(I, id));
  assert(lab("GJS4402").every(l => /^(A|[1-6])/.test(l)), "IAD United Express on A gates: " + lab("GJS4402").join(" "));
  assert(standLabel(I, "1B") === "A1B" && composeStandTelex(I, "1B").includes("PARK STAND A1B"), "IAD regional pads are named A1B etc: " + composeStandTelex(I, "1B"));
  assert(lab("SWA12").every(l => l.startsWith("B")), "IAD Southwest on B");
  assert(lab("UAL12").every(l => /^[CDE]/.test(l)), "IAD United on C/D/E");
  assert(standLabel(I, suggestStand(I, [], operatorFor(I, "SWA12", ""), "SWA12").id).startsWith("B"), "IAD Suggest honours gates");
  // Proposed departure time.
  const t0 = Date.UTC(2026, 8, 26, 14, 20, 30);
  assert(ptimeMs("1430", t0) === Date.UTC(2026, 8, 26, 14, 30), "P-time today");
  assert(ptimeMs("0010", Date.UTC(2026, 8, 26, 23, 50)) === Date.UTC(2026, 8, 27, 0, 10), "P-time past midnight is tomorrow");
  assert(ptimeMs("2350", Date.UTC(2026, 8, 27, 0, 10)) === Date.UTC(2026, 8, 26, 23, 50), "P-time just before midnight is yesterday");
  assert(ptimeMs("0000", t0) === null && ptimeMs("", t0) === null && ptimeMs("2575", t0) === null, "blank or bad P-time is none");
  const p = ptimeMs("1430", t0);
  assert(ptimeCountdown(p, t0) === "9", "9 min to go");
  assert(ptimeCountdown(p, p) === "0", "0 at the time");
  assert(ptimeCountdown(p, p + 1000) === "+1" && ptimeCountdown(p, p + 181000) === "+4", "counts up once past");
  const dep = deriveFlights(D, [parkedAt("AAL1", "C29")], emptyState("KDCA"), new Map(), t0)[0];
  assert(dep.ptime === p, "a departure row carries its filed P-time");
  assert(deriveFlights(D, [inb("AAL2", 10)], emptyState("KDCA"), new Map(), t0)[0].ptime === null, "an arrival has no P-time");
}
{
  // Demo: departures file times, and a spawn on a proposed gate moves it.
  const D = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KDCA.json", import.meta.url))));
  const { createDemoStore } = await import("../shared/ramp-demo.js");
  const store = createDemoStore(D);
  store.seed();
  const memo = new Map();
  let rs = autoAssignStands(D, deriveFlights(D, store.getPilots(), store.getState(), new Map(), Date.now()), memo);
  assert(rs.filter(r => r.dep === "KDCA").every(r => r.ptime != null), "demo departures all file a P-time");
  const r = rs.find(x => x.autoStand);
  assert(r, "demo has an arrival with a proposed gate");
  const was = r.stand;
  assert(store.spawnDeparture(was, "XXX1", "A320", "KATL"), "demo spawn");
  rs = autoAssignStands(D, deriveFlights(D, store.getPilots(), store.getState(), new Map(), Date.now()), memo);
  assert(rs.find(x => x.callsign === r.callsign).stand !== was, "demo: the proposal moves off the spawned gate");
}
/* ---------- tester feedback: DHL 50-55 heading, telex wording, airport flows ---------- */
{
  const C = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KCVG.json", import.meta.url))));
  for (const id of ["50", "51", "52", "53", "54", "55"]) {
    const h = C.standById.get(id).noseHdg;
    assert(h != null && (h < 30 || h > 330), `DHL ${id} faces north (nose toward DHL 6, pushes onto N): ${h}`);
  }
  assert(!/ VIA /.test(composeStandTelex(C, "50")) && / FOR TAXI\.$/.test(composeStandTelex(C, "50")),
    "stand telex: enter at the spot and call ramp there, no VIA lane: " + composeStandTelex(C, "50"));
  // Flows: an airport flow can move a lane's entry and exit spots.
  const raw = JSON.parse(readFileSync(new URL("../data/ramp/KCVG.json", import.meta.url)));
  raw.flows = [{ id: "S", label: "South flow", laneSpots: { DHL: { N: "65" } }, exitSpots: { DHL: { N: "58" } } }];
  const F = indexLayout(raw);
  const s50 = F.standById.get("50");
  const base = entrySpotFor(F, s50).id;
  assert(entrySpotFor(F, s50, "S").id === "65" && base !== "65", `south flow enters DHL 50 at 65 (default ${base})`);
  assert(exitSpotFor(F, s50, "S").id === "58", "south flow exits by 58");
  assert(exitSpotFor(F, s50).id === base, "no exit spots listed: exit = entry spot");
  assert(entrySpotFor(F, s50, "X").id === base, "unknown flow: default spots");
  assert(composeStandTelex(F, "50", { flow: "S" }).includes("ENTER AT SPOT 65."), "telex uses the flow's spot");
  assert(entrySpotFor(F, F.standById.get("21"), "S").id === entrySpotFor(F, F.standById.get("21")).id, "lanes the flow does not list keep their spot");
  const st = emptyState("KCVG");
  assert(st.settings.flow === "", "boards start in the default flow");
  assert(applyOp(st, { op: "settings", flow: "s" }, "T", 1).ok && st.settings.flow === "S", "flow is a shared board setting");
  assert(!applyOp(st, { op: "settings", flow: "no way" }, "T", 1).ok, "bad flow ids are refused");
  assert(applyOp(st, { op: "settings", flow: "" }, "T", 1).ok && st.settings.flow === "", "flow back to default");
}
/* ---------- KMCO ---------- */
{
  const M = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KMCO.json", import.meta.url))));
  const count = r => M.stands.filter(s => s.ramp === r).length;
  assert(M.stands.length === 192 && count("MCO-A1") === 24 && count("MCO-A3") === 27 && count("MCO-A2") === 31 &&
    count("MCO-A4") === 38 && count("MCO-C") === 37 && count("MCO-CH") === 25 && count("MCO-RON") === 10,
    "KMCO 192 stands: Airsides 1-4, South Terminal C gates and hardstands, Airside 2 RON");
  assert(M.stands.every(s => !s.approx), "every KMCO stand carries real coordinates");
  assert(M.stands.filter(s => s.ramp !== "MCO-RON").every(s => s.noseHdg != null), "every KMCO gate has a heading");
  // The generated frame round-trips exactly: a stand's x,y is its lat/lon.
  const s12 = M.standById.get("12");
  const g = M.proj.MCO.toLatLon(s12.x, s12.y);
  assert(Math.abs(g.lat - s12.lat) < 2e-6 && Math.abs(g.lon - s12.lon) < 2e-6, "KMCO frame is exact");
  assert(composeStandTelex(M, "12") === "KMCO GROUND: PARK STAND 12. CTC GROUND 121.8.", "Airside 1 telex: " + composeStandTelex(M, "12"));
  assert(composeStandTelex(M, "104") === "KMCO GROUND: PARK STAND 104. CTC GROUND 126.4.", "Airside 2 telex: " + composeStandTelex(M, "104"));
  assert(composeStandTelex(M, "80") === "KMCO AIRSIDE 4 RAMP: PARK STAND 80. CTC AIRSIDE 4 RAMP 131.85.", "Airside 4 telex: " + composeStandTelex(M, "80"));
  assert(composeStandTelex(M, "240A") === "KMCO CHARLIE RAMP: PARK STAND 240A. ENTER AT SPOT 1. CTC CHARLIE RAMP 129.65 AT SPOT 1 FOR TAXI.",
    "Terminal C telex: " + composeStandTelex(M, "240A"));
  assert(exitSpotFor(M, M.standById.get("252A")).id === "2", "Charlie Ramp departures leave by transition point 2");
  // Where airlines park, from flymco.com/airlines.
  const want = { VXP1: "MCO-A1", MXY1: "MCO-A1", FFT1: "MCO-A1", AAL1: "MCO-A3", UAL1: "MCO-A3", ASA1: "MCO-A3",
    SWA1: "MCO-A4", DAL1: "MCO-A4", ACA1: "MCO-A4", WJA1: "MCO-A4", JBU1: "MCO-C", BAW1: "MCO-C", VIR1: "MCO-C" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(M, [], operatorFor(M, cs, ""), cs).ramp === ramp, `KMCO ${cs} on ${ramp}`);
  const gatesOf = cs => airlineStands(M, { callsign: cs, op: operatorFor(M, cs, "") });
  assert(gatesOf("ASA1").every(id => /^3\d$/.test(id)), "Alaska: gates 30-39 only");
  assert(gatesOf("JBU1").every(id => /^23[0-8]/.test(id)), "JetBlue: C230-C238 only");
  assert(gatesOf("BAW1").every(id => /^24[0-5]/.test(id)), "British Airways: C240-C245 only");
  assert(gatesOf("VIR1").some(id => id.startsWith("238")) && gatesOf("VIR1").every(id => /^(238|24[0-5])/.test(id)), "Virgin Atlantic: C238-C245");
  assert(gatesOf("SWA1").some(id => M.standById.get(id).ramp === "MCO-A2"), "Southwest also on Airside 2 (100-129)");
  // Hardstands and RON spots are never proposed automatically.
  assert(airlineStands(M, { callsign: "JBU1", op: operatorFor(M, "JBU1", "") }).every(id => M.standById.get(id).ramp === "MCO-C"), "JetBlue proposals stay on the Terminal C gates");
  // Demo: an airside arrival (no entry spot on its lane) lands, taxis in and parks.
  const { createDemoStore } = await import("../shared/ramp-demo.js");
  let now = Date.parse("2026-10-07T15:00:00Z");
  const realNow = Date.now, realTimeout = globalThis.setTimeout;
  Date.now = () => now;
  globalThis.setTimeout = fn => { fn(); return 0; };
  try {
    const d = createDemoStore(M);
    d.seed();
    await d.op({ op: "assign", callsign: "SWA3307", stand: "7" });
    const mem = new Map();
    let r = null;
    for (let i = 0; i < 900 && !(r && r.atStand); i++) { now += 1000; d.tick(); r = deriveFlights(M, d.getPilots(), d.getState(), mem, now).find(x => x.callsign === "SWA3307"); }
    assert(r && r.atStand === "7" && r.state === STATES.PARKED, `demo airside arrival parks at its gate (got ${r?.state} ${r?.atStand})`);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
  }
}
/* ---------- KIAH ---------- */
{
  const H = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KIAH.json", import.meta.url))));
  const count = r => H.stands.filter(s => s.ramp === r).length;
  assert(H.stands.length === 163 && count("IAH-B") === 26 && count("IAH-E") === 23 && count("IAH-CGO") === 8 &&
    count("IAH-ECN") + count("IAH-ECS") === 17, "KIAH 163 stands: Terminals A-E, Terminal B B40-B68, Central and East Cargo");
  assert(H.stands.every(s => !s.approx && s.noseHdg != null), "every KIAH stand has real coordinates and a heading");
  // Terminal B is renumbered (70-9C): B40-B48, B50-B57, B60-B68, none of the old B1-B31.
  assert(H.standById.has("B40") && H.standById.has("B68") && !H.standById.has("B1") && !H.standById.has("B49"), "KIAH Terminal B numbering");
  assert(composeStandTelex(H, "B62") === "KIAH WEST RAMP: PARK STAND B62. ENTER AT SPOT 2. CTC WEST RAMP 121.625 AT SPOT 2 FOR TAXI.", "KIAH B telex: " + composeStandTelex(H, "B62"));
  assert(composeStandTelex(H, "A9").startsWith("KIAH NORTH RAMP: PARK STAND A9.") && composeStandTelex(H, "A9").includes("130.825"), "KIAH A north is North Ramp");
  assert(composeStandTelex(H, "D12").includes("CTC INTERNATIONAL RAMP 131.3"), "KIAH Terminal D is International Ramp");
  assert(composeStandTelex(H, "E9").includes("CTC EAST RAMP 131.275"), "KIAH Terminal E is East Ramp");
  assert(composeStandTelex(H, "DH1A").startsWith("KIAH INTERNATIONAL RAMP: PARK STAND 1A."), "KIAH D hardstands keep their chart names");
  assert(!/ CTC /.test(composeStandTelex(H, "CC2")), "KIAH cargo ramps have no chart frequency: " + composeStandTelex(H, "CC2"));
  assert(standForGate(H, "B51")?.id === "B51" && standForGate(H, "E20A")?.id === "E20", "KIAH real gates match");
  // One stand per gate with several lead-in lines, labelled with all of them.
  assert(standForGate(H, "E20B")?.id === "E20" && standForGate(H, "E20")?.id === "E20" && H.standById.get("E20").label === "E20A/B" &&
    ["D5", "D5A", "D5B", "D5C"].every(g => standForGate(H, g)?.id === "D5") && !H.standById.has("D5A") && !H.standById.has("E20A"), "KIAH E20A/B and D5A/B/C are one stand each");
  assert(["SR1", "SR2", "SR3"].every(id => H.standById.get(id).noseHdg === 180), "KIAH South Ramp noses south");
  const want = { UAL1: "IAH-E", SKW1: "IAH-B", AAL1: "IAH-AS", BAW1: "IAH-D", FDX1: "IAH-CGO" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(H, [], operatorFor(H, cs, ""), cs).ramp === ramp, `KIAH ${cs} on ${ramp}`);
}
/* ---------- KAUS ---------- */
{
  const A = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KAUS.json", import.meta.url))));
  assert(A.stands.length === 61 && A.stands.filter(s => s.ramp === "AUS-M").length === 15 && A.stands.filter(s => s.ramp === "AUS-13").length === 5,
    "KAUS 61 stands: gates 1-37 with lettered gates, 13A-13E, Maintenance Ramp M1-M13");
  assert(A.stands.every(s => !s.approx && s.noseHdg != null), "every KAUS stand has real coordinates and a heading");
  assert(composeStandTelex(A, "6") === "KAUS RAMP: PARK STAND 6. ENTER VIA TAXILANE C1. CTC RAMP 126.225.", "KAUS telex: " + composeStandTelex(A, "6"));
  assert(composeStandTelex(A, "M13") === "KAUS RAMP: PARK STAND M13.", "KAUS maintenance ramp has no ramp frequency");
  assert(A.stands.filter(s => s.ramp === "AUS-M").every(s => (s.tags || []).includes("maintenance")), "KAUS maintenance stands are tagged");
  assert(suggestStand(A, [], operatorFor(A, "SWA1", ""), "SWA1").ramp === "AUS-E" && suggestStand(A, [], operatorFor(A, "DAL1", ""), "DAL1").ramp === "AUS-W", "KAUS airline gates");
  assert(airlineStands(A, { callsign: "SWA12", op: operatorFor(A, "SWA12", "") }).every(id => !id.startsWith("M") && !id.startsWith("13")), "KAUS proposals skip the hardstands and maintenance");
}
/* ---------- KDFW ---------- */
{
  const F = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KDFW.json", import.meta.url))));
  const count = r => F.stands.filter(s => s.ramp === r).length;
  assert(F.stands.length === 246 && count("DFW-A") === 25 && count("DFW-SP") === 16 && count("DFW-WC") === 9,
    "KDFW 246 stands: Terminals A-E, hardstands, T stands, South Pad and West Cargo");
  assert(F.stands.every(s => !s.approx && s.noseHdg != null), "every KDFW stand has real coordinates and a heading");
  // 60-9B renumbered Terminal A: A4-A8 then A15, A16, A18; no A9-A14 or A17.
  assert(["A4", "A8", "A15", "A16", "A18"].every(id => F.standById.has(id)) && !["A9", "A14", "A17"].some(id => F.standById.has(id)), "KDFW Terminal A numbering");
  assert(composeStandTelex(F, "A20") === "KDFW A RAMP: PARK STAND A20. CTC A RAMP 131.275.", "KDFW A telex: " + composeStandTelex(F, "A20"));
  assert(composeStandTelex(F, "B40").includes("CTC B NORTH RAMP 130.1") && composeStandTelex(F, "B9").includes("CTC B-D RAMP 129.625") &&
    composeStandTelex(F, "D36").includes("CTC B-D RAMP 129.625") && composeStandTelex(F, "D12").includes("CTC D RAMP 129.825"), "KDFW B and D ramps");
  assert(composeStandTelex(F, "C10").includes("CTC A RAMP 131.275") && composeStandTelex(F, "C14").includes("CTC C RAMP 131.8"), "KDFW C2-C12 on 131.275, C14 on 131.8");
  assert(composeStandTelex(F, "E17").includes("CTC E NORTH RAMP 131.0") && composeStandTelex(F, "E18").includes("CTC E SOUTH RAMP 128.825"), "KDFW E north/south boundary");
  assert(composeStandTelex(F, "S90").includes("CTC D RAMP 129.825") && !/ CTC /.test(composeStandTelex(F, "WK1")), "KDFW South Pad on 129.825, West Cargo no freq");
  assert(composeStandTelex(F, "CT95").startsWith("KDFW C RAMP: PARK STAND T95.") && F.standById.has("T95"), "KDFW T95 at C and D keep their chart name");
  // One stand per gate with several lead-in lines.
  assert(["D17", "D17A", "D17X"].every(g => standForGate(F, g)?.id === "D17") && ["B22", "B22A"].every(g => standForGate(F, g)?.id === "B22") &&
    ["E22A", "E22B"].every(g => standForGate(F, g)?.id === "E22") && standForGate(F, "WK2X")?.id === "WK2" && !F.standById.has("D17A"), "KDFW multi-line gates are one stand");
  assert(F.standById.get("S99").noseHdg === 0 && F.standById.get("S90").noseHdg === 180, "KDFW South Pad rows nose away from Twy S2");
  const want = { AAL1: "DFW-CS", ENY1: "DFW-BN", BAW1: "DFW-DS", DAL1: "DFW-ES", CKS1: "DFW-WC" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(F, [], operatorFor(F, cs, ""), cs).ramp === ramp, `KDFW ${cs} on ${ramp}`);
  assert(airlineStands(F, { callsign: "AAL12", op: operatorFor(F, "AAL12", "") }).every(id => !/^(T|S|CT|A9|C9|B9)/.test(id)), "KDFW proposals skip hardstands and T stands");
}
/* ---------- KMIA ---------- */
{
  const M = indexLayout(JSON.parse(readFileSync(new URL("../data/ramp/KMIA.json", import.meta.url))));
  const count = r => M.stands.filter(s => s.ramp === r).length;
  assert(M.stands.length === 282 && count("MIA-C") === 17 && count("MIA-D60") === 16 && count("MIA-ER") === 9 && count("MIA-WCC") === 21 &&
    count("MIA-H890") === 7 && count("MIA-NE") === 20,
    "KMIA 282 stands: Central Base, Concourses D-J, D60, E Remote, West Cargo, Hangar 890 and Northeast Base");
  assert(M.stands.every(s => !s.approx && s.noseHdg != null), "every KMIA stand has real coordinates and a heading");
  // Spots carry the apron frequency (10-9B): the entry spot comes from the stand's ramp.
  assert(composeStandTelex(M, "C100") === "KMIA MIAMI GATES: PARK STAND C100. ENTER AT SPOT 1. CTC MIAMI GATES 128.025 AT SPOT 1 FOR TAXI.", "KMIA C100 telex: " + composeStandTelex(M, "C100"));
  assert(composeStandTelex(M, "D40").includes("SPOT 8. CTC AMERICAN APRON 130.325") && composeStandTelex(M, "D55").includes("CTC AMERICAN APRON 130.95 AT SPOT 13"),
    "KMIA D north on 130.325, D south on 130.95");
  assert(composeStandTelex(M, "D60M").includes("CTC MIAMI GATES 130.5 AT SPOT 11") && composeStandTelex(M, "E28").includes("130.95 AT SPOT 15"), "KMIA D60 and E Remote");
  assert(composeStandTelex(M, "H9").includes("130.5 AT SPOT 21") && composeStandTelex(M, "J9").includes("132.375 AT SPOT 24"), "KMIA H west on 130.5, J on 132.375");
  assert(composeStandTelex(M, "W51").includes("CTC MIAMI GROUND 121.8 AT SPOT 75") && !/ CTC /.test(composeStandTelex(M, "W12")), "KMIA cargo spots 73/75 on 121.8, Cargo City no freq");
  assert(M.stands.every(s => !M.rampSpots[s.ramp] || M.rampSpots[s.ramp].includes(entrySpotFor(M, s).id)), "KMIA entry spot is one of the stand's own ramp's");
  // One stand per gate whose A line ends at the base gate.
  assert(["D8", "D8A"].every(g => standForGate(M, g)?.id === "D8") && standForGate(M, "G5A")?.id === "G5" && !M.standById.has("D8A") &&
    M.standById.has("D10A") && M.standById.get("J17").label === "J17/A", "KMIA multi-line gates");
  assert(!["D5A", "D60D", "H3A", "C113"].some(id => M.standById.has(id)), "KMIA OSM-only gates left out");
  const want = { AAL1: "MIA-DN", ENY1: "MIA-D60", BAW1: "MIA-E", DAL1: "MIA-HE", UAL1: "MIA-G", DLH1: "MIA-J", FDX1: "MIA-WCC" };
  for (const [cs, ramp] of Object.entries(want)) assert(suggestStand(M, [], operatorFor(M, cs, ""), cs).ramp === ramp, `KMIA ${cs} on ${ramp}`);
  assert(airlineStands(M, { callsign: "AAL12", op: operatorFor(M, "AAL12", "") }).every(id => M.standById.get(id).ramp !== "MIA-ER"), "KMIA proposals skip E Remote");
  // Hangar 890 and Northeast Base (Jeppesen NE Base chart), in their own generated frame north of MIA's.
  const n7 = M.standById.get("N7");
  const g7 = M.proj.MNE.toLatLon(n7.x, n7.y);
  assert(Math.abs(g7.lat - n7.lat) < 2e-6 && Math.abs(g7.lon - n7.lon) < 2e-6 && n7.lat > 25.805, "KMIA Northeast Base frame is exact, north of the field");
  assert(composeStandTelex(M, "N7") === "KMIA RAMP: PARK STAND N7. ENTER AT SPOT 54.", "Northeast Base telex (no frequency on the chart): " + composeStandTelex(M, "N7"));
  assert(entrySpotFor(M, M.standById.get("890D")).id === "52" && entrySpotFor(M, M.standById.get("N24A")).id === "53", "Hangar 890 enters at 52, the NE Base ramp at 53/54");
  assert(["N1", "N4", "N10"].every(id => M.standById.get(id).noseHdg < 20 || M.standById.get(id).noseHdg > 340) &&
    ["N18", "N20", "N24"].every(id => Math.abs(M.standById.get(id).noseHdg - 177) < 10), "NE Base north row noses north, south row south");
  assert(["AAL1", "DAL1", "UAL1"].every(cs => airlineStands(M, { callsign: cs, op: operatorFor(M, cs, "") }).every(id => !["MIA-H890", "MIA-NE"].includes(M.standById.get(id).ramp))),
    "Hangar 890 and Northeast Base are never proposed automatically");
}
console.log(`test-ramp-core (with demo): ${passed} passed`);
