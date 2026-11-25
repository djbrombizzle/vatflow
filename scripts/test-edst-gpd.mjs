#!/usr/bin/env node
// Tests for shared/edst-gpd.js (EDST Graphic Plan Display). Run: node scripts/test-edst-gpd.mjs
import {
  pad3, destShort, altLine, line4, alertCells, blockSeverity, zoomForRange, rangeForZoom, roundRange, stepRange,
  scaleNm, pointAlong, pathUpTo, projectPosition, placeBlocks, inAltFilter, graphicFix, graphicRoute, gpdTitle,
  distNm,
} from "../shared/edst-gpd.js";
import { routeTokens, eramRoute } from "../shared/edst-plans.js";

let failed = 0;
function eq(got, want, msg) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL:", msg, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok:", msg);
}
function near(got, want, tol, msg) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) { failed++; console.error("FAIL:", msg, "got", got, "want", want); }
  else console.log("ok:", msg);
}

eq(pad3(80), "080", "pad3");
eq(destShort("KPIT"), "PIT", "US destination drops the K");
eq(destShort("CYYZ"), "CYYZ", "other destinations keep four letters");
eq(destShort(""), "", "no destination");

eq(altLine({ present: 140, assigned: 140 }), "140C", "in conformance: C");
eq(altLine({ present: 139, assigned: 140 }), "140C", "within 200 ft is in conformance");
eq(altLine({ present: 219, assigned: 350 }), "350↑219", "climbing");
eq(altLine({ present: 310, assigned: 240 }), "240↓310", "descending");
eq(altLine({ present: 242, assigned: 350, interim: 290 }), "290T242", "interim: 290T242");
eq(altLine({ present: 219, block: [230, 350] }), "350219", "climbing to a block: upper + present");
eq(altLine({ present: 370, block: [230, 350] }), "230370", "descending to a block: lower + present");
eq(altLine({ present: 300, block: [350, 230] }), "230B350", "inside the block");
eq(altLine({ present: 219.4 }), "219", "nothing assigned: present");

eq(line4({ present: 242, assigned: 350, interim: 290 }), "350", "line 4: FP altitude while climbing to an interim");
eq(line4({ present: 320, assigned: 350, interim: 290 }), "", "line 4: not when above the interim");
eq(line4({ present: 219, block: [230, 350] }), "230B350", "line 4: block while climbing into it");
eq(line4({ present: 300, block: [230, 350] }), "", "line 4: nothing inside the block");
eq(line4({ present: 219, assigned: 350 }), "", "line 4: nothing without interim or block");

eq(alertCells({ r: 1, y: 2, a: 0, rMuted: false }, { y: true }).map((c) => [c.text, c.acked]),
  [["1", false], ["2", true], ["", false]], "line 0 counts and acknowledgement");
eq(alertCells({ status: "S" }).map((c) => c.text), ["S", "S", "S"], "stop probe: brown S in each place");
eq(alertCells(null).map((c) => c.text), ["", "", ""], "no probe entry");
eq(blockSeverity({ r: 1, y: 1 }), "r", "red wins");
eq(blockSeverity({ r: 1, rMuted: true, y: 1 }), "y", "muted red doesn't color the block");
eq(blockSeverity({ r: 1, y: 0 }, { r: true }), "", "acknowledged: white");
eq(blockSeverity({ status: "X" }), "", "not probed: white");

const z = zoomForRange(250, 900, 35);
near(rangeForZoom(z, 900, 35), 250, 0.01, "range <-> zoom round trip");
near(rangeForZoom(z + 1, 900, 35), 125, 0.01, "one zoom level in halves the range");
eq(roundRange(248), 250, "range snaps to a step");
eq(roundRange(137), 135, "range between steps rounds to 5");
eq(stepRange(250, 1), 300, "range out");
eq(stepRange(250, -1), 200, "range in");
eq(stepRange(1000, 1), 1000, "range out stops at 1000");
eq(stepRange(10, -1), 10, "range in stops at 10");
eq(scaleNm(200), 25, "scale for 200 NM: 0-25");
eq(scaleNm(400), 50, "scale for 400 NM: 0-50");
eq(scaleNm(25), 5, "smallest scale");

