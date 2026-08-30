#!/usr/bin/env node
/**
 * Every committed override file is internally consistent and matches the field
 * table. Runs over all of them, so a new airport is covered the day it is added.
 * Usage: node scripts/test-ramp-overrides.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELDS } from "../shared/ramp-app-fields.mjs";
import { sidKey, SIDE_NORTH, SIDE_SOUTH } from "../shared/ramp-sid.js";
import { resolveBlock } from "../shared/ramp-alloc.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data", "ramp", "overrides");
const files = readdirSync(DIR).filter(f => f.endsWith(".json")).sort();

assert(files.length >= 2, "more than one airport is configured (" + files.join(", ") + ")");

for (const file of files) {
  const icao = file.replace(/\.json$/, "");
  const d = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const at = m => `${icao}: ${m}`;

  assert(FIELDS[icao], at("the field table knows this airport"));
  assert(d.icao === icao, at("the file names its own airport"));
  assert(Array.isArray(d.ramps) && d.ramps.length, at("has ramp areas"));
  assert(d.concourses && Object.keys(d.concourses).length, at("has concourses"));
  assert(d.operatorBlocks && Object.keys(d.operatorBlocks).length, at("has airline blocks"));

  const concourses = new Set(Object.keys(d.concourses));

  for (const r of d.ramps) {
    assert(r.id && r.label, at("ramp " + r.id + " has an id and a label"));
    assert("freq" in r, at("ramp " + r.id + " states a frequency, even if null"));
    for (const c of r.concourses || []) {
      assert(concourses.has(c), at("ramp " + r.id + " references a real concourse: " + c));
    }
  }
  const rampIds = d.ramps.map(r => r.id);
  assert(new Set(rampIds).size === rampIds.length, at("ramp ids are unique"));

  // Every concourse belongs to exactly one ramp, or stands on it get no ramp.
  const owned = new Map();
  for (const r of d.ramps) for (const c of r.concourses || []) owned.set(c, (owned.get(c) || 0) + 1);
  for (const c of concourses) {
    assert(owned.get(c) >= 1, at("concourse " + c + " belongs to a ramp"));
    assert(owned.get(c) === 1, at("concourse " + c + " belongs to only one ramp"));
  }

  for (const [op, entry] of Object.entries(d.operatorBlocks)) {
    assert(/^[A-Z]{3}$/.test(op) || op.startsWith("*"),
      at(op + " is an ICAO airline code or a wildcard"));
    for (const c of [...(entry.concourses || []), ...(entry.intl || [])]) {
      assert(concourses.has(c), at(op + " references a real concourse: " + c));
    }
    if (entry.inherits) {
      assert(d.operatorBlocks[entry.inherits], at(op + " inherits a block that exists"));
      assert(!d.operatorBlocks[entry.inherits].inherits, at(op + " does not inherit a chain"));
    }
    if (entry.opsType) {
      assert(["airline", "cargo", "ga", "military"].includes(entry.opsType),
        at(op + " has a known ops type"));
    }
    // A block must actually resolve to somewhere, or its traffic goes nowhere.
    const resolved = resolveBlock(op, d.operatorBlocks);
    assert(resolved.concourses.length > 0 || resolved.opsType,
      at(op + " resolves to at least one concourse or an ops type"));
  }

  for (const [sid, side] of Object.entries(d.sidSides || {})) {
    assert(sidKey(sid) === sid, at("SID " + sid + " is stored without a revision"));
    assert(side === SIDE_NORTH || side === SIDE_SOUTH, at("SID " + sid + " has a valid side"));
  }

  assert(Array.isArray(d._confirm) && d._confirm.length,
    at("records what still needs confirming — none of this data is authoritative"));
}

/* KIAD specifics: it ships override data and takes geometry from OSM */
const iad = JSON.parse(readFileSync(join(DIR, "KIAD.json"), "utf8"));
assert(FIELDS.KIAD.ref[0] > 38.9 && FIELDS.KIAD.ref[0] < 39.0, "KIAD reference point is at Dulles");
assert(resolveBlock("UAL", iad.operatorBlocks).concourses.join() === "C,D", "United is on the C/D midfield");
assert(resolveBlock("GJS", iad.operatorBlocks).concourses.includes("C"), "United Express inherits United's block");
assert(resolveBlock("AAL", iad.operatorBlocks).concourses.join() === "B", "American is on B");
assert(resolveBlock("BAW", iad.operatorBlocks).concourses.join() === "D", "British Airways is on D");
assert(resolveBlock("FDX", iad.operatorBlocks).opsType === "cargo", "cargo is cargo");
assert(!iad.operatorBlocks["*"], "no wildcard: an unlisted carrier draws any open gate");
assert(Object.keys(iad.sidSides).length === 0, "IAD SIDs are left for a controller to set");

console.log(`ramp-overrides: ${passed} assertions passed across ${files.length} airports`);
