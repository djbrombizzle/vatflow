#!/usr/bin/env node
/**
 * Regression: taxi-time estimation behind the CFR ready floor.
 * Usage: node scripts/test-taxi-estimate.mjs
 */
import {
  assignRunway, countQueueAhead, estimateTaxiSec, expandRunwayToken, gcNm,
  medianTaxiSec, normalizeRunway, sidBase, sidFromRoute,
  FALLBACK_TAXI_SEC, MAX_TAXI_SEC, MIN_TAXI_SEC,
} from "../shared/taxi-estimate.js";
import { READY_BUFFER_SEC, readyBufferSec, setTaxiEstimator } from "../shared/fca-metering.js";
import { parseZuluHhmmDetail } from "../shared/time-parse.js";
import { parseOurAirportsRunways } from "../shared/taxi-runways.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);
}

/* ---------- runway id normalization ---------- */
assert(normalizeRunway("RW09L") === "09L", "strips RW prefix");
assert(normalizeRunway("9l") === "09L", "pads and upcases");
assert(normalizeRunway(" 27 ") === "27", "trims");
assert(normalizeRunway("36C") === "36C", "center suffix");
assert(normalizeRunway("37") === "", "rejects runway 37");
assert(normalizeRunway("0") === "", "rejects runway 0");
assert(normalizeRunway("") === "", "rejects empty");
assert(normalizeRunway(null) === "", "rejects null");

assert(expandRunwayToken("08B", []).includes("08L"), "08B expands to 08L");
assert(expandRunwayToken("08B", []).includes("08R"), "08B expands to 08R");
assert(expandRunwayToken("RW09L", []).join() === "09L", "single end token");
assert(expandRunwayToken("ALL", ["27L", "27R"]).join() === "27L,27R", "ALL means active");

/* ---------- SID extraction ---------- */
assert(sidFromRoute("BANNG3 GRITZ HYZMN") === "BANNG3", "leading SID");
assert(sidFromRoute("DEEZZ6.CANDR J60") === "DEEZZ6", "dotted SID");
assert(sidFromRoute("KATL DCT SPA") === null, "no SID in a direct route");
assert(sidFromRoute("") === null, "empty route");

assert(sidBase("BANNG3") === "BANNG", "strips the revision digit");
assert(sidBase("DEEZZ6") === "DEEZZ", "strips a six");
assert(sidBase("HOBTT2") === "HOBTT", "strips a two");
assert(sidBase("SKORR4A") === "SKORR", "strips digit plus letter");
assert(sidBase("BANNG") === "BANNG", "already a base name is unchanged");
assert(sidBase(" banng3 ") === "BANNG", "trims and upcases");
assert(sidBase("") === "", "empty stays empty");

/* ---------- geometry sanity ---------- */
near(gcNm(33.6367, -84.4281, 33.6367, -84.3281), 5.0, 0.2, "1 deg lon at 33N ≈ 50 nm/10");

/* KATL-ish: 09L/27R thresholds either end of the field. */
const ATL_ENDS = [
  { id: "09L", lat: 33.6470, lon: -84.4400, hdg: 93 },
  { id: "27R", lat: 33.6440, lon: -84.4000, hdg: 273 },
  { id: "10",  lat: 33.6200, lon: -84.4400, hdg: 93 },
  { id: "28",  lat: 33.6180, lon: -84.4000, hdg: 273 },
];
const ATL_SIDS = { BANNG3: ["09L", "09R", "10", "27B", "28"], SKORR6: [] };