const path = [[0, 0], [0, 1], [1, 1]];
const p = pointAlong(path, 30);
near(p.lat, 0, 1e-6, "point along: still on the first leg");
near(distNm(0, 0, p.lat, p.lon), 30, 0.2, "point along: 30 NM");
near(p.hdg, 90, 0.5, "point along: track east");
eq(pointAlong(path, 9999).end, true, "past the end: last point");
const up = pathUpTo(path, 75);
near(up[up.length - 1][1], 1, 1e-6, "path up to 75 NM ends just past the corner");
eq(pathUpTo(path, 0), [], "no preview for 0 NM");

const ac = { lat: 0, lon: 0, gs: 600, hdg: 90 };
const f5 = projectPosition(ac, path, 5);
near(distNm(0, 0, f5.lat, f5.lon), 50, 0.3, "future +5 min at 600 kt: 50 NM along the route");
const noRoute = projectPosition(ac, null, 6);
near(noRoute.lon, 1, 0.02, "no route: straight ahead on the heading");
eq(projectPosition({ lat: 1, lon: 2, gs: 10, hdg: 0 }, null, 5), { lat: 1, lon: 2, hdg: 0 }, "slow aircraft stay put");
eq(projectPosition({ lat: 1, lon: 2, gs: 400, hdg: 30 }, null, 0), { lat: 1, lon: 2, hdg: 30 }, "current time: present position");

const pl = placeBlocks([{ x: 100, y: 100, w: 60, h: 40 }, { x: 105, y: 100, w: 60, h: 40 }]);
eq(pl[0].dx > 0 && pl[0].dy < 0, true, "first block goes up and right");
eq(pl[1].dx === pl[0].dx && pl[1].dy === pl[0].dy, false, "second block moves out of the way");
// Aircraft B sits where A's default (up-right) block would go: A's block moves.
const avoid = placeBlocks([{ x: 100, y: 100, w: 60, h: 40 }, { x: 150, y: 70, w: 60, h: 40 }]);
eq(avoid[0].dx > 0 && avoid[0].dy < 0, false, "a block doesn't cover another aircraft's symbol");
const fixed = placeBlocks([{ x: 100, y: 100, w: 60, h: 40 }, { x: 105, y: 100, w: 60, h: 40 }], { auto: false });
eq(fixed[0], fixed[1], "offsetting off: every block in the default place");

eq(inAltFilter(350, 0, 999), true, "altitude filter: inside");
eq(inAltFilter(120, 180, 600), false, "altitude filter: below");
eq(inAltFilter(450, 0, ""), true, "altitude filter: no upper limit");

eq(graphicFix(38.57, -80.67), "3834/08040", "graphic point as an ERAM lat/lon fix");
eq(graphicRoute([[38.57, -80.67], [38.2, -81.5]], "LVL", "SOT LVL AML KIAD"), "3834/08040 3812/08130 LVL AML KIAD",
  "graphic route: points, rejoin fix, rest of the route");
eq(graphicRoute([[38.57, -80.67]], "XYZ", "SOT LVL"), "3834/08040 XYZ", "rejoin fix not on the route");
eq(routeTokens("3834/08040 LVL AML"), ["3834/08040", "LVL", "AML"], "route tokens keep lat/lon fixes");
eq(eramRoute("3834/08040 3812/08130 LVL J14 AML"), "3834/08040..3812/08130..LVL.J14.AML", "ERAM route with lat/lon fixes");

eq(gpdTitle(0), "Graphic Plan Display - Current Time", "title, current time");
eq(gpdTitle(5), "Graphic Plan Display - Future Time +5", "title, future time");

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("all passed");
