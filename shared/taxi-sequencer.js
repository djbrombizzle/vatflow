/**
 * Departure taxi sequencer: order each runway's queue so successive departures
 * split onto different departure fixes.
 *
 * A departure's "fix" is SID + next fix: the SID's enroute transition when one is
 * filed (BANNG3 LUCKK -> LUCKK), else the next fix in the route, else the SID's
 * own exit fix. Its bearing from the field sets both its colour (hue = bearing,
 * so complementary colours are opposite courses) and the interval it needs
 * behind the departures ahead of it, per FAA JO 7110.65:
 *
 *   diverge   1 mile: courses diverge 15 deg or more immediately after
 *             departure, or 10 deg when both fly an RNAV SID off the same
 *             runway (5-8-3a, 5-8-3b). Not with wake turbulence separation.
 *   same      3 miles radar in trail (5-5-4): the same fix, or less divergence
 *   wake      2 minutes behind a heavy, 3 behind a super (3-9-6f), timed from
 *             the leader starting its takeoff roll
 *
 * All times are takeoff roll to takeoff roll. Miles become seconds at the initial
 * climb groundspeed: both roll the same way, so the gap when the follower lifts
 * off is about the time between rolls x groundspeed (1 NM at 170 kt is 21 s).
 * Off the same runway nobody rolls before runway separation (3-9-6a: the leader
 * has crossed the runway end, or is airborne 6,000 ft ahead), about 45 s for a
 * jet, so that, not the 1 mile, is what limits diverging departures there.
 *
 * Between runways the relation decides: the same runway (or its reciprocal) and
 * parallels under 2,500 ft apart take the miles and wake rules (runway separation
 * only applies to the same runway); runways 2,500 ft or more apart may release
 * together when courses diverge (5-8-3a2) and only need in-trail spacing when
 * they do not, with no wake rule (releaseFloor).
 *
 * sequenceRunway() searches every order within MAX_SHIFT places of first-come
 * first-served (constrained position shifting: nobody is jumped more than twice)
 * for the one with the least total wait.
 *
 * Pure module — no DOM, no fetch, no storage. Tests: scripts/test-taxi-sequencer.mjs
 */
import { gcNm, sidFromRoute, DEFAULT_SPOOL_SEC, DEFAULT_TAXI_KT, DEFAULT_SINUOSITY, MOVING_KT } from "./taxi-estimate.js";

/** 5-8-3a: courses diverging this much immediately after departure need only 1 mile. */
export const DIVERGE_MIN_DEG = 15;
/** 5-8-3b: same runway, both on RNAV SIDs. */
export const DIVERGE_RNAV_DEG = 10;
/** 5-8-3a: parallels closer than this are treated as one runway. */
export const CLOSE_PARALLEL_FT = 2500;
/**
 * rwySep    s, same-runway separation (3-9-6a)
 * divergeNm 1 mile when courses diverge (5-8-3a/b)
 * trailNm   3 miles radar in trail (5-5-4); raise it for a departure MIT
 * climbKt   initial climb groundspeed that turns miles into seconds
 * wake, wakeSuper  s behind a heavy / super (3-9-6f)
 */
export const DEFAULT_INTERVALS = { rwySep: 45, divergeNm: 1, trailNm: 3, climbKt: 170, wake: 120, wakeSuper: 180 };
export const MAX_SHIFT = 2;
/** Stopped this close to its runway after taxiing: in the queue, ready now. */
export const HOLDING_NM = 0.8;
/** Beyond this many aircraft the tail of the queue keeps first-come order. */
export const MAX_OPTIMIZE = 12;
const MAX_NODES = 250000;

const rad = d => (d * Math.PI) / 180;
const iv_ = intervals => ({ ...DEFAULT_INTERVALS, ...(intervals || {}) });

/** Seconds between takeoff rolls that open up `nm` at the initial climb groundspeed. */
export function milesSec(nm, intervals) {
  const iv = iv_(intervals);
  return Math.round((Math.max(0, nm) * 3600) / Math.max(60, iv.climbKt));
}
/** In-trail time off any runway (no runway separation floor). */
export function trailSec(intervals) {
  return milesSec(iv_(intervals).trailNm, intervals);
}
const deg = r => (r * 180) / Math.PI;

