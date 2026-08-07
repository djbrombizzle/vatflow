#!/usr/bin/env node
import {
  buildProbeSamples,
  probeConflicts,
  setSuaFeatures,
  routeAlertSeverity,
} from "../shared/edst-conflict-probe.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

function dLonAt(lat, nm) {
  return nm / (60 * Math.cos((lat * Math.PI) / 180));
}

// Two aircraft ~3 NM apart at same alt → red
const a = { cs: "AAL1", lat: 30.0, lon: -81.0, alt: 350, gs: 450, hdg: 90, routeFixes: [] };
const b = {
  cs: "UAL2",
  lat: 30.0,
  lon: -81.0 + dLonAt(30, 3),
  alt: 350,
  gs: 450,
  hdg: 270,
  routeFixes: [],
};

const map = probeConflicts([a, b], {});
const ea = map.get("AAL1"), eb = map.get("UAL2");
assert(ea && ea.r >= 1, "AAL1 has red alert");
assert(eb && eb.r >= 1, "UAL2 has red alert");
assert(ea.y === 0, "no yellow when red");
assert(routeAlertSeverity(ea) === "r", "route severity red");

// 8 NM parallel same heading → yellow (must not false-red via time slack)
const c = { cs: "DAL3", lat: 30.0, lon: -81.0, alt: 350, gs: 450, hdg: 90, routeFixes: [] };
const d = {
  cs: "JBU4",
  lat: 30.0,
  lon: -81.0 + dLonAt(30, 8),
  alt: 350,
  gs: 450,
  hdg: 90,
  routeFixes: [],
};
const map2 = probeConflicts([c, d], {});
assert(map2.get("DAL3").y >= 1 && map2.get("DAL3").r === 0, "8 NM is yellow");
assert(map2.get("JBU4").y >= 1, "partner also yellow");
assert(routeAlertSeverity(map2.get("DAL3")) === "y", "route severity yellow");

// Head-on closing from ~15 NM → eventually red
const h1 = { cs: "SWA1", lat: 35.0, lon: -100.0, alt: 340, gs: 480, hdg: 90, routeFixes: [] };
const h2 = {
  cs: "SWA2",
  lat: 35.0,
  lon: -100.0 + dLonAt(35, 15),
  alt: 340,
  gs: 480,
  hdg: 270,
  routeFixes: [],
};
const mapH = probeConflicts([h1, h2], {});
assert(mapH.get("SWA1").r >= 1, "head-on closing yields red");

// Muted: currently vertically separated; uncleared climb closes vertically into conflict
const m1 = {
  cs: "ASA1", lat: 40.0, lon: -110.0, alt: 330, gs: 420, hdg: 90, routeFixes: [],
};
const m2 = {
  cs: "ASA2",
  lat: 40.0,
  lon: -110.0 + dLonAt(40, 4),
  alt: 350,
  gs: 420,
  hdg: 270,
  routeFixes: [],
};
const mapM = probeConflicts([m1, m2], {
  assigned: { ASA1: 350 },
  altPending: new Set(), // uncleared
});
const em = mapM.get("ASA1");
assert(em.r >= 1 || em.y >= 1, "uncleared climb creates conflict");
assert(
  (em.r >= 1 && em.rMuted) || (em.y >= 1 && em.yMuted),
  "uncleared altitude conflict is muted",
);

// Cleared climb (pending WILCO) → same geometry but bright
const mapC = probeConflicts([m1, m2], {
  assigned: { ASA1: 350 },
  altPending: new Set(["ASA1"]),
});
const ec = mapC.get("ASA1");
assert(ec.r >= 1 || ec.y >= 1, "cleared climb still probes");
assert(
  !(ec.rMuted && ec.r >= 1) && !(ec.yMuted && ec.y >= 1 && !ec.r),
  "cleared climb conflict is not muted",
);

// No position → X
const e = { cs: "N1", lat: null, lon: null, alt: 100 };
const map3 = probeConflicts([e], {});
assert(map3.get("N1").status === "X", "no position → X");

// Stop probe / hold / frozen
assert(probeConflicts([a], { stopProbe: new Set(["AAL1"]) }).get("AAL1").status === "S", "stop probe → S");
assert(probeConflicts([a], { holdActive: new Set(["AAL1"]) }).get("AAL1").status === "H", "hold → H");
assert(probeConflicts([a], { frozen: new Set(["AAL1"]) }).get("AAL1").status === "F", "frozen → F");

const samples = buildProbeSamples({
  cs: "X", lat: 30, lon: -81, alt: 200, gs: 400, hdg: 90,
  routeFixes: [{ lat: 30.5, lon: -80.5, name: "FIXA" }],
}, { assignedFl: 350, altPending: false });
assert(samples.length >= 2, "samples along route");
assert(samples.some(s => s.projected), "uncleared climb marks projected samples");

const samplesCleared = buildProbeSamples({
  cs: "X", lat: 30, lon: -81, alt: 200, gs: 400, hdg: 90,
  routeFixes: [{ lat: 30.5, lon: -80.5, name: "FIXA" }],
}, { assignedFl: 350, altPending: true });
assert(samplesCleared.some(s => Math.abs(s.altFl - 200) > 3), "cleared climb still projects altitude");
assert(!samplesCleared.some(s => s.projected), "cleared climb samples not muted/projected");

// Aircraft-to-SAA ≤ 3 NM → orange A
setSuaFeatures({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { floorFt: 0, ceilFt: 60000, name: "TESTMOA", type: "MOA" },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-81.02, 29.98], [-80.98, 29.98], [-80.98, 30.02], [-81.02, 30.02], [-81.02, 29.98],
      ]],
    },
  }],
});
const suaAc = { cs: "N172SP", lat: 30.0, lon: -81.0, alt: 200, gs: 140, hdg: 90, routeFixes: [] };
const mapS = probeConflicts([suaAc], {});
assert(mapS.get("N172SP").a >= 1, "inside/near SUA → A alert");
assert(routeAlertSeverity(mapS.get("N172SP")) === "a", "route severity airspace");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