/* ---------- runway assignment precedence ---------- */
{
  const gate = { lat: 33.6420, lon: -84.4300 };
  const a = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS, override: "28" });
  assert(a.source === "override" && a.runway === "28", "override beats everything");

  const b = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS, sidRules: { BANNG3: "10" } });
  assert(b.source === "rule" && b.runway === "10", "SID rule beats the published set");

  /* Rules are keyed on the base name so a chart revision does not drop them. */
  const rev = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS, sidRules: { BANNG: "10" } });
  assert(rev.source === "rule" && rev.runway === "10", "base-name rule binds a revised SID");

  const nextRev = assignRunway({ ...gate, sid: "BANNG7", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS, sidRules: { BANNG: "10" } });
  assert(nextRev.runway === "10", "base-name rule survives a future revision");

  /* A pinned runway applies even when it is not in the SID's published set. */
  const offPlate = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L"], sidRunways: ATL_SIDS, sidRules: { BANNG: "28" } });
  assert(offPlate.runway === "28", "an explicit rule is not second-guessed");

  const c = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L"], sidRunways: ATL_SIDS });
  assert(c.source === "sid" && c.runway === "09L", "one survivor from the SID set");

  const d = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS });
  assert(d.source === "sid-nearest", "several survivors fall to nearest");
  assert(d.candidates.length === 2, "both survivors reported");

  const e = assignRunway({ ...gate, sid: "SKORR6", ends: ATL_ENDS,
    activeRunways: ["09L", "10"], sidRunways: ATL_SIDS });
  assert(e.source === "nearest", "SID with no runway transitions falls to nearest");

  const f = assignRunway({ ...gate, sid: "BANNG3", ends: ATL_ENDS,
    activeRunways: ["27R"], sidRunways: ATL_SIDS });
  assert(f.runway === "27R", "27B in the SID set covers active 27R");

  const g = assignRunway({ lat: 33.62, lon: -84.44, ends: [], activeRunways: [] });
  assert(g.source === "none" && g.runway === "", "no data yields no runway, not a throw");
}

/* ---------- the estimate itself ---------- */
{
  const gate = { lat: 33.6420, lon: -84.4300, gs: 0 };
  const base = { ...gate, sid: "BANNG3", ends: ATL_ENDS, sidRunways: ATL_SIDS,
    config: { activeRunways: ["09L"] } };

  const r = estimateTaxiSec(base);
  assert(r.tier === "geometric", "no samples means geometric");
  assert(r.runway === "09L", "assigned runway reported");
  assert(r.sec > MIN_TAXI_SEC, "a real taxi beats the floor");
  assert(r.parts.spoolSec === 90, "parked aircraft pays spool");

  /* Already rolling: no pushback left to pay for. */
  const rolling = estimateTaxiSec({ ...base, gs: 15 });
  assert(rolling.parts.spoolSec === 0, "moving aircraft skips spool");
  assert(rolling.sec < r.sec, "moving aircraft is closer to the runway in time");

  /* Distance matters — the far end of the field is a longer taxi. */
  const nearEnd = estimateTaxiSec({ ...base, lat: 33.6465, lon: -84.4395 });
  const farEnd = estimateTaxiSec({ ...base, lat: 33.6185, lon: -84.4005 });
  assert(farEnd.sec > nearEnd.sec, "farther gate estimates a longer taxi");
  assert(nearEnd.sec === MIN_TAXI_SEC, "holding short still clamps to the floor");
}

/* ---------- blending toward observed data ---------- */
{
  const base = {
    lat: 33.6420, lon: -84.4300, gs: 0, sid: "BANNG3",
    ends: ATL_ENDS, sidRunways: ATL_SIDS, config: { activeRunways: ["09L"] },
  };
  const geo = estimateTaxiSec(base).sec;

  const few = estimateTaxiSec({ ...base, medianSec: 900, sampleCount: 1 });
  const many = estimateTaxiSec({ ...base, medianSec: 900, sampleCount: 200 });
  assert(few.tier === "blended" && many.tier === "blended", "both blend");
  assert(few.sec > geo, "one sample nudges toward the observed median");
  assert(many.sec > few.sec, "more samples pull further toward observed");
  assert(many.sec > 900, "a heavy sample count lands near the observed median");

  const observedOnly = estimateTaxiSec({
    lat: 33.64, lon: -84.43, medianSec: 600, sampleCount: 20, config: {},
  });
  assert(observedOnly.tier === "observed", "no runway geometry means observed only");
}

/* ---------- queue ---------- */
{
  const base = {
    lat: 33.6420, lon: -84.4300, gs: 0, sid: "BANNG3",
    ends: ATL_ENDS, sidRunways: ATL_SIDS, config: { activeRunways: ["09L"] },
  };
  const alone = estimateTaxiSec(base);
  const behindOne = estimateTaxiSec({ ...base, queueAhead: 1 });
  assert(behindOne.sec === alone.sec, "a single aircraft ahead does not bind");

  const behindTen = estimateTaxiSec({ ...base, queueAhead: 10 });
  assert(behindTen.sec === 900, "ten ahead at 90 s each binds the estimate");
  assert(behindTen.parts.queueSec === 900, "queue component reported");
}

