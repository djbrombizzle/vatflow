/**
 * Taxi-time estimation for the CFR ready floor.
 *
 * Replaces the flat READY_BUFFER_SEC guess behind RDY with a per-aircraft
 * number: how long from where this aircraft is sitting until it can be off the
 * ground. The result prefills the ART field, so a controller always sees the
 * estimate and can overwrite it before issuing.
 *
 * The estimate is the later of two independent constraints:
 *
 *   getting there   spool + travel(present position -> assigned runway)
 *   getting out     queue ahead for that runway x runway occupancy interval
 *
 * They are a max, not a sum: taxiing and waiting your turn happen at the same
 * time. Ten aircraft ahead of you is ten aircraft ahead whether you are at the
 * gate or holding short.
 *
 * Travel blends two sources, weighted by how much observed data exists:
 *   - geometric: great-circle to the threshold x sinuosity / effective taxi speed
 *   - observed:  the field's median taxi time from Taxi Monitor samples
 * With no samples the estimate is purely geometric; as samples accumulate it
 * shrinks toward what the field actually does. Everything degrades to
 * FALLBACK_TAXI_SEC (the old 180 s) rather than throwing.
 *
 * Pure module — no DOM, no fetch, no storage. Tests: scripts/test-taxi-estimate.mjs
 */

/** Seconds from clearance to the aircraft actually moving (pushback, start). */
export const DEFAULT_SPOOL_SEC = 90;
/** Effective groundspeed over the taxi route, including hold-shorts (kt). */
export const DEFAULT_TAXI_KT = 13;
/** Taxi path length vs. straight-line distance to the threshold. */
export const DEFAULT_SINUOSITY = 1.35;
/** Runway occupancy per departure — one every 90 s is a busy single runway. */
export const DEFAULT_RWY_INTERVAL_SEC = 90;
/** Groundspeed at or above which an aircraft is already taxiing (no spool left). */
export const MOVING_KT = 7;
/** Samples needed before the observed median outweighs the geometric model. */
export const BLEND_HALF_SAMPLES = 8;

/** Never suggest a release closer than this — a controller still has to speak it. */
export const MIN_TAXI_SEC = 120;
/** Beyond this the estimate is not credible; something upstream is wrong. */
export const MAX_TAXI_SEC = 1800;
/** What the CFR engine used before any of this existed. */
export const FALLBACK_TAXI_SEC = 180;

const NM_PER_RAD = 3440.065;
const rad = d => (d * Math.PI) / 180;

export function gcNm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * NM_PER_RAD * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "RW09L" / "09l" / " 9L " -> "09L". Returns "" for junk. */
export function normalizeRunway(id) {
  const s = String(id || "").trim().toUpperCase().replace(/^RW/, "");
  const m = /^(\d{1,2})([LCRB]?)$/.exec(s);
  if (!m) return "";
  const num = parseInt(m[1], 10);
  if (!(num >= 1 && num <= 36)) return "";
  return String(num).padStart(2, "0") + m[2];
}

/**
 * Expand a procedure runway token into concrete runway ends.
 * "08B" means either 08L or 08R; "ALL" means every active runway.
 */
export function expandRunwayToken(token, activeRunways) {
  const active = (activeRunways || []).map(normalizeRunway).filter(Boolean);
  const raw = String(token || "").trim().toUpperCase().replace(/^RW/, "");
  if (raw === "ALL" || raw === "") return active.slice();
  const id = normalizeRunway(raw);
  if (!id) return [];
  if (id.endsWith("B")) {
    const base = id.slice(0, -1);
    return [base + "L", base + "R", base + "C"];
  }
  return [id];
}

const PROC_RE = /^[A-Z]{3,5}\d[A-Z]?$/;

/**
 * Strip the revision off a procedure name: BANNG3 -> BANNG.
 * Rules are keyed on the base so a chart revision does not silently drop them —
 * when BANNG3 becomes BANNG4 the controller's assignment still applies.
 */
export function sidBase(name) {
  return String(name || "").trim().toUpperCase().replace(/\d[A-Z]?$/, "");
}

/** First route token that looks like a procedure name — the filed SID, if any. */
export function sidFromRoute(route) {
  const tokens = String(route || "")
    .toUpperCase()
    .split(/[\s.]+/)
    .filter(Boolean);
  for (const t of tokens.slice(0, 3)) {
    if (PROC_RE.test(t)) return t;
  }
  return null;
}

/** Nearest runway end to a position, restricted to `candidates` when given. */
function nearestEnd(lat, lon, ends, candidates) {
  const pool = (ends || []).filter(e => {
    if (!e || !isFinite(e.lat) || !isFinite(e.lon)) return false;
    return !candidates || candidates.includes(e.id);
  });
  let best = null;
  let bestNm = Infinity;
  for (const e of pool) {
    const nm = gcNm(lat, lon, e.lat, e.lon);
    if (nm < bestNm) { bestNm = nm; best = e; }
  }
  return best;
}

