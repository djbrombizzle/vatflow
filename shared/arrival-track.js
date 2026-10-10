/**
 * Actual landings and airborne holding for one arrival field, from successive
 * VATSIM feeds (VATSMART while it is open, and the event recorder in Actions).
 *
 * Landing: an arrival seen airborne within LAND_FROM_NM of the field, then seen
 * slow on the ground within LAND_NEAR_NM. Timed at the midpoint of the two feeds.
 *
 * Holding: the aircraft has turned through HOLD_TURN_DEG or more, all one way,
 * within the last HOLD_WINDOW_MS while HOLD_MIN_NM to HOLD_RANGE_NM from the field. That is
 * a racetrack or a 360 for spacing (both are airborne delay); a downwind / base /
 * final turn is about 180 to 270 degrees and doesn't count. It ends when the
 * aircraft has flown HOLD_EXIT_MS without turning through more than 90 degrees.
 *
 * State is plain JSON (createArrivalState) so a page can keep it in localStorage.
 */
import { arrivalGate } from "./mit-monitor.js";

const MIN = 60000;
export const LAND_FROM_NM = 40;
export const LAND_NEAR_NM = 8;
export const LAND_GS = 60;
export const HOLD_RANGE_NM = 200;
export const HOLD_MIN_NM = 25;          // closer in, turns are the downwind, base and final
export const HOLD_TURN_DEG = 330;
export const HOLD_WINDOW_MS = 9 * MIN;
export const HOLD_EXIT_MS = 4 * MIN;
const STALE_MS = 10 * MIN;              // a gap longer than this between feeds isn't covered
const KEEP_MS = 24 * 3600000;
const RELAND_MS = 30 * MIN;

