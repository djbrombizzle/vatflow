/**
 * VATSMART event simulation — fly a planned arrival bank down the routes set for each
 * stream and land it against an AAR, so the PLAN tab can show on a map how the event
 * would look: where it stacks up, how long the holds get and when the queue clears.
 *
 * Pure functions (no DOM, no fetches). The page builds each stream's path with the
 * route engine and hands it in as [[lat, lon], ...] plus the index of the gate fix,
 * where arrivals hold when the runway can't take them yet.
 *
 * The model, kept deliberately simple and visible:
 *  - demand: arrivals per clock hour (flat, an event-shaped ramp, or a past event's
 *    landings scaled to the peak), spread across the hour with seeded jitter and
 *    shared out to streams by weight;
 *  - each flight's unconstrained landing time comes from the demand; the runway takes
 *    one every 60/AAR minutes, first come first served;
 *  - the gap is absorbed by speed control (up to SPEED_ABSORB_MIN) and the rest by
 *    holding at the gate fix, or all of it on the ground as an EDCT;
 *  - ground speed falls with distance to go (SPEED_PROFILE), altitude by a 3:1 descent.
 */
import { GATE_PALETTE } from "./mit-monitor.js";
import { eventShape } from "./event-planner.js";

const HOUR = 3600000, MIN = 60000;
const toRad = d => d * Math.PI / 180;

/** Track miles flown before landing (the sim starts each flight this far out). */
export const SIM_ENTRY_NM = 250;
/** Delay soaked up by slowing down between the gate and the runway before anyone holds. */
export const SPEED_ABSORB_MIN = 3;
/** One lap of a holding pattern. */
export const HOLD_LAP_MIN = 4;
/** Ground speed (kt) by distance to touchdown: [at or beyond nm, kt], farthest first. */
export const SPEED_PROFILE = [[100, 440], [40, 300], [12, 220], [0, 150]];

export function gcNm(a, b, c, d) {
  const dLat = toRad(c - a), dLon = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearing(a, b, c, d) {
  const y = Math.sin(toRad(d - b)) * Math.cos(toRad(c));
  const x = Math.cos(toRad(a)) * Math.sin(toRad(c)) - Math.sin(toRad(a)) * Math.cos(toRad(c)) * Math.cos(toRad(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export function destPoint(ll, brgDeg, nm) {
  const r = Math.PI / 180, dd = nm / 3440.065, b = brgDeg * r, la = ll[0] * r, lo = ll[1] * r;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dd) + Math.cos(la) * Math.sin(dd) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dd) * Math.cos(la), Math.cos(dd) - Math.sin(la) * Math.sin(la2));
  return [la2 / r, lo2 / r];
}

export function speedAt(remNm) {
  for (const [nm, kt] of SPEED_PROFILE) if (remNm >= nm) return kt;
  return SPEED_PROFILE[SPEED_PROFILE.length - 1][1];
}
export function altAt(remNm) {
  return Math.max(0, Math.min(37000, Math.round(remNm * 1000 / 3 / 100) * 100));
}

/** Seeded PRNG (mulberry32), so the same seed always gives the same traffic. */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- a stream's path ---------------- */

/**
 * Along-track model of one stream: the last SIM_ENTRY_NM of `path` (never starting past
 * the gate fix), with minutes from entry at every nm so position and time map both ways.
 * gateIdx: index in `path` of the fix arrivals hold at (-1 or out of range: no gate,
 * they hold 30 nm out).
 */
export function pathModel(path, gateIdx = -1) {
  const pts = (path || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + gcNm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const total = cum[cum.length - 1];
  if (!(total > 1)) return null;
  let gateS = gateIdx >= 0 && gateIdx < pts.length - 1 ? cum[gateIdx] : Math.max(0, total - 30);
  let entryS = Math.max(0, total - SIM_ENTRY_NM);
  if (gateS < entryS + 5) entryS = Math.max(0, gateS - 20);
  if (gateS < entryS) gateS = entryS;
  /* minutes from entry at each whole nm (and at the end) */
  const step = 1, times = [0], marks = [entryS];
  let t = 0;
  for (let s = entryS; s < total;) {
    const n = Math.min(total, s + step);
    t += (n - s) / speedAt(total - (s + n) / 2) * 60;
    times.push(t); marks.push(n);
    s = n;
  }
  const m = { pts, cum, total, entryS, gateS, marks, times, flyMin: t };
  m.gateMin = timeAtS(m, gateS);
  m.gateRemNm = total - gateS;
  return m;
}
function timeAtS(m, s) {
  const k = Math.max(0, Math.min(m.marks.length - 1, Math.floor(s - m.entryS)));
  const k2 = Math.min(m.marks.length - 1, k + 1);
  const span = m.marks[k2] - m.marks[k];
  const f = span > 0 ? (s - m.marks[k]) / span : 0;
  return m.times[k] + (m.times[k2] - m.times[k]) * Math.max(0, Math.min(1, f));
}
/** Along-track nm after `min` minutes from entry. */
export function sAtMin(m, min) {
  if (min <= 0) return m.entryS;
  if (min >= m.flyMin) return m.total;
  let lo = 0, hi = m.times.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m.times[mid] <= min) lo = mid; else hi = mid; }
  const f = (min - m.times[lo]) / ((m.times[hi] - m.times[lo]) || 1);
  return m.marks[lo] + (m.marks[hi] - m.marks[lo]) * f;
}
/** Position and course at along-track nm `s`. */
export function pointAtS(m, s) {
  const { pts, cum } = m;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1];
  const f = seg > 0 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / seg)) : 0;
  return { ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], hdg: bearing(a[0], a[1], b[0], b[1]) };
}
/** The path from the entry point on, for drawing. */
export function drawnPath(m) {
  const start = pointAtS(m, m.entryS).ll, out = [start];
  for (let i = 0; i < m.pts.length; i++) if (m.cum[i] > m.entryS) out.push(m.pts[i]);
  return out;
}

