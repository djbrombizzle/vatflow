#!/usr/bin/env node
/**
 * Sanity-check remaining-route trim used by GPD (mirrors FCA builder).
 * Usage: node scripts/test-gpd-remaining-route.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindAirports,
  seedNavData,
  buildRoutePathLLs,
  trimAnchorsAhead,
} from "../shared/route-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAV = join(__dirname, "..", "data", "nav");

const AIRPORTS = {
  KJAX: [30.4941, -81.6879],
  KMCO: [28.4294, -81.3090],
  KATL: [33.6367, -84.4281],
};

bindAirports(
  icao => AIRPORTS[icao] || null,
  icao => !!AIRPORTS[icao],
);

seedNavData({
  meta: JSON.parse(readFileSync(join(NAV, "meta.json"), "utf8")),
  fixes: JSON.parse(readFileSync(join(NAV, "fixes.json"), "utf8")),
  navaids: JSON.parse(readFileSync(join(NAV, "navaids.json"), "utf8")),
  airways: JSON.parse(readFileSync(join(NAV, "airways.json"), "utf8")),
  procedures: JSON.parse(readFileSync(join(NAV, "procedures.json"), "utf8")),
  preferred: JSON.parse(readFileSync(join(NAV, "preferred.json"), "utf8")),
});

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// Aircraft mid-route Jax→Orlando-ish: remaining path must start at NOW, not dep.
const p = {
  callsign: "N123",
  dep: "KJAX",
  arr: "KMCO",
  route: "SJW CRG OMN",
  lat: 29.8,
  lon: -81.4,
  hdg: 180,
  phase: "air",
};
const full = buildRoutePathLLs(p, {
  origin: AIRPORTS.KJAX,
  destination: AIRPORTS.KMCO,
  includeNow: false,
});
const rem = buildRoutePathLLs(p, {
  origin: AIRPORTS.KJAX,
  destination: AIRPORTS.KMCO,
  includeNow: true,
});
assert(full.length >= 2, "full route has points");
assert(rem.length >= 2, "remaining route has points");
assert(
  Math.abs(rem[0][0] - p.lat) < 1e-6 && Math.abs(rem[0][1] - p.lon) < 1e-6,
  "remaining path starts at aircraft NOW",
);
assert(rem.length <= full.length + 1, "remaining is not longer than full+NOW");

// Hub-style fix list trim
const anchors = [
  { name: "KJAX", ll: AIRPORTS.KJAX.slice(), kind: "apt" },
  { name: "CRG", ll: [30.2, -81.5], kind: "fix" },
  { name: "OMN", ll: [29.3, -81.1], kind: "fix" },
  { name: "KMCO", ll: AIRPORTS.KMCO.slice(), kind: "apt" },
];
const ahead = trimAnchorsAhead(anchors, p);
assert(ahead[0].kind === "now", "trimAnchorsAhead prepends NOW");
assert(!ahead.some(a => a.name === "KJAX"), "departure airport dropped behind aircraft");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