/**
 * Decide which runway this aircraft departs from.
 *
 * Precedence, highest first:
 *   override  controller pinned this aircraft to a runway
 *   rule      configured SID -> runway assignment
 *   sid       the SID's published runway transitions, intersected with active
 *   nearest   closest active runway end to the present position
 *
 * @returns {{ runway: string, source: string, candidates: string[] }}
 */
export function assignRunway(opts = {}) {
  const { lat, lon, sid, ends, override } = opts;
  const active = (opts.activeRunways || []).map(normalizeRunway).filter(Boolean);
  const sidRules = opts.sidRules || {};
  const sidRunways = opts.sidRunways || {};

  const ov = normalizeRunway(override);
  if (ov) return { runway: ov, source: "override", candidates: [ov] };

  // Rules are stored by base name, but accept a full name too so a rule typed
  // as BANNG3 still binds.
  if (sid) {
    const ruled = normalizeRunway(sidRules[sidBase(sid)] || sidRules[sid]);
    if (ruled) return { runway: ruled, source: "rule", candidates: [ruled] };
  }

  // The SID's published runway transitions, narrowed to what is actually open.
  if (sid && Array.isArray(sidRunways[sid]) && sidRunways[sid].length) {
    const expanded = new Set();
    for (const tok of sidRunways[sid]) {
      for (const r of expandRunwayToken(tok, active)) expanded.add(r);
    }
    const usable = active.length
      ? active.filter(r => expanded.has(r))
      : [...expanded];
    if (usable.length === 1) {
      return { runway: usable[0], source: "sid", candidates: usable };
    }
    if (usable.length > 1) {
      const near = nearestEnd(lat, lon, ends, usable);
      return {
        runway: near ? near.id : usable[0],
        source: near ? "sid-nearest" : "sid",
        candidates: usable,
      };
    }
  }

  const near = nearestEnd(lat, lon, ends, active.length ? active : null);
  if (near) return { runway: near.id, source: "nearest", candidates: active };
  if (active.length === 1) return { runway: active[0], source: "active", candidates: active };
  return { runway: "", source: "none", candidates: active };
}

function clampSec(sec) {
  if (!isFinite(sec)) return FALLBACK_TAXI_SEC;
  return Math.min(MAX_TAXI_SEC, Math.max(MIN_TAXI_SEC, Math.round(sec)));
}

/**
 * Estimate seconds from now until this aircraft can be wheels-up.
 *
 * @param {object} input
 * @param {number} input.lat            present position
 * @param {number} input.lon
 * @param {number} [input.gs]           groundspeed — already moving skips spool
 * @param {string} [input.sid]          filed SID
 * @param {Array}  [input.ends]         runway ends [{id, lat, lon, hdg, lenFt}]
 * @param {object} [input.config]       per-airport config (see taxi-config-store)
 * @param {object} [input.sidRunways]   SID -> [runway tokens] for this airport
 * @param {number} [input.medianSec]    observed median taxi time at this field
 * @param {number} [input.sampleCount]  how many samples that median rests on
 * @param {number} [input.queueAhead]   departures ahead of this one for the runway
 * @returns {{ sec, tier, runway, runwaySource, parts, distNm, sampleCount }}
 */