/* ---------- clamps and degradation ---------- */
{
  const nothing = estimateTaxiSec({});
  assert(nothing.tier === "fallback", "empty input falls back");
  assert(nothing.sec === FALLBACK_TAXI_SEC, "fallback matches the old flat buffer");

  const absurd = estimateTaxiSec({ queueAhead: 1000, config: {} });
  assert(absurd.sec === MAX_TAXI_SEC, "runaway queue clamps");

  const junk = estimateTaxiSec({ lat: NaN, lon: NaN, ends: ATL_ENDS, config: {} });
  assert(isFinite(junk.sec) && junk.sec >= MIN_TAXI_SEC, "NaN position degrades safely");
}

/* ---------- median of observed samples ---------- */
{
  const now = Date.UTC(2026, 7, 14, 18, 0, 0);
  const mk = (airport, mins, ageMs = 0) =>
    ({ airport, durationMs: mins * 60000, endMs: now - ageMs });
  const samples = [
    mk("KATL", 10), mk("KATL", 12), mk("KATL", 14),
    mk("KATL", 90),                                  // parked on a taxiway
    mk("KDCA", 4),
    mk("KATL", 11, 30 * 24 * 3600 * 1000),           // a month old
  ];
  const atl = medianTaxiSec(samples, "KATL", { nowMs: now });
  assert(atl.sampleCount === 4, "stale sample excluded");
  assert(atl.medianSec === 780, "median shrugs off the 90-minute outlier");

  const none = medianTaxiSec(samples, "KSFO", { nowMs: now });
  assert(none.medianSec === null && none.sampleCount === 0, "unknown field has no median");
}

/* ---------- queue counting ---------- */
{
  const pilots = [
    { callsign: "AAL1", dep: "KATL", gs: 0 },                    // parked, unissued
    { callsign: "DAL2", dep: "KATL", gs: 12 },                   // taxiing
    { callsign: "DAL3", dep: "KATL", gs: 0, releaseMs: 1000 },   // issued earlier
    { callsign: "DAL4", dep: "KATL", gs: 0, releaseMs: 9000 },   // issued later
    { callsign: "UAL5", dep: "KATL", gs: 140 },                  // airborne
    { callsign: "SWA6", dep: "KDCA", gs: 15 },                   // another field
    { callsign: "ME",   dep: "KATL", gs: 0 },
  ];
  const n = countQueueAhead({
    callsign: "ME", airport: "KATL", pilots, myReleaseMs: 5000,
  });
  assert(n === 2, "taxiing + earlier release count; parked, later, airborne, other field do not");

  const noRelease = countQueueAhead({ callsign: "ME", airport: "KATL", pilots });
  assert(noRelease === 3, "with no release of my own, every issued aircraft is ahead");
}

/* ---------- queue position respects distance to the runway ---------- */
{
  const pilots = [
    { callsign: "AHEAD",  dep: "KATL", gs: 10, runway: "27R", distNm: 0.3 },
    { callsign: "BEHIND", dep: "KATL", gs: 10, runway: "27R", distNm: 2.4 },
    { callsign: "OTHER",  dep: "KATL", gs: 10, runway: "09L", distNm: 0.2 },
    { callsign: "PARKED", dep: "KATL", gs: 0,  runway: "27R", distNm: 0.1 },
  ];
  const mid = countQueueAhead({
    callsign: "ME", airport: "KATL", runway: "27R", myDistNm: 1.0, pilots,
  });
  assert(mid === 1, "only the mover closer to the runway is ahead");

  const atGate = countQueueAhead({
    callsign: "ME", airport: "KATL", runway: "27R", myDistNm: 3.0, pilots,
  });
  assert(atGate === 2, "from the gate both movers on my runway are ahead");

  const unknown = countQueueAhead({
    callsign: "ME", airport: "KATL", runway: "27R", pilots,
  });
  assert(unknown === 2, "unknown position counts every mover — the safe answer");

  /* A release outranks distance: an issued aircraft still at the gate is ahead. */
  const issuedBehind = countQueueAhead({
    callsign: "ME", airport: "KATL", runway: "27R", myDistNm: 0.1,
    myReleaseMs: 5000,
    pilots: [...pilots, { callsign: "ISSUED", dep: "KATL", gs: 0, runway: "27R", distNm: 9, releaseMs: 1000 }],
  });
  assert(issuedBehind === 1, "an earlier release counts regardless of distance");
}

