#!/usr/bin/env node
/**
 * Departures: read the SID from the filed route and leave through the end of
 * the ramp that SID faces.
 * Usage: node scripts/test-ramp-sid.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sidBase, sidKey, parseSid, sideForSid, departureSpot, mergeSidSides, SIDE_NORTH, SIDE_SOUTH } from "../shared/ramp-sid.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "KATL.json"), "utf8"));

/* the revision is not part of the name */
assert(sidBase("PENCL2") === "PENCL", "PENCL2 is PENCL");
assert(sidBase("PENCL3") === "PENCL", "and so is PENCL3 — configuring it once is enough");
assert(sidBase("GAIRY2.MCN") === "GAIRY", "a transition is stripped");
assert(sidBase("SMKEY1A") === "SMKEY", "a lettered revision is stripped");
assert(sidBase("PADGT3") === "PADGT", "six-letter names survive");
assert(sidBase("J75") === "" && sidBase("DCT") === "" && sidBase("KATL") === "", "route junk is not a SID");
assert(sidBase("") === "" && sidBase(null) === "", "empty input is safe");
assert(sidBase("PENCL") === "", "a bare name is not a route token — it carries no revision");

/* the map key accepts either form, because a controller types the bare name */
assert(sidKey("PENCL") === "PENCL" && sidKey("PENCL2") === "PENCL", "either form keys the map");
assert(sidKey("GAIRY2.MCN") === "GAIRY", "a transition is stripped from the key too");
assert(sidKey("J75") === "" && sidKey("") === "", "junk is not a key");

/* pulling it out of a filed route */
assert(parseSid("PENCL2 RMG J75", "KATL").base === "PENCL", "leading SID");
assert(parseSid("KATL PENCL2 RMG", "KATL").base === "PENCL", "SID after the departure airport");
assert(parseSid("GAIRY2.MCN LGC", "KATL").token === "GAIRY2", "the filed token is kept for display");
assert(parseSid("DCT J75 ABC", "KATL") === null, "a route with no SID gives nothing");
assert(parseSid("", "KATL") === null, "an empty route gives nothing");

/* side lookup ignores the revision, in both directions */
const MAP = { PENCL: SIDE_NORTH, GAIRY: SIDE_SOUTH };
assert(sideForSid("PENCL2", MAP) === "NORTH", "PENCL2 goes north");
assert(sideForSid("PENCL", MAP) === "NORTH", "and so does the bare name");
assert(sideForSid("GAIRY2", MAP) === "SOUTH", "GAIRY2 goes south");
assert(sideForSid("BANNG3", MAP) === null, "an unconfigured SID has no side — it is not guessed");
assert(sideForSid("PENCL2", { PENCL: "sideways" }) === null, "a bad value is ignored");

/* the worked examples from the ramp chart: same gate, opposite ends */
const c30 = M.stands.find(s => s.id === "C30");
assert(c30.ramp === "R3", "C30 is on Ramp 3");
assert(departureSpot(c30.ramp, sideForSid("PENCL2", MAP), M.spots).spot.id === "3N",
  "C30 on a PENCL departs 3N");
assert(departureSpot(c30.ramp, sideForSid("GAIRY2", MAP), M.spots).spot.id === "3S",
  "C30 on a GAIRY departs 3S");

/* and it follows the gate's ramp, not the gate */
const t13 = M.stands.find(s => s.id === "T13");
assert(departureSpot(t13.ramp, SIDE_NORTH, M.spots).spot.id === "1N", "T13 on a north SID departs 1N");
const d18 = M.stands.find(s => s.id === "D18");
assert(departureSpot(d18.ramp, SIDE_SOUTH, M.spots).spot.id === "4S", "D18 on a south SID departs 4S");

/* no side configured yet: no spot invented */
assert(departureSpot("R3", null, M.spots) === null, "an unconfigured SID yields no spot");

/* a ramp with only one spot sends everyone there, and says it was not exact */
const r9 = departureSpot("R9", SIDE_NORTH, M.spots);
assert(r9 && r9.spot.id === "9S", "Ramp 9 has only 9S, so a north SID still uses it");
assert(r9.exact === false, "and that is reported as a fallback, not a match");
assert(departureSpot("R99", SIDE_NORTH, M.spots) === null, "an unknown ramp yields nothing");

/* merging shipped defaults with a controller's edits */
const merged = mergeSidSides({ PENCL: "NORTH", GAIRY: "SOUTH" }, { GAIRY: "NORTH", BANNG: "SOUTH" });
assert(merged.PENCL === "NORTH", "an untouched default survives");
assert(merged.GAIRY === "NORTH", "the controller overrides the shipped default — it is their airport");
assert(merged.BANNG === "SOUTH", "a new SID is added");
assert(mergeSidSides({ PENCL: "NORTH" }, { PENCL: null }).PENCL === undefined, "clearing a SID removes it");
assert(mergeSidSides({ "PENCL2": "NORTH" }, {}).PENCL === "NORTH", "a revision in the file is normalised away");
assert(mergeSidSides(null, null).PENCL === undefined, "empty inputs are safe");

/* what ships in the override file */
const ov = JSON.parse(readFileSync(join(ROOT, "data", "ramp", "overrides", "KATL.json"), "utf8"));
assert(ov.sidSides && ov.sidSides.PENCL === "NORTH" && ov.sidSides.GAIRY === "SOUTH",
  "the two worked examples ship configured");
for (const [sid, side] of Object.entries(ov.sidSides)) {
  assert(sidKey(sid) === sid, "shipped SID " + sid + " is stored without a revision");
  assert(side === "NORTH" || side === "SOUTH", "shipped side for " + sid + " is valid");
}

console.log(`ramp-sid: ${passed} assertions passed`);
