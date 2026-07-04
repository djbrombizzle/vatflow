/**
 * Shared FCA metering geometry + sequencing (FCA Builder + Tower Departures).
 * Crossing model: extend current track (or airport→line bearing on ground) to the
 * FCA polyline; ETA = distance-to-cross / groundspeed. MIT spacing is relative
 * to the line itself (time between crossings = MIT nm / gs).
 */
export const NM_PER_DEG = 60;
export const LOOKAHEAD_NM = 1200;
export const DEMAND_WINDOW_MIN = 60;
export const DIR_LABEL = { any: "any dir", N: "NB", S: "SB", E: "EB", W: "WB" };
/** Groundspeed assumed for parked/taxiing departures when estimating time to the line. */
export const DEFAULT_GROUND_GS = 250;

const AIRPORTS = new Map();
let airportsReady = false;

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

export function getAirport(icao) {
  if (!icao) return null;
  return AIRPORTS.get(("" + icao).toUpperCase()) || null;
}
export function hasAirport(icao) {
  return AIRPORTS.has(("" + icao).toUpperCase());
}
export function isAirportsReady() { return airportsReady; }
export function seedAirports(map) {
  if (!map) return;
  Object.entries(map).forEach(([k, v]) => AIRPORTS.set(k, v));
}

export function loadAirports(onReady) {
  const url = "https://cdn.jsdelivr.net/gh/vatsimnetwork/vatspy-data-project@master/VATSpy.dat";
  return fetch(url)
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(txt => {
      let inApt = false, n = 0;
      txt.split(/\r?\n/).forEach(line => {
        if (line.startsWith("[")) { inApt = /\[Airports\]/i.test(line); return; }
        if (!inApt || !line || line.startsWith(";")) return;
        const c = line.split("|");
        if (c.length >= 4) {
          const ic = c[0].trim().toUpperCase(), la = parseFloat(c[2]), lo = parseFloat(c[3]);
          if (ic && !isNaN(la) && !isNaN(lo)) { AIRPORTS.set(ic, [la, lo]); n++; }
        }
      });
      airportsReady = true;
      if (onReady) onReady(n);
      return n;
    });
}

