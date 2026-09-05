#!/usr/bin/env node
/**
 * Regression tests for unattended FCA crossing freeze / interpolation.
 * Usage: node scripts/test-fca-crossing-track.mjs
 */
import { hasPassedFca, seedAirports } from "../shared/fca-metering.js";
import {
  LOST_MS,
  flightKey,
  interpolateTrackCrossing,
  isTrackableFca,
  processFcaPoll,
} from "../fca-tracker/crossing-track.js";
import { fmtDelta, histogramBins, summarizeCrossings } from "../shared/fca-crossing-store.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} ±${tol})`);
}

seedAirports({
  KMIA: [25.7959, -80.2870],
  KJFK: [40.6413, -73.7781],
});

const FCA_SB = {
  id: "fca_sb",
  name: "SB test",
  enabled: true,
  trackCrossings: true,
  dir: "S",
  artcc: "ZMA",
  points: [[26.5, -82.0], [26.5, -79.5]],
  dests: ["KMIA"],
  origins: [],
  fixes: [],
  minFL: 0,
  maxFL: 999,
  mode: "rate",
  rate: 12,
};

const now0 = Date.parse("2026-09-05T18:00:00Z");

const approaching = {
  callsign: "AAL100",
  cid: 123456,
  logonTime: "2026-09-05T17:00:00Z",
  phase: "air",
  lat: 27.2,
  lon: -80.15,
  hdg: 180,
  gs: 420,
  alt: 28000,
  arr: "KMIA",
  dep: "KJFK",
  route: "DCT",
  tas: 450,
  fpAlt: 28000,
};

const pastSouth = {
  ...approaching,
  callsign: "AAL200",
  cid: 222222,
  logonTime: "2026-09-05T16:00:00Z",
  lat: 26.0,
  lon: -80.15,
  hdg: 185,
};

/* ---- interpolation ---- */
const hit = interpolateTrackCrossing(
  { lat: 27.0, lon: -80.2, t: now0 },
  { lat: 26.0, lon: -80.2, t: now0 + 100000 },
  FCA_SB,
);
assert(!!hit, "straddling north-south segment crosses the 26.5N line");
approx(hit.lat, 26.5, 0.02, "interpolated lat is on the line");
approx(hit.frac, 0.5, 0.03, "halfway in latitude is ~0.5 along the segment");
approx(hit.actualMs, now0 + 50000, 3000, "crossing time is halfway between samples");

assert(
  interpolateTrackCrossing(
    { lat: 27.2, lon: -80.2, t: now0 },
    { lat: 27.0, lon: -80.2, t: now0 + 20000 },
    FCA_SB,
  ) == null,
  "segment entirely north of the line does not cross",
);

/* ---- trackable flag ---- */
assert(isTrackableFca(FCA_SB), "enabled + trackCrossings + points is trackable");
assert(!isTrackableFca({ ...FCA_SB, trackCrossings: false }), "trackCrossings off is not trackable");
assert(!isTrackableFca({ ...FCA_SB, enabled: false }), "disabled is not trackable");
assert(!isTrackableFca({ ...FCA_SB, points: [[26.5, -80]] }), "single point is not trackable");

/* ---- freeze on first sight, no rewrite ---- */
const tracks = new Map();
const done = new Set();
const r1 = processFcaPoll(FCA_SB, [approaching], tracks, done, now0);
assert(r1.upserts.length === 1, "first poll opens one track");
assert(r1.crossings.length === 0, "first poll does not invent a crossing");
const planned0 = r1.upserts[0].planned_at;
assert(planned0 > now0, "frozen planned time is in the future");
assert(r1.upserts[0].planned_from === "air", "airborne freeze tagged air");
assert(flightKey(approaching).includes("AAL100"), "flight key includes callsign");

const closer = { ...approaching, lat: 26.9 };
const r2 = processFcaPoll(FCA_SB, [closer], tracks, done, now0 + 30000);
assert(r2.crossings.length === 0, "still north of the line — no crossing");
assert(r2.upserts.length === 1, "second poll updates the open track");
assert(r2.upserts[0].planned_at === planned0, "second poll does not change planned_at");
assert(r2.upserts[0].last_lat === 26.9, "last position updates");

/* ---- actual crossing on the straddling poll ---- */
const south = { ...approaching, lat: 26.1, hdg: 180 };
const r3 = processFcaPoll(FCA_SB, [south], tracks, done, now0 + 90000);
assert(r3.crossings.length === 1, "straddling poll emits one crossing");
assert(r3.upserts.length === 0, "completed crossing is not left as an open upsert");
assert(!tracks.has(flightKey(approaching)), "track is removed after crossing");
assert(done.has(flightKey(approaching)), "flight key marked completed");
approx(r3.crossings[0].actual_at, now0 + 60000, 15000, "actual time is between last north and first south sample");
assert(r3.crossings[0].delta_sec === Math.round((r3.crossings[0].actual_at - planned0) / 1000),
  "delta_sec is actual − planned");

const r4 = processFcaPoll(FCA_SB, [south], tracks, done, now0 + 120000);
assert(r4.upserts.length === 0 && r4.crossings.length === 0, "completed flight is not re-opened");

/* ---- already past: no freeze, no invented crossing ---- */
const tracks2 = new Map();
const done2 = new Set();
assert(hasPassedFca(pastSouth, FCA_SB), "south of SB FCA heading south = passed");
const rPast = processFcaPoll(FCA_SB, [pastSouth], tracks2, done2, now0);
assert(rPast.upserts.length === 0, "already-passed aircraft does not open a track");
assert(rPast.crossings.length === 0, "hasPassedFca without a prior sample does not emit a crossing");

/* ---- lost timeout ---- */
const tracks3 = new Map();
const done3 = new Set();
processFcaPoll(FCA_SB, [approaching], tracks3, done3, now0);
const rLost = processFcaPoll(FCA_SB, [], tracks3, done3, now0 + LOST_MS);
assert(rLost.lost.length === 1, "silence past LOST_MS marks the track lost");
assert(rLost.lost[0].status === "lost", "lost status written");
assert(rLost.crossings.length === 0, "lost timeout does not invent a crossing");

const rNotLost = processFcaPoll(FCA_SB, [], new Map(tracks3), done3, now0 + LOST_MS - 1000);
assert(rNotLost.lost.length === 0 || tracks3.size === 1, "just inside the timeout stays open");

/* ---- rematch after lost gets a new freeze ---- */
const later = now0 + LOST_MS + 60000;
const rRematch = processFcaPoll(FCA_SB, [approaching], tracks3, done3, later);
assert(rRematch.upserts.length === 1, "return after lost opens a new freeze");
assert(rRematch.upserts[0].planned_at !== planned0, "rematch planned time is not the old freeze");
assert(rRematch.upserts[0].status === "open", "rematch is open again");

/* ---- summary helpers ---- */
const sum = summarizeCrossings([
  { delta_sec: -90 },
  { delta_sec: 30 },
  { delta_sec: 120 },
]);
assert(sum.n === 3, "summarize counts rows");
approx(sum.median, 30, 0.01, "median is the middle delta");
assert(sum.pctEarly > 30 && sum.pctEarly < 40, "one of three is early");
assert(fmtDelta(-90) === "−01:30", "fmtDelta formats early mm:ss");
const bins = histogramBins([{ delta_sec: -60 }, { delta_sec: 0 }, { delta_sec: 0 }]);
assert(bins[19].count === 1, "−1 min bin");
assert(bins[20].count === 2, "0 min bin");

console.log(`ok — ${passed} assertions`);