export function estimateTaxiSec(input = {}) {
  const cfg = input.config || {};
  const spoolSec = num(cfg.spoolSec, DEFAULT_SPOOL_SEC);
  const taxiKt = Math.max(3, num(cfg.taxiKt, DEFAULT_TAXI_KT));
  const sinuosity = Math.max(1, num(cfg.sinuosity, DEFAULT_SINUOSITY));
  const rwyIntervalSec = Math.max(0, num(cfg.rwyIntervalSec, DEFAULT_RWY_INTERVAL_SEC));

  const assigned = assignRunway({
    lat: input.lat,
    lon: input.lon,
    sid: input.sid,
    ends: input.ends,
    activeRunways: cfg.activeRunways,
    sidRules: cfg.sidRules,
    sidRunways: input.sidRunways,
    override: cfg.override,
  });

  // Already rolling out of the ramp — the pushback/start time is behind them.
  const moving = num(input.gs, 0) >= MOVING_KT;
  const spool = moving ? 0 : spoolSec;

  // Geometric leg: straight line to the threshold, padded for the taxi route.
  let geometricSec = null;
  let distNm = null;
  const end = assigned.runway
    ? (input.ends || []).find(e => e && e.id === assigned.runway)
    : null;
  if (end && isFinite(input.lat) && isFinite(input.lon) && isFinite(end.lat) && isFinite(end.lon)) {
    distNm = gcNm(input.lat, input.lon, end.lat, end.lon) * sinuosity;
    geometricSec = (distNm / taxiKt) * 3600;
  }

  // Observed leg: Taxi Monitor times 7 kt -> 60 kt, so its median is travel
  // only and lines up with the geometric leg without adjustment.
  const medianSec = num(input.medianSec, NaN);
  const sampleCount = Math.max(0, Math.round(num(input.sampleCount, 0)));
  const haveMedian = isFinite(medianSec) && medianSec > 0 && sampleCount > 0;

  let travelSec;
  let tier;
  if (geometricSec != null && haveMedian) {
    const w = sampleCount / (sampleCount + BLEND_HALF_SAMPLES);
    travelSec = w * medianSec + (1 - w) * geometricSec;
    tier = "blended";
  } else if (geometricSec != null) {
    travelSec = geometricSec;
    tier = "geometric";
  } else if (haveMedian) {
    travelSec = medianSec;
    tier = "observed";
  } else {
    travelSec = Math.max(FALLBACK_TAXI_SEC - spool, 0);
    tier = "fallback";
  }

  const queueAhead = Math.max(0, Math.round(num(input.queueAhead, 0)));
  const queueSec = queueAhead * rwyIntervalSec;

  // Taxiing and queueing overlap — the binding constraint wins, they do not add.
  const sec = clampSec(Math.max(spool + travelSec, queueSec));

  return {
    sec,
    tier,
    runway: assigned.runway,
    runwaySource: assigned.source,
    parts: {
      spoolSec: Math.round(spool),
      travelSec: Math.round(travelSec),
      queueSec: Math.round(queueSec),
      queueAhead,
    },
    distNm: distNm != null ? Math.round(distNm * 100) / 100 : null,
    sampleCount,
  };
}

function num(v, fallback) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : fallback;
}

/**
 * Median of the completed taxi samples for one field.
 * Median rather than mean on purpose: a pilot who parks on a taxiway for six
 * minutes is not a taxi time, and a mean would swallow it whole.
 */
export function medianTaxiSec(samples, airport, opts = {}) {
  const maxAgeMs = num(opts.maxAgeMs, 7 * 24 * 3600 * 1000);
  const now = num(opts.nowMs, Date.now());
  const apt = String(airport || "").toUpperCase();
  const durations = (samples || [])
    .filter(s => s && String(s.airport || "").toUpperCase() === apt)
    .filter(s => isFinite(s.durationMs) && s.durationMs > 0)
    .filter(s => !isFinite(s.endMs) || now - s.endMs <= maxAgeMs)
    .map(s => s.durationMs / 1000)
    .sort((a, b) => a - b);
  if (!durations.length) return { medianSec: null, sampleCount: 0 };
  const mid = Math.floor(durations.length / 2);
  const medianSec = durations.length % 2
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
  return { medianSec: Math.round(medianSec), sampleCount: durations.length };
}

/**
 * Departures ahead of `callsign` for the same runway at the same field.
 *
 * Ahead means one of two things:
 *   - already taxiing and no further from the runway than you are. Distance is
 *     what makes this a queue rather than a headcount: an aircraft that just
 *     pushed off a gate is not ahead of one already holding short, even though
 *     both are moving.
 *   - holding an earlier issued release, wherever it happens to be sitting.
 *
 * Aircraft still parked with no release are ahead of nobody — whoever is issued
 * first takes the slot.
 *
 * @param {object} opts
 * @param {number} [opts.myDistNm] your distance to the runway; omit to count
 *   every mover, which is the safe answer when position is unknown.
 */
export function countQueueAhead(opts = {}) {
  const { callsign, airport, runway } = opts;
  const apt = String(airport || "").toUpperCase();
  const myRelease = num(opts.myReleaseMs, NaN);
  const myDist = num(opts.myDistNm, NaN);
  let n = 0;
  for (const p of opts.pilots || []) {
    if (!p || p.callsign === callsign) continue;
    if (String(p.dep || "").toUpperCase() !== apt) continue;
    if (num(p.gs, 0) > 60) continue;              // already gone
    if (runway && p.runway && p.runway !== runway) continue;

    const rel = num(p.releaseMs, NaN);
    if (isFinite(rel) && (!isFinite(myRelease) || rel < myRelease)) { n++; continue; }

    if (num(p.gs, 0) < MOVING_KT) continue;       // parked, unissued
    const theirDist = num(p.distNm, NaN);
    if (isFinite(myDist) && isFinite(theirDist) && theirDist > myDist) continue;
    n++;
  }
  return n;
}
