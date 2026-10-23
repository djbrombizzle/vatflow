/**
 * Departure taxi sequencer: order each runway's queue so successive departures
 * split onto different departure fixes.
 *
 * A departure's "fix" is SID + next fix: the SID's enroute transition when one is
 * filed (BANNG3 LUCKK -> LUCKK), else the next fix in the route, else the SID's
 * own exit fix. Its bearing from the field sets both its colour (hue = bearing,
 * so complementary colours are opposite courses) and the interval it needs
 * behind the departure ahead of it:
 *
 *   diverge   courses 45 deg or more apart         1 minute
 *   partial   15 to 45 deg apart                   90 s
 *   same      the same fix, or under 15 deg apart  2 minutes (in trail)
 *   wake      anything behind a heavy / super      2 minutes
 *
 * The same fix is also spaced across the field: a departure off 27R to BANNG
 * waits for the clock a BANNG departure off 26L started (fixFloors).
 *
 * sequenceRunway() searches every order within MAX_SHIFT places of first-come
 * first-served (constrained position shifting: nobody is jumped more than twice)
 * for the one with the least total wait.
 *
 * Pure module — no DOM, no fetch, no storage. Tests: scripts/test-taxi-sequencer.mjs
 */
import { gcNm, sidFromRoute, DEFAULT_SPOOL_SEC, DEFAULT_TAXI_KT, DEFAULT_SINUOSITY, MOVING_KT } from "./taxi-estimate.js";

export const DIVERGE_FULL_DEG = 45;
export const DIVERGE_MIN_DEG = 15;
export const DEFAULT_INTERVALS = { diverge: 60, partial: 90, same: 120, wake: 120 };
export const MAX_SHIFT = 2;
/** Stopped this close to its runway after taxiing: in the queue, ready now. */
export const HOLDING_NM = 0.8;
/** Beyond this many aircraft the tail of the queue keeps first-come order. */
export const MAX_OPTIMIZE = 12;
const MAX_NODES = 250000;

const rad = d => (d * Math.PI) / 180;
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
 * @returns {{ sec: number, kind: 'diverge'|'partial'|'same'|'wake'|'unknown', delta: number }}
 */
export function pairInterval(lead, follow, intervals = DEFAULT_INTERVALS) {
  const iv = { ...DEFAULT_INTERVALS, ...(intervals || {}) };
  if (!lead || !follow) return { sec: 0, kind: "diverge", delta: 180 };
  const sameFix = lead.fix && follow.fix && lead.fix === follow.fix;
  const delta = sameFix ? 0 : (isFinite(lead.bearing) && isFinite(follow.bearing) ? angleDiff(lead.bearing, follow.bearing) : NaN);
  let out;
  if (sameFix || delta < DIVERGE_MIN_DEG) out = { sec: iv.same, kind: "same", delta };
  else if (!isFinite(delta)) out = { sec: iv.partial, kind: "unknown", delta };
  else if (delta < DIVERGE_FULL_DEG) out = { sec: iv.partial, kind: "partial", delta };
  else out = { sec: iv.diverge, kind: "diverge", delta };
  const wake = lead.wake === "super" ? iv.wake + 60 : lead.wake === "heavy" && follow.wake !== "super" ? iv.wake : 0;
  if (wake > out.sec) out = { sec: wake, kind: "wake", delta };
  return out;
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
 * @param {object[]} order      queue items { id, fix, bearing, wake, ready }
 * @param {object} [ctx]
 * @param {object} [ctx.lastDep]    { fix, bearing, wake, agoSec } — last departure off this runway
 * @param {object} [ctx.fixFloors]  fix -> earliest clean release (s from now) from other runways
 * @param {object} [ctx.intervals]
 */
export function scheduleOrder(order, ctx = {}) {
  const floors = { ...(ctx.fixFloors || {}) };
  const iv = ctx.intervals;
  const out = [];
  let prev = ctx.lastDep || null;
  let prevT = prev ? -Math.max(0, prev.agoSec || 0) : -Infinity;
  for (const ac of order) {
    const pair = prev ? pairInterval(prev, ac, iv) : { sec: 0, kind: "first", delta: NaN };
    let t = Math.max(Math.max(0, ac.ready || 0), prevT + pair.sec);
    const floor = ac.fix ? floors[ac.fix] : undefined;
    const held = isFinite(floor) && floor > t;
    if (held) t = floor;
    out.push({ id: ac.id, t, wait: t - Math.max(0, ac.ready || 0), pair, held });
    if (ac.fix) floors[ac.fix] = t + pairInterval(ac, ac, iv).sec;
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
      const fl = ac.fix ? floors[ac.fix] : undefined;
      if (isFinite(fl) && fl > t) t = fl;
      if (total + t >= bestCost.total) continue;     // prune: already no better
      const nextFloors = ac.fix ? { ...floors, [ac.fix]: t + pairInterval(ac, ac, iv).sec } : floors;
      pick.push(i); used[i] = true;
      dfs(ac, t, nextFloors, total + t);
      pick.pop(); used[i] = false;
    }
  };
  const last = ctx.lastDep || null;
  if (n > 1 && maxShift > 0) dfs(last, last ? -Math.max(0, last.agoSec || 0) : -Infinity, { ...(ctx.fixFloors || {}) }, 0);

  const order = bestOrder.concat(tail);
  const best = scheduleOrder(order, ctx);
  const fcfsIdx = new Map(fcfsOrder.map((a, i) => [a.id, i]));
  const moves = [];
  order.forEach((a, to) => {
    const from = fcfsIdx.get(a.id);
    if (to < from) {
      const ahead = fcfsOrder.slice(to, from).filter(b => order.indexOf(b) > to).map(b => b.id);
      moves.push({ id: a.id, from, to, ahead });
    }
  });
  return { fcfs, best, order, fcfsOrder, savedSec: Math.max(0, fcfs.total - best.total), moves };
}

/**
 * Clock on each fix across the whole field: seconds from now until a departure to
 * that fix is clean behind the last one that went (0 when open).
 * @param {object[]} departures  [{ fix, bearing, wake, agoSec }]
 */
export function fixClocks(departures, intervals = DEFAULT_INTERVALS) {
  const out = {};
  for (const d of departures || []) {
    if (!d || !d.fix) continue;
    const left = pairInterval(d, d, intervals).sec - Math.max(0, d.agoSec || 0);
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