/** Initial true bearing from point 1 to point 2, 0..360. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Point `nm` along `brg` from a position: [lat, lon]. */
export function destination(lat, lon, brg, nm) {
  const d = nm / 3440.065, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** Colour for a course: hue is the bearing, so a 180 deg split is a complementary pair. */
export function courseColor(brg, light = 62) {
  if (!isFinite(brg)) return "hsl(0, 0%, 55%)";
  return `hsl(${Math.round(brg) % 360}, 82%, ${light}%)`;
}

/** Eight-point compass name for a bearing. */
export function compassOf(brg) {
  if (!isFinite(brg)) return "";
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(brg / 45) % 8];
}

const HEAVY = new Set(("A124 A225 A306 A30B A310 A332 A333 A337 A338 A339 A342 A343 A345 A346 A359 A35K A388 " +
  "B703 B741 B742 B743 B744 B748 B74D B74R B74S B762 B763 B764 B772 B773 B778 B779 B77L B77W B788 B789 B78X " +
  "C135 C141 C17 C5 C5M DC10 E3CF E3TF E6 IL76 IL96 K35R KC10 L101 MD11 A400 B52").split(" "));
const SUPER = new Set(["A388", "A225", "A124"]);

/** "H/B744/L", "B744", "B744/H" -> "B744". */
export function aircraftType(raw) {
  return String(raw || "").toUpperCase().replace(/^[HMLJS]\//, "").split("/")[0].trim();
}

/** "super" | "heavy" | "" for a filed aircraft type. */
export function wakeOf(raw) {
  const t = aircraftType(raw);
  return SUPER.has(t) ? "super" : HEAVY.has(t) ? "heavy" : "";
}

/** Nearest candidate of a duplicated fix name to the field. */
function pickNear(cands, fieldLL) {
  if (!Array.isArray(cands) || !cands.length) return null;
  let best = null, bestNm = Infinity;
  for (const c of cands) {
    if (!Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1])) continue;
    const nm = fieldLL ? gcNm(fieldLL[0], fieldLL[1], c[0], c[1]) : 0;
    if (nm < bestNm) { bestNm = nm; best = c; }
  }
  return best && bestNm < 600 ? [best[0], best[1]] : null;
}

/** Last fix of a SID's common route or, failing that, of its runway transitions. */
function sidExit(proc) {
  if (!proc) return null;
  const common = proc.common || [];
  if (common.length) return common[common.length - 1];
  for (const [k, legs] of Object.entries(proc.transitions || {})) {
    if (/^RW/.test(k) && legs.length) return legs[legs.length - 1];
  }
  return null;
}

/**
 * SID + next fix for a filed route.
 *
 * @param {object} opts
 * @param {string} opts.route        filed route string
 * @param {string} opts.icao         departure field
 * @param {number[]} opts.fieldLL    [lat, lon] of the field
 * @param {object} [opts.procs]      procedures.json
 * @param {object} [opts.fixes]      fixes.json (name -> [[lat, lon], ...])
 * @param {object} [opts.navaids]    navaids.json (same shape)
 * @returns {{ sid, fix, lat, lon, bearing, label, source }}  fix "" when nothing resolves
 */
