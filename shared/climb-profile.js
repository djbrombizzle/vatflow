/**
 * Reverse-interpolate pilot IAS from VATSIM ground speed.
 *
 * The feed gives ground speed; pilots fly indicated airspeed. The chain back is
 *
 *   GS -> (subtract wind vector) -> TAS -> (density + compressibility) -> CAS ~ IAS
 *
 * and it is better conditioned than it looks: the feed's altitude is already
 * pressure altitude, which is exactly what the CAS conversion wants, and CAS
 * error scales as TAS error times sqrt(sigma), so a 10 kt wind error at FL300
 * lands as roughly 6 kt of IAS error.
 *
 * Everything here is pure: samples in, per-flight profile out. No fetching.
 */

/* ---- ISA / atmosphere ---- */
const T0_K = 288.15;          // MSL standard temperature
const P0_HPA = 1013.25;       // MSL standard pressure
const T_TROP_K = 216.65;      // tropopause temperature
const FT_TROP = 36089.24;     // tropopause altitude
const A0_KT = 661.4788;       // speed of sound at MSL ISA
const LAPSE_K_PER_FT = 0.0019812;
const GAMMA_EXP = 5.25588;    // g/(lapse*R) for the pressure ratio
const STRAT_DELTA_TROP = 0.223360;
const STRAT_SCALE_FT = 20805.7; // stratosphere pressure scale height
const KT_PER_FPM = 1 / 101.269; // fpm -> kt

/** Standard temperature ratio at a pressure altitude. */
export function isaThetaAt(altFt) {
  const ft = Number(altFt) || 0;
  if (ft >= FT_TROP) return T_TROP_K / T0_K;
  return (T0_K - LAPSE_K_PER_FT * ft) / T0_K;
}

/** Standard pressure ratio p/p0 at a pressure altitude. */
export function isaDeltaAt(altFt) {
  const ft = Number(altFt) || 0;
  if (ft >= FT_TROP) return STRAT_DELTA_TROP * Math.exp(-(ft - FT_TROP) / STRAT_SCALE_FT);
  return Math.pow(isaThetaAt(ft), GAMMA_EXP);
}

/**
 * Static air temperature (K). isaDevC shifts the whole column off standard;
 * it is the dominant systematic error in the chain, so it is an explicit
 * input rather than an assumption buried in the math.
 */
export function temperatureK(altFt, isaDevC = 0) {
  return isaThetaAt(altFt) * T0_K + (Number(isaDevC) || 0);
}

/** Local speed of sound (kt). */
export function speedOfSoundKt(altFt, isaDevC = 0) {
  return A0_KT * Math.sqrt(Math.max(temperatureK(altFt, isaDevC), 1) / T0_K);
}

/** Mach from true airspeed. */
export function tasToMach(tasKt, altFt, isaDevC = 0) {
  const a = speedOfSoundKt(altFt, isaDevC);
  return a > 0 ? Math.max(0, Number(tasKt) || 0) / a : 0;
}

/**
 * Calibrated airspeed from true airspeed, full compressible form.
 *
 * The incompressible EAS shortcut (TAS * sqrt(sigma)) is off by 5-8 kt at
 * FL300/M.78 -- enough to blur 280 KIAS against 300 KIAS, which is the whole
 * question here -- so this uses the real impact-pressure relation:
 *
 *   qc/p = (1 + 0.2 M^2)^3.5 - 1
 *   CAS  = a0 * sqrt( 5 * ((qc/p * delta + 1)^(2/7) - 1) )
 */
export function tasToCas(tasKt, altFt, isaDevC = 0) {
  const tas = Math.max(0, Number(tasKt) || 0);
  if (tas <= 0) return 0;
  const mach = tasToMach(tas, altFt, isaDevC);
  const delta = isaDeltaAt(altFt);
  const qcOverP = Math.pow(1 + 0.2 * mach * mach, 3.5) - 1;
  const inner = Math.pow(qcOverP * delta + 1, 2 / 7) - 1;
  return A0_KT * Math.sqrt(Math.max(0, 5 * inner));
}

/** Inverse of tasToCas -- used to build synthetic climbs and to check the fit. */
export function casToTas(casKt, altFt, isaDevC = 0) {
  const cas = Math.max(0, Number(casKt) || 0);
  if (cas <= 0) return 0;
  const delta = isaDeltaAt(altFt);
  const ratio = cas / A0_KT;
  const qcOverP0 = Math.pow(1 + 0.2 * ratio * ratio, 3.5) - 1;
  const machSq = 5 * (Math.pow(qcOverP0 / delta + 1, 2 / 7) - 1);
  const mach = Math.sqrt(Math.max(0, machSq));
  return mach * speedOfSoundKt(altFt, isaDevC);
}

/** True airspeed for a held Mach number. */
export function machToTas(mach, altFt, isaDevC = 0) {
  return Math.max(0, Number(mach) || 0) * speedOfSoundKt(altFt, isaDevC);
}

/* ---- geometry ---- */
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
const NM_PER_DEG = 60;