/* ---------------- demand ---------------- */

/**
 * Planned arrivals per clock hour: [{ t, n }] for `hours` hours from startMs.
 * shape: "flat" (the peak every hour), "event" (ramp up, peak, ease off; Airport TMU's
 * Event planner shape) or "past" (pastArrByHour, a past event's landings, scaled so its
 * busiest hour is the peak).
 */
export function demandHours({ startMs, hours = 3, peak = 40, shape = "event", pastArrByHour = null }) {
  const n = Math.max(1, Math.min(12, Math.round(hours))), out = [];
  let past = null;
  if (shape === "past" && Array.isArray(pastArrByHour)) {
    const v = pastArrByHour.map(x => +(x && x.n) || 0);
    let a = v.findIndex(x => x > 0), b = v.length - 1;
    while (b > a && !(v[b] > 0)) b--;
    if (a >= 0) past = v.slice(a, b + 1);
  }
  const top = past ? Math.max(...past) : 0;
  for (let i = 0; i < n; i++) {
    let f;
    if (past && top > 0) f = past[Math.min(past.length - 1, Math.floor(i * past.length / n))] / top;
    else if (shape === "flat") f = 1;
    else f = i === n - 1 && n > 1 ? 0.6 : eventShape(i, n);
    out.push({ t: startMs + i * HOUR, n: Math.max(0, Math.round(peak * f)) });
  }
  return out;
}

const AIRLINES = ["AAL", "DAL", "UAL", "SWA", "JBU", "NKS", "ASA", "FFT", "SKW", "RPA", "ENY", "EDV", "AAY", "FDX", "UPS", "N"];

/**
 * Arrivals for the demand: [{ id, callsign, stream, U }] where U is the landing time with
 * no delay. Each hour's arrivals are spread over the hour with jitter; each goes to a
 * stream with probability proportional to its weight. Same seed, same traffic.
 */
export function makeFlights({ hours, streams, seed = 1 }) {
  const on = (streams || []).filter(s => s && +s.weight > 0);
  if (!on.length) return [];
  const total = on.reduce((a, s) => a + +s.weight, 0);
  const r = rng(seed), out = [], used = new Set();
  const pick = () => {
    let x = r() * total;
    for (const s of on) { x -= +s.weight; if (x < 0) return s; }
    return on[on.length - 1];
  };
  const callsign = () => {
    for (let k = 0; k < 50; k++) {
      const al = AIRLINES[Math.floor(r() * AIRLINES.length)];
      const cs = al === "N" ? "N" + (100 + Math.floor(r() * 900)) + "SM" : al + (100 + Math.floor(r() * 4900));
      if (!used.has(cs)) { used.add(cs); return cs; }
    }
    return "SIM" + out.length;
  };
  for (const h of hours || []) {
    for (let k = 0; k < h.n; k++) {
      const pos = (k + 0.5 + (r() - 0.5) * 0.9) / h.n;
      const s = pick();
      out.push({ id: out.length, callsign: callsign(), stream: s.id, U: Math.round(h.t + pos * HOUR) });
    }
  }
  return out.sort((a, b) => a.U - b.U).map((f, i) => ({ ...f, id: i }));
}