export function haversineNm(la1, lo1, la2, lo2) {
  const R = 3440.065, dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(la1, lo1, la2, lo2) {
  const y = Math.sin(toRad(lo2 - lo1)) * Math.cos(toRad(la2));
  const x = Math.cos(toRad(la1)) * Math.sin(toRad(la2)) - Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(toRad(lo2 - lo1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function gcLine(a, b) {
  const lat1 = toRad(a[0]), lon1 = toRad(a[1]), lat2 = toRad(b[0]), lon2 = toRad(b[1]);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (!isFinite(d) || d === 0) return [a.slice(), b.slice()];
  const n = Math.max(2, Math.min(48, Math.round(haversineNm(a[0], a[1], b[0], b[1]) / 120)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, S = Math.sin(d), Aa = Math.sin((1 - f) * d) / S, Bb = Math.sin(f * d) / S;
    const x = Aa * Math.cos(lat1) * Math.cos(lon1) + Bb * Math.cos(lat2) * Math.cos(lon2);
    const y = Aa * Math.cos(lat1) * Math.sin(lon1) + Bb * Math.cos(lat2) * Math.sin(lon2);
    const z = Aa * Math.sin(lat1) + Bb * Math.sin(lat2);
    out.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return out;
}

function toLocal(lat, lon, lat0, lon0) {
  return [(lon - lon0) * NM_PER_DEG * Math.cos(toRad(lat0)), (lat - lat0) * NM_PER_DEG];
}
function localToLatLon(x, y, lat0, lon0) {
  return [lat0 + y / NM_PER_DEG, lon0 + x / (NM_PER_DEG * Math.cos(toRad(lat0)))];
}

export function parseRouteTokens(route) {
  if (!route) return [];
  return route.toUpperCase().replace(/[\n\r]/g, " ").split(/\s+/).filter(Boolean).filter(t => t !== "DCT");
}

export function parseAlt(a) {
  if (a == null) return 0;
  a = ("" + a).toUpperCase().replace(/\s|FL/g, "");
  const n = parseInt(a, 10);
  if (isNaN(n)) return 0;
  return n < 1000 ? n * 100 : n;
}

export function ptimeToMs(dep) {
  if (!dep) return null;
  dep = ("" + dep).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  const h = +dep.slice(0, 2), m = +dep.slice(2, 4);
  if (isNaN(h) || isNaN(m) || h > 23 || m > 59) return null;
  const now = new Date(), nowMs = now.getTime();
  let ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0);
  if (ms - nowMs > 12 * 36e5) ms -= 864e5;
  else if (nowMs - ms > 12 * 36e5) ms += 864e5;
  return ms;
}

export function fmtZulu(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}

export function fmtPtime(deptime) {
  if (!deptime) return "—";
  const s = ("" + deptime).replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  if (s.length !== 4) return "—";
  const h = +s.slice(0, 2), m = +s.slice(2, 4);
  if (h > 23 || m > 59) return "—";
  return s + "Z";
}

export function fcaMatchesAlt(fca, alt) {
  const min = (fca.minFL != null) ? fca.minFL * 100 : -1;
  const max = (fca.maxFL != null) ? fca.maxFL * 100 : 1e9;
  return alt >= min && alt <= max;
}
export function fcaMatchesDest(fca, arr) {
  if (!fca.dests || !fca.dests.length) return true;
  return fca.dests.includes((arr || "").toUpperCase());
}
export function dirOfHeading(h) {
  h = ((h % 360) + 360) % 360;
  if (h >= 315 || h < 45) return "N";
  if (h < 135) return "E";
  if (h < 225) return "S";
  return "W";
}
export function fcaMatchesDir(fca, hdg) {
  const d = fca.dir || "any";
  if (d === "any") return true;
  return dirOfHeading(hdg) === d;
}

function angleDiff(a, b) {
  return Math.abs(((a - b) + 540) % 360 - 180);
}

function flowBearing(fca) {
  const d = fca.dir || "any";
  if (d === "any") return null;
  return { N: 0, E: 90, S: 180, W: 270 }[d] ?? null;
}

function nearestPointOnFca(lat, lon, pts) {
  let best = null, bd = 1e9;
  for (let i = 0; i < pts.length - 1; i++) {
    const lat0 = pts[i][0], lon0 = pts[i][1];
    const A = toLocal(pts[i][0], pts[i][1], lat0, lon0);
    const B = toLocal(pts[i + 1][0], pts[i + 1][1], lat0, lon0);
    const P = toLocal(lat, lon, lat0, lon0);
    const abx = B[0] - A[0], aby = B[1] - A[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((P[0] - A[0]) * abx + (P[1] - A[1]) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = A[0] + t * abx, py = A[1] + t * aby;
    const distNm = Math.hypot(px - P[0], py - P[1]);
    if (distNm < bd) {
      bd = distNm;
      const ll = localToLatLon(px, py, lat0, lon0);
      best = { lat: ll[0], lon: ll[1], distNm };
    }
  }
  return best;
}

/** Perpendicular distance (nm) from a position to the FCA polyline. */
export function lineDistToFca(lat, lon, fca) {
  if (lat == null || lon == null || !fca?.points?.length) return null;
  const near = nearestPointOnFca(lat, lon, fca.points);
  return near ? near.distNm : null;
}

/** Seconds to cover distance at groundspeed. */
export function crossingEtaSec(distNm, gs) {
  const spd = gs > 0 ? gs : DEFAULT_GROUND_GS;
  return (distNm / spd) * 3600;
}

/** Legacy export — simple time = distance / speed. */
export function groundTransitSec(dist, gs) {
  return crossingEtaSec(dist, gs || DEFAULT_GROUND_GS);
}

/** No-op kept for callers that still invoke it. */
export function setWindAltProvider(_fn) {}

export function isCrossingAhead(p, cross) {
  if (!cross || cross.lat == null || p.lat == null || p.lon == null) return true;
  if (p.phase !== "air" || (p.gs || 0) < 40) return true;
  const hdg = p.hdg;
  if (hdg == null) return true;
  const brg = bearing(p.lat, p.lon, cross.lat, cross.lon);
  return angleDiff(hdg, brg) <= 95;
}

/** Aircraft already on the exit side of a directional FCA, moving away. */
export function hasPassedFca(p, fca) {
  if (p.phase !== "air" || (p.gs || 0) < 40) return false;
  const flow = flowBearing(fca);
  if (flow == null || !fca.points || fca.points.length < 2) return false;
  const near = nearestPointOnFca(p.lat, p.lon, fca.points);
  if (!near || near.distNm < 2) return false;
  const toAc = bearing(near.lat, near.lon, p.lat, p.lon);
  const onExitSide = angleDiff(toAc, flow) < 85;
  const headingExit = angleDiff(p.hdg || 0, flow) < 85;
  return onExitSide && headingExit;
}

function validAirCrossing(p, fca, cross) {
  return cross && isCrossingAhead(p, cross) && !hasPassedFca(p, fca);
}

/** When the current-heading ray misses the segment (e.g. NE track vs N-S line), use bearing toward the line. */
function convergingCrossing(p, pts) {
  const near = nearestPointOnFca(p.lat, p.lon, pts);
  if (!near) return null;
  const brg = bearing(p.lat, p.lon, near.lat, near.lon);
  if (angleDiff(p.hdg || 0, brg) > 90) return null;
  const cross = projectCrossing({ lat: p.lat, lon: p.lon, hdg: brg }, pts);
  if (cross) return cross;
  const along = near.distNm / Math.max(0.35, Math.cos(toRad(angleDiff(p.hdg || 0, brg))));
  return along <= LOOKAHEAD_NM ? { dist: along, lat: near.lat, lon: near.lon } : null;
}

export function projectCrossing(p, pts) {
  const lat0 = p.lat, lon0 = p.lon;
  const h = toRad(p.hdg || 0);
  const dir = [Math.sin(h), Math.cos(h)];
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = toLocal(pts[i][0], pts[i][1], lat0, lon0);
    const B = toLocal(pts[i + 1][0], pts[i + 1][1], lat0, lon0);
    const seg = [B[0] - A[0], B[1] - A[1]];
    const denom = dir[0] * seg[1] - dir[1] * seg[0];
    if (Math.abs(denom) < 1e-9) continue;
    const t = (A[0] * seg[1] - A[1] * seg[0]) / denom;
    const u = (A[0] * dir[1] - A[1] * dir[0]) / denom;
    if (t > 0 && u >= 0 && u <= 1) {
      if (!best || t < best.dist) {
        const px = dir[0] * t, py = dir[1] * t;
        const ll = localToLatLon(px, py, lat0, lon0);
        best = { dist: t, lat: ll[0], lon: ll[1] };
      }
    }
  }
  return (best && best.dist <= LOOKAHEAD_NM) ? best : null;
}

function segInt(P1, P2, A, B) {
  const r = [P2[0] - P1[0], P2[1] - P1[1]], s = [B[0] - A[0], B[1] - A[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const qp = [A[0] - P1[0], A[1] - P1[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { t, x: P1[0] + t * r[0], y: P1[1] + t * r[1] };
  return null;
}

export function buildPathLLs(anchors) {
  let path = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const seg = gcLine(anchors[i], anchors[i + 1]);
    if (i > 0) seg.shift();
    path = path.concat(seg);
  }
  return path;
}

export function pathCrossing(path, fca) {
  let cum = 0, best = null;
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k], b = path[k + 1];
    const legLen = haversineNm(a[0], a[1], b[0], b[1]);
    if (legLen < 0.01) continue;
    const legCourse = bearing(a[0], a[1], b[0], b[1]);
    if (fcaMatchesDir(fca, legCourse)) {
      const P2 = toLocal(b[0], b[1], a[0], a[1]);
      for (let i = 0; i < fca.points.length - 1; i++) {
        const A = toLocal(fca.points[i][0], fca.points[i][1], a[0], a[1]);
        const B = toLocal(fca.points[i + 1][0], fca.points[i + 1][1], a[0], a[1]);
        const x = segInt([0, 0], P2, A, B);
        if (x) {
          const dist = cum + x.t * legLen;
          if (!best || dist < best.dist) {
            const ll = localToLatLon(x.x, x.y, a[0], a[1]);
            best = { dist, lat: ll[0], lon: ll[1], course: legCourse };
          }
        }
      }
    }
    cum += legLen;
  }
  return best;
}

export function plannedAnchors(p, origin, dst) {
  const anchors = [origin];
  parseRouteTokens(p.route).forEach(t => {
    const c = t.replace(/\/.*$/, "");
    if (c.length >= 3 && AIRPORTS.has(c) && c !== p.dep && c !== p.arr) anchors.push(AIRPORTS.get(c));
  });
  anchors.push(dst);
  return anchors;
}

function pilotOrigin(p) {
  if (p.lat != null && p.lon != null) return [p.lat, p.lon];
  const apt = getAirport(p.dep);
  return apt ? apt.slice() : null;
}

function headingTowardLine(origin, fca) {
  const near = nearestPointOnFca(origin[0], origin[1], fca.points);
  if (!near) return null;
  return bearing(origin[0], origin[1], near.lat, near.lon);
}

/** Airborne: extend current heading to the FCA line; fall back when converging but oblique. */
function simpleAirCrossing(p, fca) {
  if ((p.gs || 0) < 40) return null;
  if (!fcaMatchesDir(fca, p.hdg || 0)) return null;
  let cross = projectCrossing(p, fca.points);
  if (!cross) cross = convergingCrossing(p, fca.points);
  return validAirCrossing(p, fca, cross) ? cross : null;
}

/** Ground: ray from airport/current position toward the line (or along taxi heading). */
function simpleGroundCrossing(p, fca) {
  const origin = pilotOrigin(p);
  if (!origin) return null;
  let hdg = p.hdg;
  if ((p.gs || 0) < 20 || hdg == null) hdg = headingTowardLine(origin, fca);
  if (hdg == null || !fcaMatchesDir(fca, hdg)) return null;
  const cross = projectCrossing({ lat: origin[0], lon: origin[1], hdg }, fca.points);
  if (!cross) return null;
  const gs = (p.gs || 0) >= 20 ? p.gs : DEFAULT_GROUND_GS;
  const etaSec = crossingEtaSec(cross.dist, gs);
  return {
    dist: cross.dist,
    cross: { lat: cross.lat, lon: cross.lon },
    course: hdg,
    gs,
    etaSec,
    transitSec: etaSec,
    origin,
  };
}

/** Estimate where/when a ground aircraft crosses the FCA (current position + gs only). */
export function groundCrossing(p, fca, _nowMs) {
  return simpleGroundCrossing(p, fca);
}

/** Tower: same geometry — release-now, no filed departure time. */
export function towerGroundCrossing(p, fca, _nowMs) {
  return simpleGroundCrossing(p, fca);
}

function buildAirCandidate(p, fca) {
  const cross = simpleAirCrossing(p, fca);
  if (!cross) return null;
  const gs = Math.max(p.gs || 0, 40);
  const eta = crossingEtaSec(cross.dist, gs);
  const lineDist = lineDistToFca(p.lat, p.lon, fca);
  return {
    p, phase: "air", dist: cross.dist, lineDist, eta, cross, spd: gs, transitSec: eta,
  };
}

export function sepSeconds(fca, c) {
  if (fca.mode === "mit") {
    const mit = fca.mit || 0;
    const spd = c.spd || c.p?.gs || DEFAULT_GROUND_GS;
    return mit > 0 ? (mit / spd) * 3600 : 0;
  }
  return (fca.mode === "rate" && fca.rate > 0) ? 3600 / fca.rate : 0;
}

function sortAirborne(air) {
  air.sort((a, b) => a.eta - b.eta || a.dist - b.dist);
}

/** MIT at the line: prior crossing + spacing, unless already >= MIT nm in trail. */
function mitCrossingSched(prev, c, fca) {
  const mit = fca.mit || 0;
  const trailNm = c.dist - prev.dist;
  const minTime = prev.sched + sepSeconds(fca, c);
  if (mit > 0 && trailNm >= mit && c.eta >= prev.sched) return c.eta;
  return Math.max(c.eta, minTime);
}

function scheduleAirborneStream(air, fca) {
  sortAirborne(air);
  for (let i = 0; i < air.length; i++) {
    const c = air[i];
    if (i === 0) {
      c.sched = c.eta;
    } else if (fca.mode === "mit") {
      c.sched = mitCrossingSched(air[i - 1], c, fca);
    } else {
      c.sched = Math.max(c.eta, air[i - 1].sched + sepSeconds(fca, c));
    }
  }
}

function slotGroundAgainstCommitted(g, committed, sepFor) {
  let t = g.eta;
  const EPS = 1e-6;
  for (let guard = 0; guard < 500; guard++) {
    committed.sort((x, y) => x.t - y.t);
    let moved = false;
    for (const c of committed) {
      const gap = sepFor(g);
      if (t <= c.t) {
        if ((c.t - t) < gap - EPS) { t = c.t + gap; moved = true; break; }
      } else if ((t - c.t) < gap - EPS) {
        t = c.t + gap; moved = true; break;
      }
    }
    if (!moved) break;
  }
  return t;
}

/** Airborne-first: air ordered by time-to-line; ground slots around committed crossings. */
export function scheduleCandidates(cand, fca, manualOrder, candById) {
  const sepFor = c => sepSeconds(fca, c);

  if (manualOrder && manualOrder.length) {
    const ordered = [];
    let prev = -1e9;
    for (const cs of manualOrder) {
      const c = candById.get(cs);
      if (!c) continue;
      c.sched = Math.max(c.eta, prev + sepFor(c));
      prev = c.sched;
      ordered.push(c);
    }
    return ordered;
  }

  const air = cand.filter(c => c.phase === "air");
  const gnd = cand.filter(c => c.phase === "gnd");
  scheduleAirborneStream(air, fca);
  gnd.sort((a, b) => a.eta - b.eta);

  const committed = [];
  for (const c of air) {
    committed.push({ t: c.sched, spd: c.spd });
  }

  for (const g of gnd) {
    g.sched = slotGroundAgainstCommitted(g, committed, sepFor);
    committed.push({ t: g.sched, spd: g.spd });
  }

  gnd.sort((a, b) => a.sched - b.sched);
  return [...air, ...gnd];
}

function finalizeItems(ordered, out, nowMs) {
  ordered.forEach(c => {
    c.delay = c.sched - c.eta;
    c.ctaMs = nowMs + c.sched * 1000;
    if (c.phase === "gnd") c.edctMs = c.ctaMs - (c.transitSec || 0) * 1000;
    if (c.phase === "air") out.nAir++;
    else out.nGnd++;
  });
  out.items = ordered;
}

export function buildManualOrder(manualOrder, candById, _fca) {
  let order = (manualOrder || []).filter(cs => candById.has(cs));
  const inOrder = new Set(order);
  const sortNew = (a, b) => {
    const ca = candById.get(a), cb = candById.get(b);
    if (ca.phase !== cb.phase) return ca.phase === "air" ? -1 : 1;
    return ca.eta - cb.eta || ca.dist - cb.dist;
  };
  const newcomers = [...candById.keys()].filter(cs => !inOrder.has(cs)).sort(sortNew);
  for (const cs of newcomers) {
    const c = candById.get(cs);
    let idx = order.findIndex(o => sortNew(o, cs) > 0);
    if (idx < 0) idx = order.length;
    order.splice(idx, 0, cs);
  }
  return order;
}

export function resolveManualOrder(fca, candById, _pilots, _prefiles, _nowMs) {
  if (Array.isArray(fca.order) && fca.order.length) {
    return buildManualOrder(fca.order, candById, fca);
  }
  return buildManualOrder([], candById, fca);
}

export function reorderFcaGlobalOrder(fca, pilots, prefiles, fromCs, toCs, opts = {}) {
  const seq = computeSequence(fca, pilots, prefiles, {
    includeEdct: true,
    nowMs: opts.nowMs != null ? opts.nowMs : Date.now(),
  });
  const order = Array.isArray(fca.order) && fca.order.length
    ? fca.order.slice()
    : seq.items.map(c => c.p.callsign);
  const from = order.indexOf(fromCs);
  const to = order.indexOf(toCs);
  if (from < 0 || to < 0 || from === to) return order;
  const [m] = order.splice(from, 1);
  order.splice(to, 0, m);
  return order;
}

function collectAirFcaCandidates(fca, pilots) {
  const ex = new Set(fca.excluded || []);
  const cand = [];
  for (const p of pilots) {
    if (p.phase !== "air" || (p.gs || 0) < 40) continue;
    if (ex.has(p.callsign)) continue;
    if (!fcaMatchesDest(fca, p.arr)) continue;
    if (!fcaMatchesAlt(fca, p.alt || 0)) continue;
    const ac = buildAirCandidate(p, fca);
    if (ac) cand.push(ac);
  }
  return cand;
}

export function computeSequence(fca, pilots, prefiles, opts = {}) {
  const includeEdct = opts.includeEdct !== false;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const out = {
    items: [], demand: 0, mode: fca.mode || "rate", rate: fca.rate || 0, mit: fca.mit || 0,
    minit: 0, excluded: 0, nAir: 0, nGnd: 0, nowMs,
  };
  if (!fca.points || fca.points.length < 2) return out;
  const ex = new Set(fca.excluded || []);
  const cand = collectAirFcaCandidates(fca, pilots);
  for (const p of pilots) {
    if (ex.has(p.callsign) && p.phase === "air" && (p.gs || 0) >= 40) out.excluded++;
  }

  if (includeEdct) {
    const seen = new Set();
    const grounds = pilots.filter(p => p.phase === "gnd" && isConnectedPilot(p));
    for (const p of grounds) {
      if (seen.has(p.callsign)) continue;
      seen.add(p.callsign);
      if (ex.has(p.callsign)) { out.excluded++; continue; }
      if (!fcaMatchesDest(fca, p.arr)) continue;
      if (!fcaMatchesAlt(fca, p.fpAlt || 0)) continue;
      const g = groundCrossing(p, fca, nowMs);
      if (!g) continue;
      cand.push({
        p, phase: "gnd", dist: g.dist, lineDist: lineDistToFca(p.lat, p.lon, fca),
        eta: g.etaSec, cross: g.cross, spd: g.gs, transitSec: g.transitSec,
      });
    }
  }

  const rateGap = (out.mode === "rate" && fca.rate > 0) ? 3600 / fca.rate : 0;
  const candById = new Map();
  cand.forEach(c => candById.set(c.p.callsign, c));
  const manual = Array.isArray(fca.order) && fca.order.length > 0;

  if (manual) {
    out.manual = true;
    const order = buildManualOrder(fca.order, candById, fca);
    out.order = order;
    finalizeItems(scheduleCandidates(cand, fca, order, candById), out, nowMs);
  } else {
    finalizeItems(scheduleCandidates(cand, fca, null, candById), out, nowMs);
  }

  if (out.mode === "rate") out.minit = rateGap;
  else if (cand.length) { const sp = cand[Math.floor(cand.length / 2)].spd || 450; out.minit = (fca.mit / sp) * 3600; }
  out.demand = cand.filter(c => c.eta <= DEMAND_WINDOW_MIN * 60).length;
  return out;
}

export function isConnectedPilot(p) {
  return p && !p.prefile;
}

export function isDepartureCandidate(p, depIcao) {
  if (!isConnectedPilot(p)) return false;
  const dep = (p.dep || "").toUpperCase();
  if (dep !== depIcao) return false;
  if ((p.gs || 0) > 60 && (p.alt || 0) > 300) return false;
  return true;
}

function finalizeTowerGroundItem(c, prevSched, nowMs) {
  c.gapMin = prevSched == null ? 0 : (c.sched - prevSched) / 60;
  c.delayMin = (c.sched - c.eta) / 60;
  c.ctaMs = nowMs + c.sched * 1000;
  c.edctMs = c.ctaMs - (c.transitSec || 0) * 1000;
  return c;
}

function scheduleTowerCandidates(cand, fca, manualOrder, nowMs, pilots) {
  const towerGround = new Set(cand.map(c => c.p.callsign));
  const airCand = collectAirFcaCandidates(fca, pilots || []);
  const candById = new Map();
  airCand.forEach(c => candById.set(c.p.callsign, c));
  cand.forEach(c => candById.set(c.p.callsign, c));

  const order = buildManualOrder(manualOrder, candById, fca);
  const timeline = scheduleCandidates([...candById.values()], fca, order.length ? order : null, candById);

  let prevSched = null;
  const ordered = [];
  for (const c of timeline) {
    if (!towerGround.has(c.p.callsign)) {
      prevSched = c.sched;
      continue;
    }
    ordered.push(finalizeTowerGroundItem(c, prevSched, nowMs));
    prevSched = c.sched;
  }
  ordered.sort((a, b) => a.sched - b.sched);
  return { items: ordered, order: ordered.map(c => c.p.callsign) };
}

export function computeTowerDepartures(depIcao, fcas, pilots, prefiles) {
  const nowMs = Date.now();
  const dep = (depIcao || "").toUpperCase();
  if (!dep) return { departures: [], nowMs };

  const seen = new Set();
  const deps = [];
  for (const p of pilots) {
    if (!isDepartureCandidate(p, dep)) continue;
    if (seen.has(p.callsign)) continue;
    seen.add(p.callsign);
    deps.push(p);
  }

  const byCallsign = new Map();
  const activeFcas = (fcas || []).filter(f => f.enabled && f.points && f.points.length >= 2);

  for (const fca of activeFcas) {
    const cand = [];
    for (const p of deps) {
      if (!fcaMatchesDest(fca, p.arr)) continue;
      if (!fcaMatchesAlt(fca, p.fpAlt || 0)) continue;
      const g = groundCrossing(p, fca, nowMs);
      if (!g) continue;
      if (!fcaMatchesDir(fca, g.course)) continue;
      cand.push({
        p, phase: "gnd", dist: g.dist, eta: g.etaSec, cross: g.cross, spd: g.gs, transitSec: g.transitSec,
      });
    }
    if (!cand.length) continue;
    const candById = new Map();
    cand.forEach(c => candById.set(c.p.callsign, c));
    const manualOrder = resolveManualOrder(fca, candById, pilots, [], nowMs);
    const { items } = scheduleTowerCandidates(cand, fca, manualOrder, nowMs, pilots);

    const globalSeq = computeSequence(fca, pilots, [], { includeEdct: true, nowMs });
    const globalIdx = new Map();
    globalSeq.items.forEach((c, i) => globalIdx.set(c.p.callsign, i + 1));

    for (const c of items) {
      const cs = c.p.callsign;
      const row = {
        callsign: cs,
        dep: c.p.dep,
        arr: c.p.arr,
        type: c.p.type || "",
        fcaId: fca.id,
        fcaName: fca.name,
        fcaColor: fca.color,
        gapMin: c.gapMin,
        delayMin: c.delayMin,
        ctaMs: c.ctaMs,
        edctMs: c.edctMs,
        transitSec: c.transitSec,
        dist: c.dist,
        globalSeq: globalIdx.get(cs) || null,
        sched: c.sched,
        eta: c.eta,
      };
      const prev = byCallsign.get(cs);
      if (!prev || row.edctMs > prev.edctMs) byCallsign.set(cs, row);
    }
  }

  const departures = [...byCallsign.values()].sort((a, b) => a.edctMs - b.edctMs || a.callsign.localeCompare(b.callsign));
  return { departures, nowMs, total: deps.length, metered: departures.length };
}

export function fpFields(fp) {
  fp = fp || {};
  return {
    dep: (fp.departure || "").toUpperCase(),
    arr: (fp.arrival || "").toUpperCase(),
    type: fp.aircraft_short || fp.aircraft_faa || "",
    tas: parseInt(fp.cruise_tas, 10) || 0,
    fpAlt: parseAlt(fp.altitude),
    deptime: fp.deptime || "",
    route: fp.route || "",
  };
}
