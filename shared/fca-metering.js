/**
 * Shared FCA metering geometry + sequencing (FCA Builder + Tower Departures).
 */
export const NM_PER_DEG = 60;
export const LOOKAHEAD_NM = 1200;
export const DEMAND_WINDOW_MIN = 60;
export const CLIMB_NM = 120;
export const CLIMB_FACTOR = 0.65;
export const DIR_LABEL = { any: "any dir", N: "NB", S: "SB", E: "EB", W: "WB" };

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

export function groundTransitSec(dist, tas) {
  const climb = Math.min(dist, CLIMB_NM);
  return (climb / (tas * CLIMB_FACTOR) + Math.max(0, dist - climb) / tas) * 3600;
}

export function groundCrossing(p, fca, nowMs) {
  const o = (p.lat != null && p.lon != null) ? [p.lat, p.lon] : getAirport(p.dep);
  const dst = getAirport(p.arr);
  if (!o || !dst) return null;
  const best = pathCrossing(buildPathLLs(plannedAnchors(p, o, dst)), fca);
  if (!best) return null;
  const tas = p.tas || 420, transitSec = groundTransitSec(best.dist, tas);
  const ptimeMs = ptimeToMs(p.deptime), effMs = Math.max(nowMs, ptimeMs || nowMs);
  const etaSec = (effMs - nowMs) / 1000 + transitSec;
  return { dist: best.dist, cross: { lat: best.lat, lon: best.lon }, course: best.course, tas, transitSec, ptimeMs, effMs, etaSec, origin: o };
}

/** Tower: ignore filed departure — ETA = transit time from release-now. */
export function towerGroundCrossing(p, fca, nowMs) {
  const o = (p.lat != null && p.lon != null) ? [p.lat, p.lon] : getAirport(p.dep);
  const dst = getAirport(p.arr);
  if (!o || !dst) return null;
  const best = pathCrossing(buildPathLLs(plannedAnchors(p, o, dst)), fca);
  if (!best) return null;
  const tas = p.tas || 420, transitSec = groundTransitSec(best.dist, tas);
  return {
    dist: best.dist, cross: { lat: best.lat, lon: best.lon }, course: best.course, tas, transitSec,
    etaSec: transitSec, origin: o,
  };
}

function finalizeItems(ordered, out, nowMs) {
  ordered.forEach(c => {
    c.delay = c.sched - c.eta;
    c.ctaMs = nowMs + c.sched * 1000;
    if (c.phase === "gnd") c.edctMs = c.effMs != null ? c.effMs + c.delay * 1000 : c.ctaMs - (c.transitSec || 0) * 1000;
    if (c.phase === "air") out.nAir++;
    else out.nGnd++;
  });
  out.items = ordered;
}

export function buildManualOrder(manualOrder, candById) {
  let order = (manualOrder || []).filter(cs => candById.has(cs));
  const inOrder = new Set(order);
  const newcomers = [...candById.keys()].filter(cs => !inOrder.has(cs))
    .sort((a, b) => candById.get(a).eta - candById.get(b).eta);
  for (const cs of newcomers) {
    const eta = candById.get(cs).eta;
    let idx = order.findIndex(o => candById.get(o).eta > eta);
    if (idx < 0) idx = order.length;
    order.splice(idx, 0, cs);
  }
  return order;
}

/** Manual order from FCA Builder global `fca.order`, filtered to candidates. */
export function resolveManualOrder(fca, candById, pilots, prefiles, nowMs) {
  if (Array.isArray(fca.order) && fca.order.length) {
    return buildManualOrder(fca.order, candById);
  }
  return buildManualOrder([], candById);
}

/** Reorder one callsign relative to another in the global FCA sequence. */
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

