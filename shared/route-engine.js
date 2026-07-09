/**
 * US enroute route expansion — fixes, navaids, airways, SID/STAR, preferred routes.
 * Data: data/nav/*.json (built from FAA NASR via scripts/build-nav-data.mjs).
 */

// Airway designators: US J/Q/V/T, Canadian/oceanic Y/W, international
// A/B/G/R/L/M/N/P and European upper U[LMNPQT]. Digits must follow the
// prefix immediately so fixes (5 letters), procedures (LETTERS+digit, e.g.
// DOTSS2) and NRS waypoints (KD60U — K prefix excluded) never match.
const AIRWAY_RE = /^(?:[ABGJLMNPQRTVWY]|U[LMNPQT])\d{1,4}[A-Z]?$/i;
const STAR_SID_RE = /^[A-Z]{3,5}\d[A-Z]?$/;
const NAV_BASE = "data/nav";

let navReady = false;
let navLoading = null;
let meta = null;
let fixes = {};
let navaids = {};
let airways = {};
let procedures = {};
let preferred = {};

let getAirportFn = () => null;
let hasAirportFn = () => false;

export function bindAirports(getAirport, hasAirport) {
  getAirportFn = getAirport || getAirportFn;
  hasAirportFn = hasAirport || hasAirportFn;
}

export function isNavReady() { return navReady; }

export function getNavMeta() { return meta; }

export function parseRouteTokens(route) {
  if (!route) return [];
  return route.toUpperCase().replace(/[\n\r]/g, " ").split(/\s+/).filter(Boolean).filter(t => t !== "DCT");
}

function cleanToken(t) {
  return (t || "").replace(/\/.*$/, "").toUpperCase();
}