function gcNm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b, c, d) {
  const r = x => x * Math.PI / 180;
  const y = Math.sin(r(d - b)) * Math.cos(r(c));
  const x = Math.cos(r(a)) * Math.sin(r(c)) - Math.sin(r(a)) * Math.cos(r(c)) * Math.cos(r(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const turn = (from, to) => ((to - from + 540) % 360) - 180;     // signed, -180..180

export function createArrivalState(now = Date.now()) {
  return { ac: {}, landings: [], holds: [], covered: [[now, now]] };
}

/** Sum of signed heading changes over hist entries at or after `since`. */
function turnSince(hist, since) {
  let sum = 0;
  for (let i = 1; i < hist.length; i++) if (hist[i][0] >= since) sum += turn(hist[i - 1][1], hist[i][1]);
  return sum;
}

/**
 * Feed one VATSIM snapshot into the state (mutated).
 *   pilots  [{ callsign, lat, lon, gs, alt, hdg, arr, route }]
 * Returns { landed: [new landings], ended: [holds that just ended] }.
 */
export function updateArrivals(state, pilots, airport, aptLL, now = Date.now()) {
  const landed = [], ended = [];
  if (!aptLL) return { landed, ended };
  const cov = state.covered;
  const last = cov[cov.length - 1];
  if (last && now - last[1] <= STALE_MS) last[1] = now; else cov.push([now, now]);
  const seen = new Set();
  for (const p of pilots) {
    if (String(p.arr || "").toUpperCase() !== airport || p.lat == null) continue;
    const cs = p.callsign;
    const dist = gcNm(p.lat, p.lon, aptLL[0], aptLL[1]);
    const air = (p.gs || 0) >= LAND_GS;
    const prev = state.ac[cs];
    seen.add(cs);
    const relanding = state.landings.some(l => l.cs === cs && now - l.t < RELAND_MS);   // a bounce or a feed glitch, not a second arrival
    if (prev && prev.air && !air && !relanding && prev.dist <= LAND_FROM_NM && dist <= LAND_NEAR_NM && now - prev.t <= STALE_MS) {
      const l = { cs, t: Math.round((prev.t + now) / 2), gate: prev.gate || arrivalGate(p.route, airport), dep: p.dep || "", type: p.type || "" };
      state.landings.push(l); landed.push(l);
      if (prev.holdSince) { const h = closeHold(state, cs, prev, prev.t); if (h) ended.push(h); }
    }
    const a = state.ac[cs] = prev && now - prev.t <= STALE_MS ? prev : { hist: [], holdSince: 0 };
    a.t = now; a.dist = dist; a.air = air; a.lat = p.lat; a.lon = p.lon; a.alt = p.alt || 0; a.gs = p.gs || 0;
    a.gate = arrivalGate(p.route, airport); a.dep = p.dep || ""; a.type = p.type || "";
    if (!air || dist > HOLD_RANGE_NM || (dist < HOLD_MIN_NM && !a.holdSince)) { a.hist = []; if (a.holdSince) { const h = closeHold(state, cs, a, now); if (h) ended.push(h); } continue; }
    a.hist.push([now, p.hdg || 0]);
    a.hist = a.hist.filter(h => now - h[0] <= HOLD_WINDOW_MS);
    const swept = Math.abs(turnSince(a.hist, now - HOLD_WINDOW_MS));
    if (!a.holdSince && swept >= HOLD_TURN_DEG) {
      a.holdSince = a.hist[0][0];
      a.holdBrg = bearing(aptLL[0], aptLL[1], p.lat, p.lon); a.holdNm = Math.round(dist);
    } else if (a.holdSince && now - a.holdSince >= HOLD_EXIT_MS && Math.abs(turnSince(a.hist, now - HOLD_EXIT_MS)) < 90) {
      const h = closeHold(state, cs, a, now - HOLD_EXIT_MS); if (h) ended.push(h);
      a.hist = [];
    }
  }
  for (const cs of Object.keys(state.ac)) {
    if (seen.has(cs)) continue;
    const a = state.ac[cs];
    if (now - a.t > STALE_MS) { if (a.holdSince) { const h = closeHold(state, cs, a, a.t); if (h) ended.push(h); } delete state.ac[cs]; }
  }
  state.landings = state.landings.filter(l => now - l.t <= KEEP_MS);
  state.holds = state.holds.filter(h => now - h.end <= KEEP_MS);
  state.covered = state.covered.filter(c => now - c[1] <= KEEP_MS);
  return { landed, ended };
}

function closeHold(state, cs, a, end) {
  const start = a.holdSince;
  a.holdSince = 0;
  if (!(end > start)) return null;
  const h = { cs, gate: a.gate, start, end, min: Math.round((end - start) / MIN), nm: a.holdNm, dir: COMPASS[Math.round((a.holdBrg || 0) / 45) % 8] };
  state.holds.push(h);
  return h;
}

/** Aircraft holding now: [{ cs, gate, since, min, nm, dir, dep, type }] longest first. */
export function holdingNow(state, now = Date.now()) {
  return Object.entries(state.ac).filter(([, a]) => a.holdSince)
    .map(([cs, a]) => ({ cs, gate: a.gate, since: a.holdSince, min: Math.round((now - a.holdSince) / MIN),
      nm: a.holdNm, dir: COMPASS[Math.round((a.holdBrg || 0) / 45) % 8], dep: a.dep, type: a.type }))
    .sort((x, y) => x.since - y.since);
}

/** Minutes of [from, to) the state has feed coverage for. */
export function coveredMin(state, from, to) {
  let ms = 0;
  for (const [a, b] of state.covered) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return Math.round(ms / MIN);
}

/**
 * Landings over the last hour: { last60, perHr, covered, slots: [{ start, n, covered }] }.
 * perHr scales the count up to an hour when only part of it was watched (null under 20 minutes).
 * slots are the last 8 clock-aligned 15-minute slots, oldest first, the current one last.
 */
export function landingRate(state, now = Date.now()) {
  const from = now - 60 * MIN;
  const last60 = state.landings.filter(l => l.t > from && l.t <= now).length;
  const covered = Math.min(60, coveredMin(state, from, now));
  const slot0 = Math.floor(now / (15 * MIN)) * 15 * MIN;
  const slots = [];
  for (let k = 7; k >= 0; k--) {
    const start = slot0 - k * 15 * MIN, end = start + 15 * MIN;
    slots.push({ start, n: state.landings.filter(l => l.t >= start && l.t < end).length, covered: coveredMin(state, start, Math.min(end, now)) });
  }
  return { last60, covered, perHr: covered >= 20 ? Math.round(last60 * 60 / covered) : null, slots };
}
