#!/usr/bin/env node
import {
  buildProbeSamples,
  probeConflicts,
  setSuaFeatures,
  routeAlertSeverity,
  parseCruiseFl,
  resolveProbeFl,
  segmentCoords,
} from "../shared/edst-conflict-probe.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

function dLonAt(lat, nm) {
  return nm / (60 * Math.cos((lat * Math.PI) / 180));
}

function segLenNm(coords) {
  let n = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const R = 3440.065;
    const toR = d => (d * Math.PI) / 180;
    const dLat = toR(b[0] - a[0]), dLon = toR(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2
      + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLon / 2) ** 2;
    n += 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  return n;
}

assert(parseCruiseFl("FL350") === 350, "parse FL350");
assert(parseCruiseFl("35000") === 350, "parse 35000 ft");
assert(parseCruiseFl(370) === 370, "parse numeric FL");
assert(resolveProbeFl({ alt: 200, cruise: "FL350" }, {}) === 350, "filed cruise over present");
assert(resolveProbeFl({ alt: 200, cruise: "FL350" }, { assignedFl: 310 }) === 310, "assigned over filed");

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
assert(ea.segments && ea.segments.some(s => s.sev === "r" && s.coords.length >= 2), "red conflict has segment");

// 8 NM parallel same heading → yellow
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

// Head-on closing from ~15 NM → red; highlight only near the conflict, not full 40 NM DR path
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
const hSeg = (mapH.get("SWA1").segments || []).find(s => s.sev === "r");
assert(hSeg && hSeg.coords.length >= 2, "head-on has red segment coords");
const hSegNm = segLenNm(hSeg.coords);
assert(hSegNm < 35, "conflict segment shorter than full dead-reckon path (" + hSegNm.toFixed(1) + " NM)");

// Assigned/filed altitude for separation — present alt ignored
// A currently FL200 but filed FL350; B at FL350 filed FL350; laterally ~3 NM → red
const f1 = {
  cs: "FFT1", lat: 33.0, lon: -97.0, alt: 200, cruise: "FL350",
  gs: 450, hdg: 90, routeFixes: [],
};
const f2 = {
  cs: "FFT2", lat: 33.0, lon: -97.0 + dLonAt(33, 3), alt: 350, cruise: "350",
  gs: 450, hdg: 270, routeFixes: [],
};
const mapF = probeConflicts([f1, f2], {});
assert(mapF.get("FFT1").r >= 1, "filed cruise used for sep (not present FL200)");

// Assigned altitudes 2000 ft apart → no conflict even if present alts match
const v1 = { cs: "V1", lat: 34.0, lon: -98.0, alt: 350, gs: 400, hdg: 90, routeFixes: [] };
const v2 = {
  cs: "V2", lat: 34.0, lon: -98.0 + dLonAt(34, 3), alt: 350, gs: 400, hdg: 270, routeFixes: [],
};
const mapV = probeConflicts([v1, v2], { assigned: { V1: 350, V2: 370 } });
assert(mapV.get("V1").r === 0 && mapV.get("V1").y === 0, "assigned ΔFL20 = no A–A conflict");

// Muted: uncleared assigned altitude creates the conflict level
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
  altPending: new Set(),
});
const em = mapM.get("ASA1");
assert(em.r >= 1 || em.y >= 1, "uncleared climb creates conflict");
assert(
  (em.r >= 1 && em.rMuted) || (em.y >= 1 && em.yMuted),
  "uncleared altitude conflict is muted",
);

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
assert(probeConflicts([e], {}).get("N1").status === "X", "no position → X");
assert(probeConflicts([a], { stopProbe: new Set(["AAL1"]) }).get("AAL1").status === "S", "stop probe → S");
assert(probeConflicts([a], { holdActive: new Set(["AAL1"]) }).get("AAL1").status === "H", "hold → H");
assert(probeConflicts([a], { frozen: new Set(["AAL1"]) }).get("AAL1").status === "F", "frozen → F");

const samples = buildProbeSamples({
  cs: "X", lat: 30, lon: -81, alt: 200, gs: 400, hdg: 90,
  routeFixes: [{ lat: 30.5, lon: -80.5, name: "FIXA" }],
}, { assignedFl: 350, altPending: false });
assert(samples.length >= 2, "samples along route");
assert(samples.every(s => s.altFl === 350), "all samples use assigned probe FL");
assert(samples.every(s => s.projected), "uncleared assigned marks projected");

const samplesCleared = buildProbeSamples({
  cs: "X", lat: 30, lon: -81, alt: 200, gs: 400, hdg: 90,
  routeFixes: [{ lat: 30.5, lon: -80.5, name: "FIXA" }],
}, { assignedFl: 350, altPending: true });
assert(samplesCleared.every(s => s.altFl === 350), "cleared climb still probes at assigned");
assert(!samplesCleared.some(s => s.projected), "cleared climb samples not muted/projected");

const coords = segmentCoords(samples, 1, 2, 1);
assert(coords.length >= 2, "segmentCoords returns a polyline");

// Aircraft-to-SAA ≤ 3 NM → orange A with segment
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
assert(
  (mapS.get("N172SP").segments || []).some(s => s.sev === "a"),
  "airspace conflict has segment",
);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