export function departureFix(opts = {}) {
  const { route, icao, fieldLL } = opts;
  const procs = opts.procs || {}, fixes = opts.fixes || {}, navaids = opts.navaids || {};
  const tokens = String(route || "").toUpperCase().replace(/\+/g, " ").split(/[\s.]+/).filter(Boolean)
    .map(t => t.split("/")[0]).filter(t => t && t !== "DCT" && t !== String(icao || "").toUpperCase());
  const filedSid = sidFromRoute(route);
  const proc = filedSid && procs[filedSid] && procs[filedSid].type === "SID" &&
    (!icao || !procs[filedSid].apt || procs[filedSid].apt.includes(String(icao).toUpperCase()))
    ? procs[filedSid] : null;
  const sid = proc ? filedSid : "";
  const at = filedSid ? tokens.indexOf(filedSid) : -1;
  const after = tokens.slice(at + 1);

  const resolve = name => {
    if (!name || !/^[A-Z][A-Z0-9]{1,4}$/.test(name)) return null;
    return pickNear(fixes[name], fieldLL) || pickNear(navaids[name], fieldLL);
  };
  const done = (fix, ll, source) => {
    const brg = ll && fieldLL ? bearingDeg(fieldLL[0], fieldLL[1], ll[0], ll[1]) : NaN;
    return {
      sid, fix, lat: ll ? ll[0] : NaN, lon: ll ? ll[1] : NaN, bearing: brg,
      label: (sid || "—") + "·" + (fix || "?"), source,
    };
  };

  // 1. the SID's enroute transition: "BANNG3 LUCKK"
  const next = after[0];
  if (proc && next && proc.transitions && proc.transitions[next]) {
    const legs = proc.transitions[next];
    const leg = legs.find(l => l[0] === next) || legs[legs.length - 1];
    return done(next, leg ? [leg[1], leg[2]] : resolve(next), "transition");
  }
  // 2. the next fix in the route; an airway straight off the SID joins at its exit fix
  for (const t of (proc ? after : tokens).slice(0, 3)) {
    if (/^[A-Z]{1,2}\d{1,4}$/.test(t)) { if (proc) break; continue; }   // J121, Q22, V1
    const ll = resolve(t);
    if (ll) return done(t, ll, proc ? "next" : "route");
  }
  // 3. the SID's own exit fix
  const exit = sidExit(proc);
  if (exit) return done(exit[0], [exit[1], exit[2]], "exit");
  return done("", null, "none");
}

/**
 * Interval the follower needs behind the leader, and why.
 * @param {string} [relation]  'same' runway (default), 'close' parallel under
 *   2,500 ft, or 'far' (2,500 ft or more apart, or not parallel)
 * @returns {{ sec: number, kind: 'diverge'|'same'|'wake'|'unknown'|'simul', delta: number, rule: string }}
 */
export function pairInterval(lead, follow, intervals = DEFAULT_INTERVALS, relation = "same") {
  const iv = { ...DEFAULT_INTERVALS, ...(intervals || {}) };
  if (!lead || !follow) return { sec: 0, kind: "diverge", delta: 180, rule: "" };
  const sameFix = lead.fix && follow.fix && lead.fix === follow.fix;
  const delta = sameFix ? 0 : (isFinite(lead.bearing) && isFinite(follow.bearing) ? angleDiff(lead.bearing, follow.bearing) : NaN);
  const rnav = relation === "same" && lead.rnav && follow.rnav;
  const minDeg = rnav ? DIVERGE_RNAV_DEG : DIVERGE_MIN_DEG;
  // Off the same runway nobody rolls before the leader is clear (3-9-6a).
  const floor = relation === "same" ? iv.rwySep : 0;
  const miles = (nm, kind, rule) => {
    const sec = milesSec(nm, iv);
    return sec >= floor ? { sec, kind, delta, rule } : { sec: floor, kind, delta, rule: "3-9-6a" };
  };
  let out;
  if (!isFinite(delta)) out = miles(iv.trailNm, "unknown", "5-5-4");
  else if (delta < minDeg) out = miles(iv.trailNm, "same", "5-5-4");
  else if (relation === "far") out = { sec: 0, kind: "simul", delta, rule: "5-8-3a2" };
  else out = miles(iv.divergeNm, "diverge", rnav ? "5-8-3b" : "5-8-3a");
  if (relation !== "far") {
    const wake = lead.wake === "super" ? iv.wakeSuper : lead.wake === "heavy" && follow.wake !== "super" ? iv.wake : 0;
    if (wake > out.sec) out = { sec: wake, kind: "wake", delta, rule: "3-9-6f" };
  }
  return out;
}

/**
 * How two runway ends relate for departure separation: 'same' (the same runway
 * either way), 'close' (parallel, centerlines under 2,500 ft apart) or 'far'.
 * Ends are { id, lat, lon, hdg }.
 */
