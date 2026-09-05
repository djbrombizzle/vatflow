#!/usr/bin/env node
/**
 * Regression tests for GS -> IAS reverse interpolation.
 * Usage: node scripts/test-climb-profile.mjs
 *
 * The synthetic climbs below fly a known IAS/Mach schedule through a known
 * wind. We generate the ground speed a pilot flying that schedule would report
 * to VATSIM, feed only that back in, and check the original IAS comes out.
 */
import {
  ALT_BANDS,
  aggregateCurve,
  bandFor,
  buildSample,
  casToTas,
  crossoverBand,
  groundToTrueAirspeed,
  machToTas,
  median,
  normalizeAircraftType,
  percentile,
  pilotAircraftType,
  reduceFlight,
  speedOfSoundKt,
  tasToCas,
  tasToMach,
} from "../shared/climb-profile.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function approx(a, b, tol, msg) {
  assert(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} +/-${tol})`);
}

/* ============================================================
   ATMOSPHERE
   ============================================================ */
approx(speedOfSoundKt(0), 661.48, 0.1, "speed of sound at MSL ISA");
approx(speedOfSoundKt(36089), 573.6, 1.0, "speed of sound at the tropopause");

// Standard-day book values: 250 KIAS at FL100 is about 290 KTAS.
approx(casToTas(250, 10000), 290, 3, "250 KIAS at FL100 -> ~290 KTAS");
// 300 KIAS at FL300 is about 480 KTAS.
approx(casToTas(300, 30000), 466, 3, "300 KIAS at FL300 -> ~466 KTAS (M.79)");
approx(tasToMach(466, 30000), 0.79, 0.01, "300 KIAS at FL300 is about M.79");

// Round trip must close everywhere we care about.
for (const alt of [1500, 10000, 18000, 24000, 30000, 38000]) {
  for (const cas of [200, 250, 300, 340]) {
    approx(tasToCas(casToTas(cas, alt), alt), cas, 0.01, `CAS round trip ${cas}@${alt}`);
  }
}

// The incompressible shortcut is not good enough for this question: at FL300
// it understates IAS by enough to blur 280 against 300.
const tasAt300 = casToTas(300, 30000);
const easShortcut = tasAt300 * Math.sqrt(Math.pow((288.15 - 0.0019812 * 30000) / 288.15, 4.2561));
assert(Math.abs(easShortcut - 300) > 4,
  `EAS shortcut is off by more than 4 kt at FL300 (got ${easShortcut.toFixed(1)})`);

/* ---- measured error sensitivity, so the budget cannot drift unnoticed ---- */
for (const [alt, dCasPer10kt, dCasPer10C] of [
  [20000, 7.89, -6.15],
  [30000, 7.07, -6.94],
  [35000, 6.73, -7.44],
]) {
  const tas = casToTas(300, alt);
  approx(tasToCas(tas + 10, alt) - 300, dCasPer10kt, 0.1,
    `10 kt of TAS error at FL${alt / 100} costs ${dCasPer10kt} kt of IAS`);
  approx(tasToCas(casToTas(300, alt, 0), alt, 10) - 300, dCasPer10C, 0.1,
    `10 C of temperature error at FL${alt / 100} costs ${dCasPer10C} kt of IAS`);
}

/* ============================================================
   WIND TRIANGLE
   ============================================================ */
// Pure headwind: 450 TAS into a 50 kt head is 400 over the ground.
approx(groundToTrueAirspeed(400, 90, 90, 50), 450, 0.01, "headwind adds back to TAS");
approx(groundToTrueAirspeed(500, 90, 270, 50), 450, 0.01, "tailwind subtracts from TAS");

// Pure crosswind: a headwind-component model would report TAS = GS here and be
// wrong by 5 kt. The vector form recovers it.
const crossGs = 450;
const crossTas = groundToTrueAirspeed(crossGs, 0, 90, 70);
assert(crossTas > crossGs + 4, `crosswind raises TAS above GS (got ${crossTas.toFixed(1)})`);
approx(crossTas, Math.hypot(70, 450 - 0) - 0, 12, "crosswind solution is in range");

// Vertical component is small but real.
approx(groundToTrueAirspeed(300, 0, null, null, 2500), Math.hypot(300, 2500 / 101.269), 0.01,
  "vertical speed folds into TAS");

/* ============================================================
   SYNTHETIC CLIMB
   ============================================================ */
/**
 * Fly a known schedule and emit the position reports VATSIM would carry.
 * Returns raw {t, lat, lon, alt, gs, hdg} samples -- nothing derived.
 */
function flyClimb({
  iasBelow10k = 250,
  iasClimb = 300,
  mach = 0.78,
  fpmLow = 2200,
  fpmHigh = 1600,
  cruiseAlt = 36000,
  windDir = null,
  windSpd = null,
  track = 90,
  dtSec = 15,
  startLat = 39.0,
  startLon = -104.0,
  isaDevC = 0,
} = {}) {
  const out = [];
  let alt = 1500, lat = startLat, lon = startLon, t = Date.UTC(2026, 0, 1, 12, 0, 0);
  while (alt < cruiseAlt && out.length < 400) {
    const targetIas = alt < 10000 ? iasBelow10k : iasClimb;
    const tasFromIas = casToTas(targetIas, alt, isaDevC);
    const tasFromMach = machToTas(mach, alt, isaDevC);
    // Real climbs hold IAS, then Mach caps it -- whichever is slower governs.
    const tas = Math.min(tasFromIas, tasFromMach);
    const vs = alt < 10000 ? fpmLow : fpmHigh;

    // TAS is along the flight path, so only its horizontal component
    // combines with the wind to make ground speed.
    const vertKt = vs / 101.269;
    const horizTas = Math.sqrt(Math.max(0, tas * tas - vertKt * vertKt));
    const trk = track * Math.PI / 180;
    let gN = horizTas * Math.cos(trk), gE = horizTas * Math.sin(trk);
    if (windSpd != null) {
      const from = windDir * Math.PI / 180;
      gN += -windSpd * Math.cos(from);
      gE += -windSpd * Math.sin(from);
    }
    const gs = Math.hypot(gN, gE);
    const groundTrack = (Math.atan2(gE, gN) * 180 / Math.PI + 360) % 360;

    out.push({ t, lat, lon, alt, gs: Math.round(gs), hdg: Math.round(track) });

    // Advance along the ground track.
    const distNm = gs * (dtSec / 3600);
    const brg = groundTrack * Math.PI / 180;
    lat += (distNm * Math.cos(brg)) / 60;
    lon += (distNm * Math.sin(brg)) / (60 * Math.cos(lat * Math.PI / 180));
    alt += vs * (dtSec / 60);
    t += dtSec * 1000;
  }
  return out;
}

/** Run raw samples through the pipeline with a stated wind. */
function analyse(raw, wind, isaDevC = 0) {
  const samples = [];
  for (let i = 1; i < raw.length; i++) {
    samples.push(buildSample(raw[i - 1], raw[i], wind, isaDevC));
  }
  return { samples, flight: reduceFlight(samples) };
}

/* ---- still air: the chain must be near-exact ---- */
{
  const raw = flyClimb({ iasClimb: 300, mach: 0.78, windSpd: null });
  const { samples, flight } = analyse(raw, null);
  const accepted = samples.filter(s => s.ok).length;
  assert(accepted > 60, `still-air climb yields samples (got ${accepted})`);
  approx(flight.bands["1500_10000"].iasKt, 250, 1.5, "recovers 250 KIAS below 10k");
  approx(flight.bands["10000_18000"].iasKt, 300, 1.5, "recovers 300 KIAS at 10k-FL180");
  approx(flight.bands["18000_24000"].iasKt, 300, 1.5, "recovers 300 KIAS at FL180-240");
  assert(!flight.exceeded250Below10k, "250 KIAS is not flagged as a bust");
}

/* ---- strong wind, correctly modelled: still near-exact ---- */
{
  const raw = flyClimb({ iasClimb: 290, mach: 0.78, windDir: 250, windSpd: 85, track: 70 });
  const wind = { dirDeg: 250, spdKt: 85 };
  const { flight } = analyse(raw, wind);
  approx(flight.bands["10000_18000"].iasKt, 290, 2, "recovers 290 KIAS through an 85 kt wind");
  approx(flight.bands["18000_24000"].iasKt, 290, 2, "wind correction holds at FL180-240");
}

/* ---- wind ignored: shows the cost of getting wind wrong ---- */
{
  const raw = flyClimb({ iasClimb: 290, mach: 0.78, windDir: 270, windSpd: 60, track: 90 });
  const { flight } = analyse(raw, null);   // pretend still air
  const err = Math.abs(flight.bands["18000_24000"].iasKt - 290);
  assert(err > 15, `ignoring a 60 kt headwind costs real accuracy (got ${err.toFixed(1)} kt)`);
}

/* ---- wind off by 10 kt: the error the budget predicts ---- */
{
  const raw = flyClimb({ iasClimb: 300, mach: 0.80, windDir: 270, windSpd: 70, track: 90 });
  const { flight } = analyse(raw, { dirDeg: 270, spdKt: 60 });  // 10 kt short
  const err = Math.abs(flight.bands["24000_30000"].iasKt - 300);
  // Wind error passes through damped, but only to about 0.7 -- compressibility
  // makes the damping weaker than the sqrt(sigma) of the incompressible case.
  assert(err < 9, `a 10 kt wind error stays under 9 kt of IAS error (got ${err.toFixed(1)})`);
  assert(err > 5, `a 10 kt wind error is not damped away (got ${err.toFixed(1)})`);
}

/* ---- ISA deviation: the systematic error that will not average out ---- */
{
  const raw = flyClimb({ iasClimb: 300, mach: 0.78, isaDevC: 12 });
  const { flight } = analyse(raw, null, 0);   // analysed as if standard day
  const err = Math.abs(flight.bands["18000_24000"].iasKt - 300);
  assert(err < 10, `a 12 C temperature error stays under 10 kt (got ${err.toFixed(1)})`);
  assert(err > 4, `a 12 C temperature error is not negligible (got ${err.toFixed(1)})`);
}

/* ---- Mach crossover shows up as a kink, and is read off the curve ---- */
{
  const raw = flyClimb({ iasClimb: 320, mach: 0.76, cruiseAlt: 38000 });
  const { flight } = analyse(raw, null);
  const low = flight.bands["10000_18000"].iasKt;
  const high = flight.bands["30000_45000"].iasKt;
  assert(high < low - 15,
    `IAS bleeds off above crossover (${low.toFixed(0)} -> ${high.toFixed(0)})`);
  approx(flight.bands["30000_45000"].mach, 0.76, 0.01, "Mach segment holds M.76");
  const kink = crossoverBand(flight);
  assert(kink === "24000_30000" || kink === "30000_45000", `crossover band found (got ${kink})`);
}

/* ---- a low-cruise flight never reaches the Mach segment ---- */
{
  const raw = flyClimb({ iasClimb: 280, mach: 0.78, cruiseAlt: 21000 });
  const { flight } = analyse(raw, null);
  approx(flight.bands["18000_24000"].iasKt, 280, 2, "recovers 280 KIAS below the crossover");
  assert(!flight.bands["30000_45000"], "no samples above the aircraft's cruise");
  assert(crossoverBand(flight) === null, "no crossover on a FL210 flight");
}

/* ---- a 250 bust below 10k is caught ---- */
{
  const raw = flyClimb({ iasBelow10k: 290 });
  const { flight } = analyse(raw, null);
  assert(flight.exceeded250Below10k, "290 KIAS below 10k is flagged");
}

/* ============================================================
   QUALITY GATES
   ============================================================ */
// 300 kt for 15 s is 1.25 nm, which at 39N is 0.0268 degrees of longitude.
// The fixture has to be self-consistent or the warp gate fires first and
// masks whichever gate the case is actually testing.
const base = { t: 1000, lat: 39, lon: -104, alt: 12000, gs: 300, hdg: 90 };
function step(over = {}) {
  return { t: 16000, lat: 39, lon: -103.9732, alt: 12500, gs: 300, hdg: 90, ...over };
}
assert(buildSample(base, step({ t: 3000 })).reason === "dt_short", "rejects a too-short interval");
assert(buildSample(base, step({ t: 90000 })).reason === "dt_long", "rejects a stale interval");
assert(buildSample(base, step({ gs: 40 })).reason === "slow", "rejects taxi speeds");
assert(buildSample(base, step({ alt: 12010 })).reason === "not_climbing", "rejects level flight");
// A warp: the aircraft covered far more ground than 300 kt allows.
assert(buildSample(base, step({ lon: -102.0 })).reason === "gs_disagree",
  "rejects a position warp");
// Time acceleration looks the same way: reported GS cannot explain the distance.
assert(buildSample(base, step({ lon: -103.7, gs: 300 })).reason === "gs_disagree",
  "rejects sim-rate acceleration");
assert(buildSample(base, step()).ok, "accepts a clean climbing pair");

/* ============================================================
   TYPE NORMALIZATION
   ============================================================ */
assert(normalizeAircraftType("B738") === "B738", "plain designator");
assert(normalizeAircraftType("b738") === "B738", "lowercase");
assert(normalizeAircraftType("H/B77W/L") === "B77W", "wake prefix and equipment suffix");
assert(normalizeAircraftType("B738/L") === "B738", "equipment suffix");
assert(normalizeAircraftType("1/B738/L") === "B738", "equipment-count prefix");
assert(normalizeAircraftType("  A320 ") === "A320", "surrounding whitespace");
assert(normalizeAircraftType("C172") === "C172", "light single");
assert(normalizeAircraftType("ZZZZ") === "", "ZZZZ is not a type");
assert(normalizeAircraftType("") === "", "blank is not a type");
assert(normalizeAircraftType("B7378MAX") === "", "overlong junk rejected");
assert(pilotAircraftType({ flight_plan: { aircraft_short: "B738" } }) === "B738",
  "reads aircraft_short");
assert(pilotAircraftType({ flight_plan: { aircraft_faa: "H/B77W/L" } }) === "B77W",
  "falls back to aircraft_faa");
assert(pilotAircraftType({ flight_plan: { aircraft_short: "ZZZZ", aircraft_faa: "A320/L" } }) === "A320",
  "falls through a junk aircraft_short");
assert(pilotAircraftType({}) === "", "no flight plan yields no type");

/* ============================================================
   AGGREGATION -- one flight, one vote
   ============================================================ */
approx(median([1, 2, 3]), 2, 0.001, "odd-length median");
approx(median([1, 2, 3, 4]), 2.5, 0.001, "even-length median");
approx(percentile([1, 2, 3, 4, 5], 0.25), 2, 0.001, "p25");
approx(percentile([1, 2, 3, 4, 5], 0.75), 4, 0.001, "p75");

{
  // Two fast climbers and one slow one flying a different speed. At a fixed
  // poll rate the slow aircraft contributes far more samples, so pooling raw
  // samples would pull the answer toward it. Per-flight medians must not.
  const fast1 = analyse(flyClimb({ iasClimb: 300, fpmHigh: 2400 }), null).flight;
  const fast2 = analyse(flyClimb({ iasClimb: 300, fpmHigh: 2400 }), null).flight;
  const slow = analyse(flyClimb({ iasClimb: 260, fpmHigh: 700 }), null).flight;
  assert(slow.bands["18000_24000"].n > fast1.bands["18000_24000"].n * 2,
    "the slow climber really does contribute more samples");

  const curve = aggregateCurve([fast1, fast2, slow]);
  assert(curve.n === 3, "three flights aggregated");
  approx(curve.bands["18000_24000"].iasMedian, 300, 2,
    "median follows the majority of flights, not the majority of samples");
  // p25 of three flights interpolates between the slow one and the pair.
  approx(curve.bands["18000_24000"].iasP25, 280, 3, "p25 is pulled down by the slow climber");
  approx(curve.bands["18000_24000"].iasP75, 300, 2, "p75 shows the fast pair");
  assert(curve.bands["18000_24000"].n === 3, "every flight votes in the band");
}

/* ---- banding ---- */
assert(bandFor(500) === null, "below the first band");
assert(bandFor(5000) === "1500_10000", "low band");
assert(bandFor(10000) === "10000_18000", "band edges are lower-inclusive");
assert(bandFor(35000) === "30000_45000", "high band");
assert(ALT_BANDS.length === 5, "five bands from climb to cruise");

console.log(`ok — ${passed} assertions`);