/* ---------------- the run ---------------- */

/** MIT (nm) at a stream's gate fix as minutes between aircraft, at the sim's speed there. */
export function mitMinutes(m, nm) {
  return m && +nm > 0 ? +nm / speedAt(m.gateRemNm) * 60 : 0;
}
/** Most arrivals per hour a stream can deliver with `nm` miles in trail at its gate fix (Infinity with none). */
export function mitRate(m, nm) {
  const g = mitMinutes(m, nm);
  return g > 0 ? 60 / g : Infinity;
}
/** Share of the en-route leg (entry to gate fix) that can be stretched by speed and vectors for MIT. */
export const MIT_STRETCH = 0.5;

/**
 * Land `flights` ({ id, callsign, stream, U }) at `aar`/hr. models: { [stream id]: pathModel }.
 * mit: { [stream id]: nm } in trail at that stream's gate fix. Each landing goes to whichever
 * stream's next arrival can land first (no earlier than its U, its stream's MIT behind the one
 * ahead on that stream, and 60/AAR behind the last landing). Delay from the MIT is taken before
 * the gate fix: the en-route leg stretched by up to MIT_STRETCH, the rest upstream of the
 * sim's entry point. Delay from the runway is speed control then holding at the gate fix.
 * mode "ground" puts all of it on the ground as an EDCT. Flights on a stream with no model
 * are dropped (listed in `dropped`).
 */
export function runSim({ flights, models, aar, mode = "air", absorbMin = SPEED_ABSORB_MIN, mit = {} }) {
  const gap = HOUR / Math.max(1, +aar || 1);
  const queues = new Map(), dropped = [], out = [];
  for (const f of [...(flights || [])].sort((a, b) => a.U - b.U || a.id - b.id)) {
    if (!models || !models[f.stream]) { dropped.push(f); continue; }
    if (!queues.has(f.stream)) queues.set(f.stream, []);
    queues.get(f.stream).push(f);
  }
  const spacing = new Map([...queues.keys()].map(k => [k, mitMinutes(models[k], mit && mit[k]) * MIN]));
  const landed = sequence(queues, gap, spacing);
  /* MIT delay = how much later each flight lands than it would with no MIT anywhere */
  const anyMit = [...spacing.values()].some(v => v > 0);
  const free = anyMit ? sequence(queues, gap, new Map()) : landed;
  for (const [f, A] of landed) {
    const m = models[f.stream];
    const delayMin = (A - f.U) / MIN;
    const mitMin = Math.max(0, Math.min(delayMin, (A - free.get(f)) / MIN));
    const rwyMin = delayMin - mitMin;
    let speedMin = 0, holdMin = 0, edctMin = 0, stretchMin = 0, upstreamMin = 0;
    if (mode === "ground") edctMin = delayMin;
    else {
      speedMin = Math.min(rwyMin, absorbMin); holdMin = rwyMin - speedMin;
      stretchMin = Math.min(mitMin, m.gateMin * MIT_STRETCH); upstreamMin = mitMin - stretchMin;
    }
    const entryT = f.U - m.flyMin * MIN + (edctMin + upstreamMin) * MIN;
    const gateT = entryT + (m.gateMin + stretchMin) * MIN;
    out.push({ ...f, A, landT: A, delayMin, mitMin, rwyMin, speedMin, holdMin, edctMin, stretchMin, upstreamMin, entryT, gateT, holdEnd: gateT + holdMin * MIN });
  }
  out.sort((a, b) => a.id - b.id);
  const start = out.length ? Math.min(...out.map(f => f.entryT)) : 0;
  const end = out.length ? Math.max(...out.map(f => f.landT)) : 0;
  return { flights: out, dropped, aar: +aar, mode, gapMin: gap / MIN, start, end };
}

/* Landing times (Map flight → ms): each slot to whichever stream's next arrival can land
   first, no earlier than its U, its stream's spacing behind the last on that stream, and
   `gap` behind the last landing. */