export function haversineNm(la1, lo1, la2, lo2) {
  const R = 3440.065;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2
    + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(la1, lo1, la2, lo2) {
  const y = Math.sin(toRad(lo2 - lo1)) * Math.cos(toRad(la2));
  const x = Math.cos(toRad(la1)) * Math.sin(toRad(la2))
    - Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(toRad(lo2 - lo1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Wind triangle, vector form.
 *
 * A headwind-component subtraction understates TAS whenever there is any
 * crosswind, so this subtracts the wind as a vector and takes the magnitude.
 * windDirDeg is the meteorological direction the wind blows FROM.
 */
export function groundToTrueAirspeed(gsKt, trackDeg, windDirDeg, windSpdKt, vsFpm = 0) {
  const gs = Math.max(0, Number(gsKt) || 0);
  const trk = toRad(Number(trackDeg) || 0);
  // Ground velocity, north/east components.
  const gN = gs * Math.cos(trk);
  const gE = gs * Math.sin(trk);
  let aN = gN, aE = gE;
  if (windSpdKt != null && windDirDeg != null) {
    const spd = Math.max(0, Number(windSpdKt) || 0);
    const from = toRad(Number(windDirDeg) || 0);
    // Wind vector points toward (from + 180).
    aN -= -spd * Math.cos(from);
    aE -= -spd * Math.sin(from);
  }
  const horiz = Math.hypot(aN, aE);
  const vert = (Number(vsFpm) || 0) * KT_PER_FPM;
  return Math.hypot(horiz, vert);
}

/* ---- aircraft type normalization ---- */
const WAKE_PREFIX = /^[HMLJ]\//;
const EQUIP_SUFFIX = /\/[A-Z]$/;

/**
 * Pull an ICAO type designator out of a pilot-entered aircraft field.
 * Handles "H/B77W/L", "B738/L", "1/B738/L", lowercase, stray whitespace.
 * Returns "" when nothing designator-shaped survives, so callers can bucket
 * the climb as unknown rather than silently attributing it to a real type.
 */
export function normalizeAircraftType(raw) {
  let s = String(raw == null ? "" : raw).toUpperCase().trim();
  if (!s) return "";
  s = s.replace(/\s+/g, "");
  s = s.replace(/^\d+\//, "");        // "1/B738/L" equipment-count prefix
  s = s.replace(WAKE_PREFIX, "");     // wake category prefix
  s = s.replace(EQUIP_SUFFIX, "");    // equipment suffix
  s = s.split("/")[0];                // anything still slashed
  if (!/^[A-Z][A-Z0-9]{1,3}$/.test(s)) return "";
  if (s === "ZZZZ" || s === "UNKN") return "";
  return s;
}

/** Best available type string on a VATSIM pilot record. */
export function pilotAircraftType(p) {
  const fp = (p && p.flight_plan) || {};
  return normalizeAircraftType(fp.aircraft_short)
    || normalizeAircraftType(fp.aircraft_faa)
    || normalizeAircraftType(fp.aircraft)
    || "";
}

/* ---- sample construction and quality gates ---- */
export const MIN_DT_SEC = 8;
export const MAX_DT_SEC = 45;
export const GS_DISAGREE_FRAC = 0.15;   // reported vs position-derived GS
export const MIN_CLIMB_FPM = 300;
export const MIN_AIRBORNE_GS = 100;

/**
 * Turn a consecutive pair of positions into one analysed climb sample, or
 * return { ok: false, reason } saying which gate rejected it.
 *
 * The gates matter more than the math. A handful of warped or time-accelerated
 * flights will drag a median that a hundred honest ones built.
 */
export function buildSample(prev, curr, wind, isaDevC = 0) {
  if (!prev || !curr) return { ok: false, reason: "missing" };
  const dt = (curr.t - prev.t) / 1000;
  if (!(dt > 0)) return { ok: false, reason: "nonmonotonic" };
  if (dt < MIN_DT_SEC) return { ok: false, reason: "dt_short" };
  if (dt > MAX_DT_SEC) return { ok: false, reason: "dt_long" };

  const gsReported = Number(curr.gs) || 0;
  if (gsReported < MIN_AIRBORNE_GS) return { ok: false, reason: "slow" };

  const distNm = haversineNm(prev.lat, prev.lon, curr.lat, curr.lon);
  const gsDerived = distNm / (dt / 3600);
  // Sim pause, slew, warp, or a sim rate above 1x all show up here: the
  // aircraft covered ground its reported speed cannot account for.
  const ref = Math.max(gsReported, 1);
  if (Math.abs(gsDerived - gsReported) / ref > GS_DISAGREE_FRAC) {
    return { ok: false, reason: "gs_disagree" };
  }

  const vsFpm = ((curr.alt - prev.alt) / dt) * 60;
  if (vsFpm < MIN_CLIMB_FPM) return { ok: false, reason: "not_climbing" };

  const trackDeg = distNm > 0.05
    ? bearingDeg(prev.lat, prev.lon, curr.lat, curr.lon)
    : (Number(curr.hdg) || 0);
  // Ground speed is reported at the later point, so the airspeed conversion
  // runs at that point's altitude. Using the pair midpoint instead converts at
  // too low an altitude and biases IAS about a knot high on every sample.
  const altFt = Number(curr.alt) || 0;

  const windDir = wind ? wind.dirDeg : null;
  const windSpd = wind ? wind.spdKt : null;
  const tas = groundToTrueAirspeed(gsReported, trackDeg, windDir, windSpd, vsFpm);
  const cas = tasToCas(tas, altFt, isaDevC);
  const mach = tasToMach(tas, altFt, isaDevC);

  return {
    ok: true,
    t: curr.t,
    altFt,
    vsFpm,
    trackDeg,
    gsKt: gsReported,
    tasKt: tas,
    casKt: cas,
    mach,
    windUsed: wind ? { ...wind } : null,
  };
}

/* ---- altitude banding ---- */
/**
 * Bands run from just after the initial climb to cruise. They are the shape
 * the FCA profile model is missing: pilots hold an IAS and then let Mach cap
 * it, so a single climb speed cannot describe the whole column.
 */
export const ALT_BANDS = [
  { key: "1500_10000", lo: 1500, hi: 10000, label: "1.5k-10k" },
  { key: "10000_18000", lo: 10000, hi: 18000, label: "10k-FL180" },
  { key: "18000_24000", lo: 18000, hi: 24000, label: "FL180-240" },
  { key: "24000_30000", lo: 24000, hi: 30000, label: "FL240-300" },
  { key: "30000_45000", lo: 30000, hi: 45000, label: "FL300+" },
];

export function bandFor(altFt) {
  for (const b of ALT_BANDS) if (altFt >= b.lo && altFt < b.hi) return b.key;
  return null;
}

export function median(values) {
  const xs = values.filter(v => typeof v === "number" && isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Linear-interpolated percentile, matching the median above at p=0.5. */
export function percentile(values, p) {
  const xs = values.filter(v => typeof v === "number" && isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/**
 * Reduce one flight's accepted samples to a per-band profile.
 *
 * Taking the median within each band first is what keeps slow climbers from
 * dominating later: at a fixed poll rate an aircraft at 1000 fpm contributes
 * twice the samples of one at 2000 fpm, so bands are summarised per flight and
 * each flight gets one vote in the aggregate.
 */
export function reduceFlight(samples, meta = {}) {
  const byBand = new Map();
  for (const s of samples) {
    if (!s || !s.ok) continue;
    const key = bandFor(s.altFt);
    if (!key) continue;
    if (!byBand.has(key)) byBand.set(key, []);
    byBand.get(key).push(s);
  }
  const bands = {};
  for (const b of ALT_BANDS) {
    const rows = byBand.get(b.key);
    if (!rows || !rows.length) continue;
    bands[b.key] = {
      n: rows.length,
      iasKt: median(rows.map(r => r.casKt)),
      tasKt: median(rows.map(r => r.tasKt)),
      mach: median(rows.map(r => r.mach)),
      vsFpm: median(rows.map(r => r.vsFpm)),
    };
  }
  const all = [].concat(...byBand.values());
  const below10k = (byBand.get("1500_10000") || []);
  return {
    ...meta,
    bands,
    sampleCount: all.length,
    topAltFt: all.length ? Math.max(...all.map(s => s.altFt)) : null,
    exceeded250Below10k: below10k.some(s => s.casKt > 255),
  };
}

/**
 * Crossover: the highest band still holding the low-altitude IAS, read off the
 * curve rather than fitted. Above it IAS bleeds off as Mach takes over, which
 * is the kink you see when the profile is plotted against altitude.
 */
export function crossoverBand(flight, dropKt = 8) {
  const keys = ALT_BANDS.map(b => b.key).filter(k => flight.bands[k]);
  const ref = keys.find(k => k !== "1500_10000");
  if (!ref) return null;
  const refIas = flight.bands[ref].iasKt;
  for (const k of keys) {
    if (k === "1500_10000" || k === ref) continue;
    if (flight.bands[k].iasKt < refIas - dropKt) return k;
  }
  return null;
}

/**
 * Aggregate finished flights into a per-band IAS curve. One flight, one vote.
 * n and the interquartile band travel with every point, because a curve from
 * four flights must not read like a curve from eight hundred.
 */
export function aggregateCurve(flights) {
  const out = { n: flights.length, bands: {} };
  for (const b of ALT_BANDS) {
    const vals = flights.map(f => f.bands[b.key] && f.bands[b.key].iasKt).filter(v => v != null);
    const machs = flights.map(f => f.bands[b.key] && f.bands[b.key].mach).filter(v => v != null);
    const vs = flights.map(f => f.bands[b.key] && f.bands[b.key].vsFpm).filter(v => v != null);
    if (!vals.length) continue;
    out.bands[b.key] = {
      n: vals.length,
      iasMedian: median(vals),
      iasP25: percentile(vals, 0.25),
      iasP75: percentile(vals, 0.75),
      machMedian: median(machs),
      vsMedian: median(vs),
    };
  }
  return out;
}