export function runwayRelation(a, b, closeFt = CLOSE_PARALLEL_FT) {
  if (!a || !b) return "far";
  if (a.id === b.id) return "same";
  const numA = parseInt(a.id, 10), numB = parseInt(b.id, 10);
  if (String(a.id).slice(2) === ({ L: "R", R: "L", C: "C" }[String(b.id).slice(2)] || "") &&
      ((numA + 17) % 36) + 1 === numB) return "same";
  const parallel = angleDiff(a.hdg, b.hdg) < 15 || angleDiff(a.hdg, b.hdg) > 165;
  if (!parallel || !isFinite(a.lat) || !isFinite(b.lat)) return "far";
  // Cross-track distance of b's threshold from a's centerline.
  const nm = gcNm(a.lat, a.lon, b.lat, b.lon);
  const off = Math.abs(nm * Math.sin(rad(bearingDeg(a.lat, a.lon, b.lat, b.lon) - a.hdg))) * 6076.12;
  return off < closeFt ? "close" : "far";
}

/**
 * Earliest release (seconds from now) for an aircraft behind departures that
 * have already gone off any runway, or -Infinity when nothing holds it.
 * @param {object} ac        { fix, bearing, wake, rnav }
 * @param {object[]} recent  [{ fix, bearing, wake, rnav, agoSec, relation }]
 *                           relation: of the departure's runway to the aircraft's
 */
export function releaseFloor(ac, recent, intervals = DEFAULT_INTERVALS) {
  let floor = -Infinity;
  for (const d of recent || []) {
    const need = pairInterval(d, ac, intervals, d.relation || "same").sec;
    if (need > 0) floor = Math.max(floor, need - Math.max(0, d.agoSec || 0));
  }
  return floor;
}

/**
 * Seconds from now until this aircraft can be at the runway: spool if it has not
 * moved yet, plus straight-line distance padded for the taxi route. Stopped in
 * line near the runway after taxiing counts as ready now — it is waiting its turn.
 */
export function readySec(ac, end, cfg = {}) {
  if (!ac || !end || !isFinite(ac.lat) || !isFinite(end.lat)) return 0;
  const taxiKt = Math.max(3, cfg.taxiKt || DEFAULT_TAXI_KT);
  const sinuosity = Math.max(1, cfg.sinuosity || DEFAULT_SINUOSITY);
  const spool = ac.moved || (ac.gs || 0) >= MOVING_KT ? 0 : (cfg.spoolSec ?? DEFAULT_SPOOL_SEC);
  const straight = gcNm(ac.lat, ac.lon, end.lat, end.lon);
  if (ac.moved && (ac.gs || 0) < MOVING_KT && straight <= (cfg.holdingNm ?? HOLDING_NM)) return 0;
  const nm = straight * sinuosity;
  return Math.round(spool + (nm / taxiKt) * 3600);
}

/**
 * Wheels-up times for an order. Times are seconds from now.
 * @param {object[]} order      queue items { id, fix, bearing, wake, rnav, ready, floor? }
 *                              floor: earliest release from departures already gone (releaseFloor)
 * @param {object} [ctx]
 * @param {object} [ctx.lastDep]    { fix, bearing, wake, rnav, agoSec } — last departure off this runway
 * @param {object} [ctx.intervals]
 */
export function scheduleOrder(order, ctx = {}) {
  const floors = {};          // fix -> in trail behind an earlier one in this order
  const iv = ctx.intervals;
  const out = [];
  let prev = ctx.lastDep || null;
  let prevT = prev ? -Math.max(0, prev.agoSec || 0) : -Infinity;
  for (const ac of order) {
    const pair = prev ? pairInterval(prev, ac, iv) : { sec: 0, kind: "first", delta: NaN };
    let t = Math.max(Math.max(0, ac.ready || 0), prevT + pair.sec);
    const floor = Math.max(isFinite(ac.floor) ? ac.floor : -Infinity, ac.fix && isFinite(floors[ac.fix]) ? floors[ac.fix] : -Infinity);
    const held = floor > t;
    if (held) t = floor;
    out.push({ id: ac.id, t, wait: t - Math.max(0, ac.ready || 0), pair, held });
    if (ac.fix) floors[ac.fix] = t + trailSec(iv);
    prev = ac; prevT = t;
  }
  const total = out.reduce((s, x) => s + x.t, 0);
  const span = out.length ? out[out.length - 1].t : 0;
  return { slots: out, total, span };
}