export function computeSequence(fca, pilots, prefiles, opts = {}) {
  const includeEdct = opts.includeEdct !== false;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const out = {
    items: [], demand: 0, mode: fca.mode || "rate", rate: fca.rate || 0, mit: fca.mit || 0,
    minit: 0, excluded: 0, nAir: 0, nGnd: 0, nowMs,
  };
  if (!fca.points || fca.points.length < 2) return out;
  const ex = new Set(fca.excluded || []);
  const cand = [];

  for (const p of pilots) {
    if (p.phase !== "air" || (p.gs || 0) < 40) continue;
    if (ex.has(p.callsign)) { out.excluded++; continue; }
    if (!fcaMatchesDest(fca, p.arr)) continue;
    if (!fcaMatchesAlt(fca, p.alt || 0)) continue;
    let x = null, via = null;
    if (fcaMatchesDir(fca, p.hdg || 0)) x = projectCrossing(p, fca.points);
    if (!x) {
      const dst = getAirport(p.arr);
      if (dst) {
        const b = pathCrossing(buildPathLLs([[p.lat, p.lon], dst]), fca);
        if (b && b.dist <= LOOKAHEAD_NM) { x = { dist: b.dist, lat: b.lat, lon: b.lon }; via = "route"; }
      }
    }
    if (!x) continue;
    cand.push({ p, phase: "air", dist: x.dist, eta: (x.dist / p.gs) * 3600, cross: x, spd: p.gs, via });
  }

  if (includeEdct) {
    const seen = new Set();
    const grounds = pilots.filter(p => p.phase === "gnd").concat(prefiles || []);
    for (const p of grounds) {
      if (seen.has(p.callsign)) continue;
      seen.add(p.callsign);
      if (ex.has(p.callsign)) { out.excluded++; continue; }
      if (!fcaMatchesDest(fca, p.arr)) continue;
      if (!fcaMatchesAlt(fca, p.fpAlt || 0)) continue;
      const g = groundCrossing(p, fca, nowMs);
      if (!g) continue;
      cand.push({
        p, phase: "gnd", dist: g.dist, eta: g.etaSec, cross: g.cross, spd: g.tas,
        effMs: g.effMs, ptimeMs: g.ptimeMs, transitSec: g.transitSec,
      });
    }
  }

  const rateGap = (out.mode === "rate" && fca.rate > 0) ? 3600 / fca.rate : 0;
  const sepFor = c => out.mode === "mit" ? (fca.mit > 0 ? (fca.mit / (c.spd || 420)) * 3600 : 0) : rateGap;

  const candById = new Map();
  cand.forEach(c => candById.set(c.p.callsign, c));
  const manual = Array.isArray(fca.order) && fca.order.length > 0;

  if (manual) {
    out.manual = true;
    const order = buildManualOrder(fca.order, candById);
    out.order = order;
    let prev = -1e9, ordered = [];
    order.forEach(cs => {
      const c = candById.get(cs);
      if (!c) return;
      const sched = Math.max(c.eta, prev + sepFor(c));
      c.sched = sched;
      prev = sched;
      ordered.push(c);
    });
    finalizeItems(ordered, out, nowMs);
  } else {
    const air = cand.filter(c => c.phase === "air").sort((a, b) => a.eta - b.eta);
    const gnd = cand.filter(c => c.phase === "gnd").sort((a, b) => a.eta - b.eta);
    let prevAir = -1e9;
    const committed = [];
    air.forEach(a => {
      const sched = Math.max(a.eta, prevAir + sepFor(a));
      a.sched = sched;
      prevAir = sched;
      committed.push({ t: sched, spd: a.spd });
    });
    const EPS = 1e-6;
    gnd.forEach(g => {
      let t = g.eta, guard = 0;
      for (;;) {
        if (guard++ > 500) break;
        committed.sort((x, y) => x.t - y.t);
        let moved = false;
        for (const c of committed) {
          if (t <= c.t) { if ((c.t - t) < sepFor({ spd: c.spd }) - EPS) { t = c.t + sepFor(g); moved = true; break; } }
          else { if ((t - c.t) < sepFor(g) - EPS) { t = c.t + sepFor(g); moved = true; break; } }
        }
        if (!moved) break;
      }
      g.sched = t;
      committed.push({ t, spd: g.spd });
    });
    finalizeItems(cand.slice().sort((a, b) => a.sched - b.sched), out, nowMs);
  }

  if (out.mode === "rate") out.minit = rateGap;
  else if (cand.length) { const sp = cand[Math.floor(cand.length / 2)].spd || 450; out.minit = (fca.mit / sp) * 3600; }
  out.demand = cand.filter(c => c.eta <= DEMAND_WINDOW_MIN * 60).length;
  return out;
}

export function isDepartureCandidate(p, depIcao) {
  const dep = (p.dep || "").toUpperCase();
  if (dep !== depIcao) return false;
  if ((p.gs || 0) > 60 && (p.alt || 0) > 300) return false;
  return true;
}

function scheduleTowerCandidates(cand, fca, manualOrder, nowMs) {
  const rateGap = (fca.mode === "rate" && fca.rate > 0) ? 3600 / fca.rate : 0;
  const sepFor = c => fca.mode === "mit" ? (fca.mit > 0 ? (fca.mit / (c.spd || 420)) * 3600 : 0) : rateGap;
  const candById = new Map();
  cand.forEach(c => candById.set(c.p.callsign, c));
  const order = buildManualOrder(manualOrder, candById);
  let prev = -1e9, ordered = [], prevSched = null;
  order.forEach((cs, idx) => {
    const c = candById.get(cs);
    if (!c) return;
    const sched = Math.max(c.eta, prev + sepFor(c));
    c.sched = sched;
    c.gapMin = idx === 0 ? 0 : (sched - prevSched) / 60;
    c.delayMin = (sched - c.eta) / 60;
    c.ctaMs = nowMs + sched * 1000;
    c.edctMs = c.ctaMs - (c.transitSec || 0) * 1000;
    prev = sched;
    prevSched = sched;
    ordered.push(c);
  });
  return { items: ordered, order };
}

/**
 * Tower departures for one airport against active FCAs.
 * Uses FCA Builder global `fca.order` (synced via Supabase) for sequencing.
 */
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
  for (const p of (prefiles || [])) {
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
      const g = towerGroundCrossing(p, fca, nowMs);
      if (!g) continue;
      if (!fcaMatchesDir(fca, g.course)) continue;
      cand.push({
        p, phase: "gnd", dist: g.dist, eta: g.etaSec, cross: g.cross, spd: g.tas, transitSec: g.transitSec,
      });
    }
    if (!cand.length) continue;
    const candById = new Map();
    cand.forEach(c => candById.set(c.p.callsign, c));
    const manualOrder = resolveManualOrder(fca, candById, pilots, prefiles, nowMs);
    const { items } = scheduleTowerCandidates(cand, fca, manualOrder, nowMs);

    const globalSeq = computeSequence(fca, pilots, prefiles, { includeEdct: true, nowMs });
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
