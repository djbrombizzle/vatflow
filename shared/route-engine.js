/**
 * US enroute route expansion — fixes, navaids, airways, SID/STAR, preferred routes.
 * Data: data/nav/*.json (built from FAA NASR via scripts/build-nav-data.mjs).
 */

const AIRWAY_RE = /^[JQV]\d+[A-Z]?$/i;
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
    const w = proc.w;
    if (w && w.length) {
      const ll = [w[0][1], w[0][2]];
      return { name: id, ll, kind: proc.type === "STAR" ? "star" : "sid", procedure: proc };
    }
  }

  const prefix = id.match(/^([A-Z]{3,6})\d[A-Z]?$/);
  if (prefix) {
    const pfx = prefix[1];
    const matches = Object.keys(procedures).filter(k => k.startsWith(pfx) && procedures[k].type);
    if (matches.length) {
      const key = matches.find(k => k === id) || matches.sort((a, b) => a.length - b.length)[0];
      const proc = procedures[key];
      const w = proc.w;
      if (w && w.length) {
        const ll = [w[0][1], w[0][2]];
        return { name: id, ll, kind: proc.type === "STAR" ? "star" : "sid", procedure: proc };
      }
    }
  }

  return null;
}

function expandProcedure(proc, ctx) {
  if (!proc || !proc.w || proc.w.length < 2) return [];
  const out = [];
  for (const leg of proc.w) {
    const name = leg[0] || "";
    const ll = [leg[1], leg[2]];
    out.push({ name, ll, kind: proc.type === "STAR" ? "star" : "sid" });
  }
  return out;
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

/**
 * @returns {{ anchors: Array, unresolved: string[], expandedRoute: string }}
 */
export function buildRouteAnchors(p, opts = {}) {
  const dep = (p.dep || "").toUpperCase();
  const arr = (p.arr || "").toUpperCase();
  const origin = opts.origin || (dep && getAirportFn(dep) ? getAirportFn(dep).slice() : null);
  const destination = opts.destination || (arr && getAirportFn(arr) ? getAirportFn(arr).slice() : null);
  const includeNow = opts.includeNow && p.lat != null && p.lon != null;
  const routeStr = maybePreferredRoute(p);
  const tokens = parseRouteTokens(routeStr);

  const anchors = [];
  const unresolved = [];
  let refLL = origin;

  if (origin) anchors.push({ name: dep || "DEP", ll: origin.slice(), kind: "apt" });
  if (includeNow) {
    const now = [p.lat, p.lon];
    anchors.push({ name: "NOW", ll: now, kind: "now" });
    refLL = now;
  }

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const tok = cleanToken(raw);

    if (isAirwayToken(tok)) {
      let toLL = null;
      for (let j = i + 1; j < tokens.length; j++) {
        const nxt = resolveToken(tokens[j], { refLL, dep, arr });
        if (nxt) { toLL = nxt.ll; break; }
        if (isAirwayToken(tokens[j])) break;
      }
      if (!refLL) { unresolved.push(tok); continue; }
      const expanded = expandAirway(tok, refLL, toLL);
      if (!expanded.length) { unresolved.push(tok); continue; }
      for (const pt of expanded) {
        const last = anchors[anchors.length - 1];
        if (!last || last.ll[0] !== pt.ll[0] || last.ll[1] !== pt.ll[1]) {
          anchors.push(pt);
          refLL = pt.ll;
        }
      }
      continue;
    }

    const resolved = resolveToken(tok, { refLL, dep, arr });
    if (!resolved) {
      if (!hasAirportFn(tok) && tok.length >= 2) unresolved.push(tok);
      continue;
    }

    if (resolved.procedure) {
      const legs = expandProcedure(resolved.procedure, { refLL });
      for (const pt of legs) {
        const last = anchors[anchors.length - 1];
        if (!last || last.ll[0] !== pt.ll[0] || last.ll[1] !== pt.ll[1]) {
          anchors.push(pt);
          refLL = pt.ll;
        }
      }
      continue;
    }

    const last = anchors[anchors.length - 1];
    if (!last || last.ll[0] !== resolved.ll[0] || last.ll[1] !== resolved.ll[1]) {
      anchors.push(resolved);
      refLL = resolved.ll;
    }
  }

  if (destination) {
    const last = anchors[anchors.length - 1];
    if (!last || last.ll[0] !== destination[0] || last.ll[1] !== destination[1]) {
      anchors.push({ name: arr || "ARR", ll: destination.slice(), kind: "apt" });
    }
  }

  return { anchors, unresolved, expandedRoute: routeStr };
}

export function buildRoutePathLLs(p, opts = {}) {
  const { anchors } = buildRouteAnchors(p, opts);
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
  const { anchors } = buildRouteAnchors(p, opts);
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