/**
 * Best order for one runway's queue.
 * @param {object[]} queue   items { id, fix, bearing, wake, ready } in any order
 * @param {object} [ctx]     scheduleOrder ctx plus { maxShift }
 * @returns {{ fcfs, best, order, savedSec, moves }}
 *   order: best order of queue items; moves: [{ id, from, to, ahead: [ids jumped] }]
 */
export function sequenceRunway(queue, ctx = {}) {
  const fcfsOrder = (queue || []).slice().sort((a, b) => (a.ready - b.ready) || String(a.id).localeCompare(String(b.id)));
  const fcfs = scheduleOrder(fcfsOrder, ctx);
  const maxShift = Math.max(0, ctx.maxShift ?? MAX_SHIFT);
  const head = fcfsOrder.slice(0, MAX_OPTIMIZE), tail = fcfsOrder.slice(MAX_OPTIMIZE);
  const n = head.length;

  let bestOrder = head.slice();
  let bestCost = scheduleOrder(head, ctx);
  let nodes = 0;
  const iv = ctx.intervals;
  const used = new Array(n).fill(false);
  const pick = [];

  // Depth-first over orders where nobody moves more than maxShift places,
  // carrying the running schedule so each step costs one pair lookup.
  const dfs = (prev, prevT, floors, total) => {
    if (++nodes > MAX_NODES) return;
    const p = pick.length;
    if (p === n) {
      if (total < bestCost.total || (total === bestCost.total && prevT < bestCost.span)) {
        bestCost = { total, span: prevT }; bestOrder = pick.map(i => head[i]);
      }
      return;
    }
    // Someone is at the limit of how far they can be pushed back: they go now.
    const forced = used.findIndex((u, i) => !u && i + maxShift <= p);
    const cands = forced >= 0 ? [forced] : [];
    if (forced < 0) for (let i = Math.max(0, p - maxShift); i <= Math.min(n - 1, p + maxShift); i++) if (!used[i]) cands.push(i);
    for (const i of cands) {
      const ac = head[i];
      let t = Math.max(Math.max(0, ac.ready || 0), prev ? prevT + pairInterval(prev, ac, iv).sec : -Infinity);
      if (isFinite(ac.floor) && ac.floor > t) t = ac.floor;
      const fl = ac.fix ? floors[ac.fix] : undefined;
      if (isFinite(fl) && fl > t) t = fl;
      if (total + t >= bestCost.total) continue;     // prune: already no better
      const nextFloors = ac.fix ? { ...floors, [ac.fix]: t + trailSec(iv) } : floors;
      pick.push(i); used[i] = true;
      dfs(ac, t, nextFloors, total + t);
      pick.pop(); used[i] = false;
    }
  };
  const last = ctx.lastDep || null;
  if (n > 1 && maxShift > 0) dfs(last, last ? -Math.max(0, last.agoSec || 0) : -Infinity, {}, 0);

  const order = bestOrder.concat(tail);
  const best = scheduleOrder(order, ctx);
  const fcfsIdx = new Map(fcfsOrder.map((a, i) => [a.id, i]));
  const moves = [];
  order.forEach((a, to) => {
    const from = fcfsIdx.get(a.id);
    if (to < from) {
      // Only a real jump: moving up because someone else moved further up is not one.
      const ahead = fcfsOrder.slice(to, from).filter(b => order.indexOf(b) > to).map(b => b.id);
      if (ahead.length) moves.push({ id: a.id, from, to, ahead });
    }
  });
  return { fcfs, best, order, fcfsOrder, savedSec: Math.max(0, fcfs.total - best.total), moves };
}

/**
 * Clock on each fix across the whole field: seconds from now until a departure to
 * that fix is clean in trail (3 miles, 5-5-4) behind the last one that went (0 when open).
 * @param {object[]} departures  [{ fix, bearing, wake, agoSec }]
 */
export function fixClocks(departures, intervals = DEFAULT_INTERVALS) {
  const out = {};
  for (const d of departures || []) {
    if (!d || !d.fix) continue;
    const left = trailSec(intervals) - Math.max(0, d.agoSec || 0);
    if (!(d.fix in out) || left > out[d.fix]) out[d.fix] = left;
  }
  for (const k of Object.keys(out)) out[k] = Math.max(0, Math.round(out[k]));
  return out;
}

/** "+1:30" style label for seconds from now. */
export function fmtSec(sec) {
  if (!isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