function haversineNm(la1, lo1, la2, lo2) {
  const R = 3440.065, toRad = d => d * Math.PI / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** FAA nav coverage bbox (matches data/nav meta.bbox). */
export function inNavCoverage(lat, lon) {
  const b = meta?.bbox;
  const minLat = b?.[0] ?? 23.5;
  const minLon = b?.[1] ?? -130;
  const maxLat = b?.[2] ?? 51.5;
  const maxLon = b?.[3] ?? -63;
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

/** True when the filed destination is outside the US airport system we model. */
export function isInternationalRoute(arr, destination) {
  const code = (arr || "").toUpperCase();
  if (code.length >= 3) {
    if (code.startsWith("K")) return false;
    if (/^P[AHTGJF]/.test(code)) return false;
    if (/^T[JIP]/.test(code)) return false;
    if (/^MD[A-Z0-9]/.test(code)) return false;
    return true;
  }
  return !!(destination && !inNavCoverage(destination[0], destination[1]));
}

function pushAnchor(anchors, pt) {
  const last = anchors[anchors.length - 1];
  if (!last || last.ll[0] !== pt.ll[0] || last.ll[1] !== pt.ll[1]) {
    anchors.push(pt);
    return pt.ll;
  }
  return last.ll.slice();
}

function nearestCandidate(cands, refLL) {
  if (!cands || !cands.length) return null;
  if (!refLL || cands.length === 1) return cands[0];
  let best = cands[0], bd = 1e9;
  for (const c of cands) {
    const d = haversineNm(refLL[0], refLL[1], c[0], c[1]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

export function resolveToken(name, ctx = {}) {
  const id = cleanToken(name);
  if (!id || id.length < 2) return null;
  const ref = ctx.refLL || null;
  const dep = (ctx.dep || "").toUpperCase();
  const arr = (ctx.arr || "").toUpperCase();

  if (id === dep || id === arr) return null;

  if (hasAirportFn(id) && id !== dep && id !== arr) {
    const apt = getAirportFn(id);
    if (apt) return { name: id, ll: apt.slice(), kind: "apt" };
  }

  if (navaids[id]) {
    const ll = nearestCandidate(navaids[id], ref);
    if (ll) return { name: id, ll: ll.slice(), kind: "nav" };
  }

  if (fixes[id]) {
    const ll = nearestCandidate(fixes[id], ref);
    if (ll) return { name: id, ll: ll.slice(), kind: "fix" };
  }

  if (procedures[id]) {
    const proc = procedures[id];
    const legs = proc.common?.length >= 2 ? proc.common : (proc.transitions && Object.values(proc.transitions)[0]);
    if (legs && legs.length) {
      const ll = [legs[0][1], legs[0][2]];
      return { name: id, ll, kind: proc.type === "STAR" ? "star" : "sid", procedure: proc };
    }
  }

  const prefix = id.match(/^([A-Z]{3,6})\d[A-Z]?$/);
  if (prefix) {
    const proc = findProcedure(id);
    if (proc) {
      const legs = proc.common?.length >= 2 ? proc.common : (proc.transitions && Object.values(proc.transitions)[0]);
      if (legs && legs.length) {
        const ll = [legs[0][1], legs[0][2]];
        return { name: id, ll, kind: proc.type === "STAR" ? "star" : "sid", procedure: proc };
      }
    }
  }

  return null;
}

function findProcedure(id) {
  const key = cleanToken(id);
  if (!key) return null;
  if (procedures[key]) return procedures[key];
  const m = key.match(/^([A-Z]{3,6})\d[A-Z]?$/);
  if (!m) return null;
  const pfx = m[1];
  const matches = Object.keys(procedures).filter(k => k.startsWith(pfx) && procedures[k].type);
  if (!matches.length) return null;
  const pick = matches.find(k => k === key) || matches.sort((a, b) => a.length - b.length)[0];
  return procedures[pick] || null;
}

function isProcedureId(tok) {
  return !!findProcedure(tok);
}

function mergeProcedureLegs(transLegs, commonLegs) {
  if (!transLegs?.length) return commonLegs || [];
  if (!commonLegs?.length) return transLegs;
  const out = transLegs.slice();
  const lastFix = transLegs[transLegs.length - 1][0];
  let start = 0;
  if (commonLegs[0][0] === lastFix) start = 1;
  return out.concat(commonLegs.slice(start));
}

function expandProcedure(proc, ctx = {}) {
  if (!proc) return [];
  const kind = proc.type === "STAR" ? "star" : "sid";
  let legs = [];
  const trName = ctx.transition ? cleanToken(ctx.transition) : null;
  if (trName && proc.transitions && proc.transitions[trName]) {
    legs = mergeProcedureLegs(proc.transitions[trName], proc.common || []);
  } else if (proc.common?.length >= 2) {
    legs = proc.common;
  } else if (proc.w?.length >= 2) {
    legs = proc.w;
  } else {
    return [];
  }
  return legs.map(leg => ({
    name: leg[0] || "",
    ll: [leg[1], leg[2]],
    kind,
  }));
}

function nearestWpIndex(wps, ll) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < wps.length; i++) {
    const d = haversineNm(ll[0], ll[1], wps[i][1], wps[i][2]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function expandAirway(airwayId, fromLL, toLL) {
  const id = cleanToken(airwayId);
  const awy = airways[id];
  if (!awy || !awy.w || awy.w.length < 2) return [];
  const wps = awy.w;
  if (!fromLL && !toLL) {
    return wps.map(w => ({ name: w[0], ll: [w[1], w[2]], kind: "awy" }));
  }
  if (!fromLL) fromLL = [wps[0][1], wps[0][2]];
  if (!toLL) toLL = [wps[wps.length - 1][1], wps[wps.length - 1][2]];

  const i0 = nearestWpIndex(wps, fromLL);
  const i1 = nearestWpIndex(wps, toLL);
  if (i0 === i1) return [{ name: wps[i0][0], ll: [wps[i0][1], wps[i0][2]], kind: "awy" }];

  const fwd = i0 < i1 ? wps.slice(i0, i1 + 1) : wps.slice(i1, i0 + 1).reverse();
  const rev = i0 > i1 ? wps.slice(i1, i0 + 1) : wps.slice(i0, i1 + 1).reverse();
  const pick = fwd.length <= rev.length ? fwd : rev;
  return pick.map(w => ({ name: w[0], ll: [w[1], w[2]], kind: "awy" }));
}

function isAirwayToken(t) {
  return AIRWAY_RE.test(cleanToken(t));
}

function maybePreferredRoute(p) {
  const dep = (p.dep || "").toUpperCase();
  const arr = (p.arr || "").toUpperCase();
  if (!dep || !arr) return p.route || "";
  const key = `${dep}|${arr}`;
  const pr = preferred[key];
  if (!pr) return p.route || "";
  const toks = parseRouteTokens(p.route || "");
  if (toks.length <= 2 && toks.every(t => hasAirportFn(cleanToken(t)) || cleanToken(t) === "DCT")) {
    return pr;
  }
  return p.route || "";
}

function bearingDeg(la1, lo1, la2, lo2) {
  const y = Math.sin((lo2 - lo1) * Math.PI / 180) * Math.cos(la2 * Math.PI / 180);
  const x = Math.cos(la1 * Math.PI / 180) * Math.sin(la2 * Math.PI / 180)
    - Math.sin(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.cos((lo2 - lo1) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  return Math.abs(((a - b) + 540) % 360 - 180);
}

function toLocalNm(lat, lon, lat0, lon0) {
  return [(lon - lon0) * 60 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * 60];
}

/** Index of first route anchor ahead of the aircraft. */
export function routeProgressIndex(anchors, lat, lon, hdg) {
  if (!anchors.length) return 0;
  if (anchors.length === 1) return 0;

  const PASS_NM = 12;
  let bestLeg = 0;
  let bestXt = Infinity;
  let bestAlong = 0;

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i].ll;
    const b = anchors[i + 1].ll;
    const A = toLocalNm(a[0], a[1], lat, lon);
    const B = toLocalNm(b[0], b[1], lat, lon);
    const abx = B[0] - A[0], aby = B[1] - A[1];
    const apx = -A[0], apy = -A[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const xt = Math.hypot(A[0] + t * abx, A[1] + t * aby);
    const along = Math.hypot(t * abx, t * aby);
    if (xt < bestXt) {
      bestXt = xt;
      bestLeg = i;
      bestAlong = along;
    }
  }

  const a = anchors[bestLeg].ll;
  const b = anchors[bestLeg + 1].ll;
  const legLen = haversineNm(a[0], a[1], b[0], b[1]);
  let idx = bestAlong >= legLen - 3 ? bestLeg + 1 : bestLeg;

  if (hdg != null) {
    while (idx < anchors.length - 1) {
      const d = haversineNm(lat, lon, anchors[idx].ll[0], anchors[idx].ll[1]);
      const brg = bearingDeg(lat, lon, anchors[idx].ll[0], anchors[idx].ll[1]);
      if (d > 5 && angleDiff(hdg, brg) > 110) idx++;
      else break;
    }
    if (idx < anchors.length - 1) {
      const dFix = haversineNm(lat, lon, anchors[idx].ll[0], anchors[idx].ll[1]);
      if (dFix < PASS_NM) {
        const brgNext = bearingDeg(lat, lon, anchors[idx + 1].ll[0], anchors[idx + 1].ll[1]);
        if (angleDiff(hdg, brgNext) < 95) idx++;
      }
    }
  }

  return Math.min(idx, anchors.length - 1);
}

/** Keep only fixes ahead of the aircraft; prepend NOW. */
export function trimAnchorsAhead(anchors, p) {
  if (p.lat == null || p.lon == null || p.phase === "gnd" || !anchors.length) return anchors;

  let idx = routeProgressIndex(anchors, p.lat, p.lon, p.hdg);
  if (anchors[0]?.kind === "apt" && idx === 0 && anchors.length > 1) {
    const dDep = haversineNm(p.lat, p.lon, anchors[0].ll[0], anchors[0].ll[1]);
    if (dDep > 25) idx = 1;
  }

  let ahead = anchors.slice(idx);
  const pos = [p.lat, p.lon];
  if (ahead.length && haversineNm(pos[0], pos[1], ahead[0].ll[0], ahead[0].ll[1]) < 0.5) {
    ahead = ahead.slice(1);
  }
  return [{ name: "NOW", ll: pos, kind: "now" }, ...ahead];
}

export function buildRouteAnchorsForAircraft(p, opts = {}) {
  const base = buildRouteAnchors(p, { ...opts, includeNow: false });
  let anchors = base.anchors;
  const useNow = opts.includeNow !== false && p.lat != null && p.lon != null && p.phase !== "gnd";
  if (useNow) anchors = trimAnchorsAhead(anchors, p);
  return { ...base, anchors };
}

/**
 * @returns {{ anchors: Array, unresolved: string[], expandedRoute: string }}
 */
export function buildRouteAnchors(p, opts = {}) {
  const dep = (p.dep || "").toUpperCase();
  const arr = (p.arr || "").toUpperCase();
  const origin = opts.origin || (dep && getAirportFn(dep) ? getAirportFn(dep).slice() : null);
  const destination = opts.destination || (arr && getAirportFn(arr) ? getAirportFn(arr).slice() : null);
  const routeStr = maybePreferredRoute(p);
  const tokens = parseRouteTokens(routeStr);
  const intl = isInternationalRoute(arr, destination);

  const anchors = [];
  const unresolved = [];
  const oceanicSkipped = [];
  let refLL = origin;
  let intlTruncated = false;

  if (origin) anchors.push({ name: dep || "DEP", ll: origin.slice(), kind: "apt" });

  for (let i = 0; i < tokens.length; i++) {
    if (intlTruncated) {
      oceanicSkipped.push(cleanToken(tokens[i]));
      continue;
    }

    const raw = tokens[i];
    const tok = cleanToken(raw);
    const nextTok = i + 1 < tokens.length ? cleanToken(tokens[i + 1]) : "";
    const nextProc = nextTok ? findProcedure(nextTok) : null;

    // Transition fix before STAR/SID — consumed by procedure expansion, not a standalone point
    if (nextProc && nextProc.transitions && nextProc.transitions[tok]) continue;

    if (isAirwayToken(tok)) {
      let toLL = null;
      for (let j = i + 1; j < tokens.length; j++) {
        const nxt = resolveToken(tokens[j], { refLL, dep, arr });
        if (nxt) { toLL = nxt.ll; break; }
        if (isAirwayToken(tokens[j])) break;
      }
      if (!refLL) { if (!intl) unresolved.push(tok); intlTruncated = intl; continue; }
      const expanded = expandAirway(tok, refLL, toLL);
      if (!expanded.length) { if (!intl) unresolved.push(tok); intlTruncated = intl; continue; }
      for (const pt of expanded) {
        if (intl && !inNavCoverage(pt.ll[0], pt.ll[1])) {
          intlTruncated = true;
          break;
        }
        refLL = pushAnchor(anchors, pt);
      }
      if (intlTruncated) {
        for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
        break;
      }
      continue;
    }

    const hasDigit = /\d/.test(tok);
    const atEdge = i <= 1 || i >= tokens.length - 2;
    const atArrivalEdge = i >= tokens.length - 2;
    const knownPoint = !!(navaids[tok] || fixes[tok] || hasAirportFn(tok));
    const proc = (hasDigit || (atEdge && !knownPoint)) ? findProcedure(tok) : null;
    if (proc) {
      if (intl && atArrivalEdge && proc.type === "STAR") {
        intlTruncated = true;
        oceanicSkipped.push(tok);
        for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
        break;
      }
      const prevTok = i > 0 ? cleanToken(tokens[i - 1]) : "";
      const transition = proc.transitions?.[prevTok] ? prevTok : null;
      const legs = expandProcedure(proc, { transition, refLL });
      for (const pt of legs) {
        if (intl && !inNavCoverage(pt.ll[0], pt.ll[1])) {
          intlTruncated = true;
          break;
        }
        refLL = pushAnchor(anchors, pt);
      }
      if (intlTruncated) {
        for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
        break;
      }
      continue;
    }

    const resolved = resolveToken(tok, { refLL, dep, arr });
    if (!resolved) {
      if (intl) {
        intlTruncated = true;
        oceanicSkipped.push(tok);
        for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
        break;
      }
      if (!hasAirportFn(tok) && tok.length >= 2) unresolved.push(tok);
      continue;
    }
    if (intl && !inNavCoverage(resolved.ll[0], resolved.ll[1])) {
      intlTruncated = true;
      oceanicSkipped.push(tok);
      for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
      break;
    }
    if (refLL && haversineNm(refLL[0], refLL[1], resolved.ll[0], resolved.ll[1]) > 900) {
      if (intl) {
        intlTruncated = true;
        oceanicSkipped.push(tok);
        for (let j = i + 1; j < tokens.length; j++) oceanicSkipped.push(cleanToken(tokens[j]));
        break;
      }
      unresolved.push(tok);
      continue;
    }

    refLL = pushAnchor(anchors, resolved);
  }

  if (destination) {
    const last = anchors[anchors.length - 1];
    if (!last || last.ll[0] !== destination[0] || last.ll[1] !== destination[1]) {
      anchors.push({ name: arr || "ARR", ll: destination.slice(), kind: "apt" });
    }
  }

  return {
    anchors,
    unresolved,
    oceanicSkipped,
    truncatedInternational: intlTruncated,
    expandedRoute: routeStr,
  };
}

export function buildRoutePathLLs(p, opts = {}) {
  const useAircraft = opts.includeNow && p.lat != null && p.lon != null && p.phase !== "gnd";
  const { anchors } = useAircraft
    ? buildRouteAnchorsForAircraft(p, opts)
    : buildRouteAnchors(p, opts);
  const path = [];
  for (const a of anchors) {
    if (!a.ll) continue;
    if (!path.length) path.push(a.ll.slice());
    else {
      const prev = path[path.length - 1];
      if (prev[0] !== a.ll[0] || prev[1] !== a.ll[1]) path.push(a.ll.slice());
    }
  }
  return path;
}

export function buildRouteSegments(p, opts = {}) {
  const useAircraft = opts.includeNow && p.lat != null && p.lon != null && p.phase !== "gnd";
  const { anchors } = useAircraft
    ? buildRouteAnchorsForAircraft(p, opts)
    : buildRouteAnchors(p, opts);
  const segs = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i].ll, b = anchors[i + 1].ll;
    const dist = haversineNm(a[0], a[1], b[0], b[1]);
    if (dist < 0.01) continue;
    segs.push({
      from: anchors[i].name,
      to: anchors[i + 1].name,
      ll0: a.slice(),
      ll1: b.slice(),
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      distNm: dist,
    });
  }
  return segs;
}

export function loadNavData(base = NAV_BASE) {
  if (navReady) return Promise.resolve(meta);
  if (navLoading) return navLoading;
  navLoading = Promise.all([
    fetch(`${base}/meta.json`).then(r => r.json()),
    fetch(`${base}/fixes.json`).then(r => r.json()),
    fetch(`${base}/navaids.json`).then(r => r.json()),
    fetch(`${base}/airways.json`).then(r => r.json()),
    fetch(`${base}/procedures.json`).then(r => r.json()),
    fetch(`${base}/preferred.json`).then(r => r.json()),
  ]).then(([m, f, n, a, pr, pf]) => {
    meta = m;
    fixes = f || {};
    navaids = n || {};
    airways = a || {};
    procedures = pr || {};
    preferred = pf || {};
    navReady = true;
    return meta;
  }).catch(err => {
    navLoading = null;
    throw err;
  });
  return navLoading;
}

/** Seed nav data in tests or offline demo. */
export function seedNavData(data) {
  if (!data) return;
  meta = data.meta || meta;
  fixes = data.fixes || fixes;
  navaids = data.navaids || navaids;
  airways = data.airways || airways;
  procedures = data.procedures || procedures;
  preferred = data.preferred || preferred;
  navReady = true;
}