function sequence(queues, gap, spacing) {
  const head = new Map([...queues.keys()].map(k => [k, 0])), lastS = new Map(), out = new Map();
  let lastR = -Infinity, left = [...queues.values()].reduce((a, q) => a + q.length, 0);
  while (left-- > 0) {
    let best = null;
    for (const [sid, q] of queues) {
      const i = head.get(sid);
      if (i >= q.length) continue;
      const f = q[i], sp = spacing.get(sid) || 0;
      const e = Math.max(f.U, sp > 0 && lastS.has(sid) ? lastS.get(sid) + sp : -Infinity, lastR + gap);
      if (!best || e < best.e || (e === best.e && (f.U < best.f.U || (f.U === best.f.U && f.id < best.f.id)))) best = { sid, f, e };
    }
    head.set(best.sid, head.get(best.sid) + 1);
    lastR = best.e; lastS.set(best.sid, best.e);
    out.set(best.f, best.e);
  }
  return out;
}

/**
 * Where flight `f` (from runSim) is at time t: null before it enters or after it lands,
 * else { phase: "enroute" | "hold" | "inbound", ll, hdg, alt, gs, remNm, mit }.
 * mit: it's being slowed for its stream's MIT.
 */
export function flightAt(f, m, t) {
  if (!m || t < f.entryT || t >= f.landT) return null;
  const e = (t - f.entryT) / MIN, stretch = f.stretchMin || 0, leg = m.gateMin + stretch;
  if (e < leg) {
    const s = sAtMin(m, leg > 0 ? e / leg * m.gateMin : 0), p = pointAtS(m, s), rem = m.total - s;
    return { phase: "enroute", ll: p.ll, hdg: p.hdg, alt: altAt(rem), gs: Math.round(speedAt(rem) * (leg > 0 ? m.gateMin / leg : 1)), remNm: rem, mit: stretch > 0.5 };
  }
  if (e < leg + f.holdMin) {
    /* a circle that passes through the gate fix, on the right of the inbound course */
    const fix = pointAtS(m, m.gateS), lap = HOLD_LAP_MIN, r = 210 * lap / 60 / (2 * Math.PI);
    const c = destPoint(fix.ll, (fix.hdg + 90) % 360, r);
    const ang = ((e - leg) / lap * 360 + (f.id * 47) % 360) % 360;
    const pos = destPoint(c, (fix.hdg + 270 + ang) % 360, r);
    const alt = Math.max(altAt(m.gateRemNm), 6000) + (f.stackLevel || 0) * 1000;
    return { phase: "hold", ll: pos, hdg: (fix.hdg + ang + 360) % 360, alt, gs: 210, remNm: m.gateRemNm, mit: false };
  }
  const post = m.flyMin - m.gateMin, took = post + f.speedMin;
  const prog = took > 0 ? (e - leg - f.holdMin) / took : 1;
  const s = sAtMin(m, m.gateMin + prog * post), p = pointAtS(m, s), rem = m.total - s;
  return { phase: "inbound", ll: p.ll, hdg: p.hdg, alt: altAt(rem), gs: Math.round(speedAt(rem) * (took > 0 ? post / took : 1)), remNm: rem, mit: false };
}

/** Landings in the 60 minutes up to t: the rate the runway is actually achieving then. */
export function landedRate(sim, t) {
  let n = 0;
  for (const f of sim.flights) if (f.landT <= t && f.landT > t - HOUR) n++;
  return n;
}

/** Counts at time t: in the air, holding (also per stream), landed, still to come. */
export function simNow(sim, t) {
  let air = 0, hold = 0, landed = 0, pending = 0;
  const holdBy = {};
  for (const f of sim.flights) {
    if (t >= f.landT) landed++;
    else if (t < f.entryT) pending++;
    else {
      air++;
      if (t >= f.gateT && t < f.holdEnd) { hold++; holdBy[f.stream] = (holdBy[f.stream] || 0) + 1; }
    }
  }
  return { air, hold, landed, pending, holdBy };
}

/**
 * The run in numbers: per 15-minute slot the planned (by U) and actual (by A) landings and
 * the holding stack; totals; and per stream count, max hold and average delay.
 */