/* ---------- the CFR engine hook ---------- */
{
  const p = { callsign: "AAL1" };
  assert(readyBufferSec(p, Date.now()) === READY_BUFFER_SEC, "no estimator means the old flat buffer");

  setTaxiEstimator(() => 720);
  assert(readyBufferSec(p, Date.now()) === 720, "installed estimator is used");

  setTaxiEstimator(() => { throw new Error("boom"); });
  assert(readyBufferSec(p, Date.now()) === READY_BUFFER_SEC, "a throwing estimator falls back");

  setTaxiEstimator(() => null);
  assert(readyBufferSec(p, Date.now()) === READY_BUFFER_SEC, "an unestimatable aircraft falls back");

  setTaxiEstimator(() => -5);
  assert(readyBufferSec(p, Date.now()) === READY_BUFFER_SEC, "a nonsense estimate falls back");

  setTaxiEstimator(null);
  assert(readyBufferSec(p, Date.now()) === READY_BUFFER_SEC, "uninstalling restores the buffer");
}

/* ---------- OurAirports parsing ---------- */
{
  const header = "id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed," +
    "le_ident,le_latitude_deg,le_longitude_deg,le_elevation_ft,le_heading_degT,le_displaced_threshold_ft," +
    "he_ident,he_latitude_deg,he_longitude_deg,he_elevation_ft,he_heading_degT,he_displaced_threshold_ft";
  const csv = [
    header,
    '1,3682,"KATL",12390,150,"ASP",1,0,"09L",33.6470,-84.4400,1000,93,0,"27R",33.6440,-84.4000,1000,273,0',
    '2,3682,"KATL",9000,150,"ASP",1,1,"08L",33.6500,-84.4400,1000,93,0,"26R",33.6470,-84.4000,1000,273,0',
    '3,3521,"KDCA",7169,150,"ASP",1,0,"01",38.8400,-77.0400,15,11,0,"19",38.8600,-77.0350,15,191,0',
  ].join("\n");

  const atl = parseOurAirportsRunways(csv, "KATL");
  assert(atl.length === 2, "closed runway excluded, both ends of the open one kept");
  assert(atl.map(e => e.id).sort().join() === "09L,27R", "ends identified");
  assert(atl[0].lenFt === 12390, "length carried through");
  assert(Math.abs(atl[0].lat - 33.6470) < 1e-6, "threshold latitude parsed");

  const dca = parseOurAirportsRunways(csv, "KDCA");
  assert(dca.length === 2 && dca[0].id === "01", "other fields not mixed in");
  assert(parseOurAirportsRunways(csv, "KSFO").length === 0, "unknown field yields nothing");
}

/* ---------- prefill round-trip ----------
   IDST writes the estimate into ART as HHMM. That text has to survive being
   read back a render later: parseZuluHhmm rejects anything more than a minute
   in the past, and a rejected ART blocks the RDY press outright. */
{
  /* Mirrors suggestedArt() in idst.html — ceil to the next whole minute. */
  const artText = (nowMs, sec) => {
    const d = new Date(Math.ceil((nowMs + sec * 1000) / 60000) * 60000);
    return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0");
  };

  /* Every second of a minute, at the tightest estimate, after a full refresh
     interval of staleness — the worst case a controller can actually hit. */
  const STALE_MS = 30000;
  for (let offset = 0; offset < 60; offset++) {
    const now = Date.UTC(2026, 7, 14, 18, 30, offset);
    const text = artText(now, MIN_TAXI_SEC);
    const read = parseZuluHhmmDetail(text, now + STALE_MS);
    assert(read.ms != null, `prefill at +${offset}s still parses ${STALE_MS / 1000}s later (got ${read.reason})`);
    assert(read.ms >= now + STALE_MS - 60000, `prefill at +${offset}s is not stale-past`);
  }

  /* Rolls over the hour and the day without becoming "yesterday". */
  const beforeMidnight = Date.UTC(2026, 7, 14, 23, 58, 30);
  const wrapped = parseZuluHhmmDetail(artText(beforeMidnight, 300), beforeMidnight);
  assert(wrapped.ms != null, "prefill across midnight parses");
  assert(wrapped.ms > beforeMidnight, "prefill across midnight lands tomorrow, not yesterday");

  const beforeHour = Date.UTC(2026, 7, 14, 18, 59, 45);
  const overHour = parseZuluHhmmDetail(artText(beforeHour, 300), beforeHour);
  assert(overHour.ms != null && overHour.ms > beforeHour, "prefill across the hour parses forward");
}

console.log(`OK ${passed} assertions`);
