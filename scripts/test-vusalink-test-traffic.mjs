import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestFlights, simulateReply, testCallsigns } from "../shared/vusalink-test-traffic.js";
import { createCdrStore, stripRouteEnds } from "../shared/vusalink-clearance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const flights = makeTestFlights();
assert(flights.length >= 5, `enough synthetic traffic, got ${flights.length}`);

// Rows must look like the live feed's mapLive() output or the board will choke.
const REQUIRED = ["cs", "type", "alt", "hs", "squawk", "assignedSquawk", "hdg", "gs",
  "lat", "lon", "route", "_routeRaw", "dep", "arr", "source"];
for (const a of flights) {
  for (const k of REQUIRED) {
    assert(Object.prototype.hasOwnProperty.call(a, k), `${a.cs} is missing ${k}`);
  }
  assert(/^[A-Z]{4}$/.test(a.dep) && /^[A-Z]{4}$/.test(a.arr), `${a.cs} has ICAO endpoints`);
  assert(Number.isFinite(a.lat) && Number.isFinite(a.lon), `${a.cs} has a position`);
  assert(a.source === "manual", `${a.cs} must read as a controller strip to pass the ACL filters`);
  assert(a.test === true, `${a.cs} must be flagged as synthetic`);
}

const callsigns = flights.map((a) => a.cs);
assert(new Set(callsigns).size === callsigns.length, "callsigns are unique");
assert(testCallsigns().join() === callsigns.join(), "testCallsigns matches the fleet");

// Ground aircraft are the point of the exercise — the clearance panel opens for them.
const ground = flights.filter((a) => a.gs <= 50);
assert(ground.length >= 3, `enough aircraft on the ground, got ${ground.length}`);
assert(flights.some((a) => a.gs > 50), "at least one airborne for the enroute tab");

// A ground aircraft's filed route should resolve to a real CDR, so the picker
// has something to show and marks it ON FILE.
const store = createCdrStore({
  base: join(ROOT, "data", "cdr") + "/",
  fetchImpl: async (p) => {
    try {
      return { ok: true, json: async () => JSON.parse(readFileSync(p, "utf8")) };
    } catch (e) {
      return { ok: false, json: async () => null };
    }
  },
});

let matched = 0;
for (const a of ground) {
  const pair = await store.forPair(a.dep, a.arr);
  assert(pair.length > 0, `${a.cs}: ${a.dep}->${a.arr} has CDRs to pick from`);
  const filed = stripRouteEnds(a._routeRaw, a.dep, a.arr);
  if (pair.some((c) => c.route === filed)) matched++;
}
assert(matched >= 1, "at least one synthetic aircraft is filed on a real CDR");

// The documented worked example must stay wired up.
const dal = flights.find((a) => a.cs === "DAL1234");
assert(dal && dal.dep === "KATL" && dal.arr === "KMCO", "DAL1234 is the KATL->KMCO demo");
const dalPair = await store.forPair("KATL", "KMCO");
assert(dalPair.some((c) => c.code === "ATLMCORP"
  && c.route === stripRouteEnds(dal._routeRaw, "KATL", "KMCO")), "DAL1234 is filed on ATLMCORP");

// ---- simulated replies ---------------------------------------------------
const clearance = "CLEARED TO THE KMCO ARPT";
assert(simulateReply(clearance, () => 0.05).reply === "UNABLE", "low roll on a clearance gives UNABLE");
assert(simulateReply("CLIMB TO FL350", () => 0.05).reply === "STANDBY",
  "a non-clearance never draws the clearance-only UNABLE");
const standby = simulateReply("CLIMB TO FL350", () => 0.1);
assert(standby.reply === "STANDBY" && standby.then && standby.then.reply === "WILCO",
  "STANDBY is followed by WILCO");
assert(simulateReply(clearance, () => 0.9).reply === "WILCO", "high roll gives WILCO");
for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
  const plan = simulateReply(clearance, () => r);
  assert(plan.delayMs > 0 && plan.delayMs < 15000, `delay is sane at r=${r}`);
  assert(["WILCO", "UNABLE", "STANDBY"].includes(plan.reply), `known reply at r=${r}`);
}

console.log(`ok — ${flights.length} synthetic aircraft (${ground.length} on the ground), replies sane`);
