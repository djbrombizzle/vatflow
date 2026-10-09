/**
 * Arrival-gate ETAs from the FCA Builder's ETA engine (shared/fca-metering.js):
 * the filed route expanded through airways and the STAR, the climb profile for
 * departures, filed TAS corrected for winds aloft, and the filed departure time
 * or a ready buffer for flights still on the ground.
 *
 * The gate fix is where the route meets the arrival gate: the STAR's namesake
 * fix when the expanded route has it (GRNCH on GRNCH5), else the first STAR fix,
 * else the gate itself when it is a filed fix. The engine meters FCA lines, so
 * each gate fix gets a short line across the route there.
 *
 * Landing time = gate ETA + the rest of the route at TERMINAL_KT.
 */
import { plannedProfileEta, getAirport, haversineNm, bearing } from "./fca-metering.js";
import { buildRouteAnchors, isNavReady } from "./route-engine.js";

export const TERMINAL_KT = 260;        // gate to touchdown, descending on the STAR and approach
export const GATE_LINE_NM = 8;         // half-length of the line drawn across the route at the gate fix

/** The gate fix among a route's expanded anchors: { name, ll, index } or null. */
export function gateFixFor(anchors, gate) {
  if (!anchors || !anchors.length || !gate) return null;
  let i = anchors.findIndex(a => a.name === gate && a.ll);
  if (i < 0) i = anchors.findIndex(a => a.kind === "star" && a.ll);
  if (i < 0) return null;
  return { name: anchors[i].name, ll: anchors[i].ll, index: i };
}

/** Along-route nm from anchor `from` to the last anchor. */
function restNm(anchors, from) {
  let d = 0;
  for (let i = from; i < anchors.length - 1; i++) {
    const a = anchors[i].ll, b = anchors[i + 1].ll;
    if (a && b) d += haversineNm(a[0], a[1], b[0], b[1]);
  }
  return d;
}

/** A short line across the route at the fix, as an FCA the engine can meter. */
function gateLine(anchors, idx) {
  const fix = anchors[idx].ll;
  const prev = anchors.slice(0, idx).reverse().find(a => a.ll && haversineNm(a.ll[0], a.ll[1], fix[0], fix[1]) > 1);
  const next = anchors.slice(idx + 1).find(a => a.ll && haversineNm(a.ll[0], a.ll[1], fix[0], fix[1]) > 1);
  const crs = prev ? bearing(prev.ll[0], prev.ll[1], fix[0], fix[1]) : next ? bearing(fix[0], fix[1], next.ll[0], next.ll[1]) : 0;
  const off = (deg, nm) => {
    const r = deg * Math.PI / 180;
    return [fix[0] + nm / 60 * Math.cos(r), fix[1] + nm / 60 * Math.sin(r) / Math.cos(fix[0] * Math.PI / 180)];
  };
  return { points: [off(crs - 90, GATE_LINE_NM), off(crs + 90, GATE_LINE_NM)], dir: "any" };
}

/**
 * ETAs for one arrival: { gateFix, gateEta, eta } in epoch ms, or null when the
 * route can't be expanded (no nav data, unknown airports) so the caller falls back.
 * gateEta is null once the aircraft is past the gate fix; eta is then the rest of the route.
 * `p` is a pilot as the FCA engine takes it: dep, arr, route, lat/lon/gs/hdg/alt, phase, fpAlt, tas, deptime.
 */
export function gateEtaFor(p, gate, now = Date.now()) {
  if (!isNavReady() || !getAirport(p.arr) || (!getAirport(p.dep) && p.lat == null)) return null;
  const { anchors } = buildRouteAnchors(p);
  const fix = gateFixFor(anchors, gate);
  if (!fix) return null;
  const fca = gateLine(anchors, fix.index);
  const r = plannedProfileEta(p, fca, now);
  const rest = restNm(anchors, fix.index) / TERMINAL_KT * 3600000;
  if (r && r.etaSec != null) {
    const gateEta = now + r.etaSec * 1000;
    return { gateFix: fix.name, gateEta, eta: gateEta + rest };
  }
  /* airborne and already past the gate: fly the rest of the route from here */
  const apt = getAirport(p.arr);
  const toGo = p.lat != null ? haversineNm(p.lat, p.lon, apt[0], apt[1]) : Infinity;
  if (p.phase === "air" && toGo <= Math.max(60, haversineNm(fix.ll[0], fix.ll[1], apt[0], apt[1]) + 30)) {
    const nm = Math.min(restNm(anchors, fix.index), toGo * 1.25);
    return { gateFix: fix.name, gateEta: null, eta: now + nm / Math.max(160, Math.min(p.gs || 0, TERMINAL_KT + 40)) * 3600000 };
  }
  return null;
}
