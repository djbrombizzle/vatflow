#!/usr/bin/env node
/**
 * apt.dat parsing and enrichment: fills what OSM lacks, overwrites nothing it has.
 * Usage: node scripts/test-ramp-aptdat.mjs
 */
import { parseAptDat, mergeAptDat } from "../shared/ramp-aptdat.js";
import { makeProjection, synthStandPoly } from "../shared/ramp-airport.js";
import { viewToCamera, cameraToScale, viewUnchanged, mountRampBasemap } from "../shared/ramp-basemap.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const REF = [33.6367, -84.4281];
const proj = makeProjection(REF[0], REF[1]);

/* a fixture in the real apt.dat shape, with a second airport around it */
const APT = `I
1100 Version - data cycle 2026.08

1 1026 1 0 KATL Hartsfield Jackson Atlanta Intl
100 45.72 1 0 0.00 0 3 0 08L 33.6500 -84.4500 0 0 3 0 0 0
1300 33.64010 -84.43010 271.0 gate jets|heavy D32
1301 E airline DAL EDV
1300 33.64110 -84.42910 90.0 gate jets C21
1301 C airline SWA
1300 33.64210 -84.42810 180.0 gate turboprops C22
1300 33.64310 -84.42710 0.0 hangar props GA1
1301 B general_aviation
1300 33.64410 -84.42610 45.0 gate heavy CARGO1
1301 E cargo FDX UPS

1 313 1 0 KIAD Washington Dulles Intl
1300 38.94450 -77.45580 90.0 gate jets B79
1301 C airline UAL
`;

const recs = parseAptDat(APT, "KATL");
assert(recs.length === 5, "five startup locations at KATL (" + recs.length + ")");
assert(!recs.some(r => r.name === "B79"), "the next airport's stands are not included");

const d32 = recs.find(r => r.name === "D32");
assert(d32.hdg === 271, "heading parsed");
assert(d32.sizeCode === "E", "the 1301 width code wins over the aircraft classes");
assert(d32.operators.join() === "DAL,EDV", "airline codes parsed");
assert(d32.opsType === "airline", "ops type parsed");
assert(Math.abs(d32.lat - 33.6401) < 1e-6 && Math.abs(d32.lon + 84.4301) < 1e-6, "position parsed");

const c22 = recs.find(r => r.name === "C22");
assert(c22.sizeCode === "B", "with no 1301, the size comes from the aircraft classes");
assert(c22.operators.length === 0, "and there are no operators to claim");

assert(recs.find(r => r.name === "GA1").opsType === "ga", "general_aviation maps to ga");
assert(recs.find(r => r.name === "CARGO1").opsType === "cargo", "cargo maps to cargo");
assert(recs.find(r => r.name === "CARGO1").operators.join() === "FDX,UPS", "cargo operators parsed");

assert(parseAptDat(APT, "KIAD").length === 1, "a different airport parses on its own");
assert(parseAptDat(APT, "KZZZ").length === 0, "an absent airport yields nothing");
assert(parseAptDat("", "KATL").length === 0, "empty input is safe");

/* enrichment */
const stand = (id, lat, lon, extra = {}) => {
  const [x, y] = proj.toXY(lat, lon);
  return {
    id, point: [x, y], hdg: 0, hdgKnown: false, sizeCode: null,
    operators: [], opsType: "airline", poly: synthStandPoly([x, y], 0, "C"), ...extra,
  };
};

const model = {
  stands: [
    stand("D32", 33.64010, -84.43010),
    stand("C21", 33.64110, -84.42910, { hdg: 95, hdgKnown: true, sizeCode: "D", operators: ["ASA"] }),
    stand("C99", 33.70000, -84.50000),   // far from every apt.dat record
  ],
};
const report = mergeAptDat(model, recs, { proj });

const byId = id => model.stands.find(s => s.id === id);
assert(report.matched >= 2, "records matched to stands");
assert(report.unmatched >= 2, "records with no stand are reported, not silently dropped");

assert(byId("D32").hdg === 271 && byId("D32").hdgKnown === true, "a missing heading is filled in");
assert(byId("D32").sizeCode === "E", "a missing size code is filled in");
assert(byId("D32").operators.join() === "DAL,EDV", "missing operators are filled in");

// The whole point of "enrichment only": what the surface already states survives.
assert(byId("C21").hdg === 95, "a known heading is not overwritten");
assert(byId("C21").sizeCode === "D", "a stated size code is not overwritten");
assert(byId("C21").operators.join() === "ASA", "stated operators are not overwritten");

assert(byId("C99").sizeCode === null, "a stand with no nearby record is left alone");
assert(byId("D32").id === "D32" && byId("C21").id === "C21", "no stand is ever renamed");
const before = byId("D32").point.slice();
mergeAptDat(model, recs, { proj });
assert(byId("D32").point[0] === before[0] && byId("D32").point[1] === before[1], "no stand is ever moved");

/* matching by name beats matching by distance */
const shifted = [{ ...d32, lat: 33.64110, lon: -84.42910 }];   // D32's record, sat on C21
const m2 = { stands: [stand("D32", 33.64010, -84.43010), stand("C21", 33.64110, -84.42910)] };
mergeAptDat(m2, shifted, { proj });
assert(m2.stands[0].operators.join() === "DAL,EDV", "the record went to the stand of the same name");
assert(m2.stands[1].operators.length === 0, "not to the one it happened to sit on");

/* the basemap camera, which the same build step depends on */
const cam = viewToCamera({ cx: 0, cy: 0, scale: 0.55, rot: 0 }, proj);
assert(Math.abs(cameraToScale(cam.zoom, cam.center[1]) - 0.55) < 1e-9, "camera zoom round-trips to the scope scale");
assert(Math.abs(cam.center[0] + 84.4281) < 1e-9 && Math.abs(cam.center[1] - 33.6367) < 1e-9, "camera centre is the view centre");
const north = viewToCamera({ cx: 0, cy: 0, scale: 0.55 }, makeProjection(64.19, -51.68));
assert(north.zoom < cam.zoom, "the same ground scale is a lower zoom further north");
assert(viewToCamera({ cx: 0, cy: 0, scale: 0.55, rot: Math.PI / 2 }, proj).bearing === -90, "rotation becomes bearing");
assert(viewUnchanged({ cx: 1, cy: 2, scale: 0.5, rot: 0 }, { cx: 1, cy: 2, scale: 0.5, rot: 0 }), "an unmoved view is unchanged");
assert(!viewUnchanged({ cx: 1, cy: 2, scale: 0.5 }, { cx: 40, cy: 2, scale: 0.5 }), "a panned view is changed");
assert(!viewUnchanged(null, { cx: 1, cy: 2, scale: 0.5 }), "no previous view is always changed");

/* with no MapLibre present the basemap is inert, never a crash */
let failed = false;
const dead = mountRampBasemap({}, proj, { onFail: () => { failed = true; } });
assert(dead.ok === false && failed, "no MapLibre reports failure rather than throwing");
dead.sync({ cx: 0, cy: 0, scale: 1 });
dead.setVisible(true);
dead.destroy();
assert(true, "and every method on it is a safe no-op");

console.log(`ramp-aptdat: ${passed} assertions passed`);
