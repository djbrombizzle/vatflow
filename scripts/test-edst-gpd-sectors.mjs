#!/usr/bin/env node
import {
  filterSectorsByArtcc,
  sectorArtccKey,
} from "../shared/edst-gpd-map.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

assert(sectorArtccKey("KZJX") === "ZJX", "strip leading K");
assert(sectorArtccKey("ZJX") === "ZJX", "plain ZJX");

const gj = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { artcc: "ZJX", id: "ZJX15" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { type: "Feature", properties: { artcc: "ZTL", id: "ZTL20" }, geometry: { type: "Polygon", coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
    { type: "Feature", properties: { artcc: "KZJX", id: "ZJX10" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  ],
};
const zjx = filterSectorsByArtcc(gj, "KZJX");
assert(zjx.length === 2, "filter keeps ZJX (+ KZJX) only");
assert(zjx.every(f => /ZJX/.test(f.properties.id)), "filtered ids are ZJX");
assert(filterSectorsByArtcc(gj, "ZMA").length === 0, "other ARTCC empty");
assert(filterSectorsByArtcc(null, "ZJX").length === 0, "null geojson safe");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
