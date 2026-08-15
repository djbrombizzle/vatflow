#!/usr/bin/env node
/**
 * Regression: past ART rejected; overnight wrap allowed.
 * Usage: node scripts/test-time-parse.mjs
 */
import { parseZuluHhmm, parseZuluHhmmDetail } from "../shared/time-parse.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const now = Date.UTC(2026, 7, 14, 18, 30, 0); // 1830Z

assert(parseZuluHhmm("1900", now) === Date.UTC(2026, 7, 14, 19, 0, 0), "future HHMM");
assert(parseZuluHhmm("19:00z", now) === Date.UTC(2026, 7, 14, 19, 0, 0), "colon + z");
assert(parseZuluHhmm("1830", now) === now, "exact now");
assert(parseZuluHhmm("1200", now) == null, "past rejected");
assert(parseZuluHhmmDetail("1200", now).reason === "past", "past reason");
assert(parseZuluHhmmDetail("99", now).reason === "format", "format reason");

const late = Date.UTC(2026, 7, 14, 23, 50, 0);
assert(parseZuluHhmm("0015", late) === Date.UTC(2026, 7, 15, 0, 15, 0), "overnight wrap");
assert(parseZuluHhmm("1200", late) == null, "far next-day rejected");

console.log(`OK ${passed} assertions`);