export function simStats(sim, startMs) {
  const fl = sim.flights, SLOT = 15 * MIN;
  const t0 = Math.floor((startMs ?? sim.start) / SLOT) * SLOT;
  const tEnd = Math.max(sim.end, ...fl.map(f => f.U), t0 + SLOT);
  const n = Math.ceil((tEnd - t0) / SLOT) + 1;
  const slots = Array.from({ length: n }, (_, i) => ({ t: t0 + i * SLOT, planned: 0, landed: 0, hold: 0 }));
  const idx = t => Math.floor((t - t0) / SLOT);
  for (const f of fl) {
    const a = idx(f.U), b = idx(f.landT);
    if (a >= 0 && a < n) slots[a].planned++;
    if (b >= 0 && b < n) slots[b].landed++;
  }
  let peakHold = 0, peakHoldT = 0, clearT = 0, maxRate = 0, maxRateT = 0;
  for (let t = sim.start; t <= sim.end; t += MIN) {
    const r = landedRate(sim, t);
    if (r > maxRate) { maxRate = r; maxRateT = t; }
    let h = 0;
    for (const f of fl) if (t >= f.gateT && t < f.holdEnd) h++;
    const k = idx(t);
    if (k >= 0 && k < n) slots[k].hold = Math.max(slots[k].hold, h);
    if (h > peakHold) { peakHold = h; peakHoldT = t; }
    if (h > 0) clearT = t + MIN;
  }
  const delays = fl.map(f => f.delayMin);
  const byStream = {};
  for (const f of fl) {
    const b = byStream[f.stream] = byStream[f.stream] || { n: 0, maxHold: 0, delaySum: 0, maxDelay: 0, maxMit: 0, mitSum: 0, peakHr: 0 };
    b.n++; b.delaySum += f.delayMin; b.maxHold = Math.max(b.maxHold, f.holdMin); b.maxDelay = Math.max(b.maxDelay, f.delayMin);
    b.maxMit = Math.max(b.maxMit, f.mitMin || 0); b.mitSum += f.mitMin || 0;
  }
  for (const k in byStream) byStream[k].avgDelay = byStream[k].delaySum / byStream[k].n;
  /* each stream's busiest 60 minutes of wanted landings (by U) */
  const wanted = {};
  for (const f of fl) (wanted[f.stream] = wanted[f.stream] || []).push(f.U);
  for (const [k, list] of Object.entries(wanted)) {
    list.sort((a, b) => a - b);
    let j = 0, best = 0;
    for (let i = 0; i < list.length; i++) { while (list[i] - list[j] >= HOUR) j++; best = Math.max(best, i - j + 1); }
    byStream[k].peakHr = best;
  }
  const total = fl.length;
  return {
    slots, total,
    delayed: fl.filter(f => f.delayMin >= 1).length,
    held: fl.filter(f => f.holdMin >= 1).length,
    edcts: fl.filter(f => f.edctMin >= 1).length,
    maxDelay: total ? Math.max(...delays) : 0,
    avgDelay: total ? delays.reduce((a, b) => a + b, 0) / total : 0,
    totalDelay: delays.reduce((a, b) => a + b, 0),
    maxHold: total ? Math.max(...fl.map(f => f.holdMin)) : 0,
    mitDelayed: fl.filter(f => (f.mitMin || 0) >= 1).length,
    maxMit: total ? Math.max(...fl.map(f => f.mitMin || 0)) : 0,
    peakHold, peakHoldT, clearT, byStream, maxRate, maxRateT,
    firstLand: total ? fl[0].landT : 0, lastLand: total ? Math.max(...fl.map(f => f.landT)) : 0,
  };
}

/**
 * Lowest AAR (1-200) that keeps every delay at or under maxDelayMin for these flights,
 * or null if even 200 doesn't. Delay only grows as the AAR falls, so a binary search works.
 */
export function aarForDelay({ flights, models, maxDelayMin, mit = {} }) {
  const worst = aar => { const s = runSim({ flights, models, aar, mit }); return s.flights.length ? Math.max(...s.flights.map(f => f.delayMin)) : 0; };
  if (worst(200) > maxDelayMin) return null;
  let lo = 1, hi = 200;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (worst(mid) <= maxDelayMin) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * Stack levels: holding flights at the same stream fix get 1000 ft apart in order of
 * arrival at the fix (lowest first), so the map and labels can show the stack.
 */
export function assignStacks(sim) {
  const by = {};
  for (const f of sim.flights) if (f.holdMin > 0) (by[f.stream] = by[f.stream] || []).push(f);
  for (const list of Object.values(by)) {
    list.sort((a, b) => a.gateT - b.gateT);
    const ends = [];          // per level, when it frees up
    for (const f of list) {
      let lvl = ends.findIndex(e => e <= f.gateT);
      if (lvl < 0) { lvl = ends.length; ends.push(0); }
      ends[lvl] = f.holdEnd;
      f.stackLevel = lvl;
    }
  }
  return sim;
}

/** A colour per gate, in the MIT monitor's palette order. */
export function gateColors(gates, known = {}) {
  const out = {};
  let i = 0;
  for (const g of [...new Set(gates)].sort()) out[g] = known[g] || GATE_PALETTE[i++ % GATE_PALETTE.length];
  return out;
}
