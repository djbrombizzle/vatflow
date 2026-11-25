/**
 * EDST Graphic Plan Display (ERAM RA-Position User Manual TI 6110.101, ch. 5): data block text, range and
 * scale, future-time projection and data block placement. Pure functions, no DOM or Leaflet, so they can be
 * tested in node (scripts/test-edst-gpd.mjs). The map is shared/edst-gpd-map.js; the window is in
 * vusalink/edst/index.html.
 */

export const RANGES = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
export const FUTURE_MAX_MIN = 20;
const SCALE_STEPS = [5, 10, 15, 20, 25, 50, 75, 100, 150, 200];
const EARTH_M = 40075016.686;
const M_PER_NM = 1852;

export function pad3(n) {
  return ("000" + Math.round(Math.abs(+n || 0))).slice(-3);
}

/** Destination for line 3: US "KPIT" -> "PIT" (as ERAM shows it), others the first four characters. */
export function destShort(icao) {
  const s = String(icao || "").toUpperCase();
  if (/^K[A-Z0-9]{3}$/.test(s)) return s.slice(1);
  return s.slice(0, 4);
}

/**
 * Line 2: altitude with transition information (5.1, c).
 *  interim assigned:          "290T242" (interim, T, present)
 *  block, climbing:           "350219"  (upper, present)  · descending: "230370" (lower, present) · inside: "230B350"
 *  in conformance (±200 ft):  "350C"
 *  climbing / descending:     "350↑219" / "240↓310"
 *  nothing assigned:          "219"
 */
export function altLine({ present, assigned, interim, block }) {
  const cur = Math.round(+present || 0);
  if (block && block.length === 2) {
    const lo = Math.min(block[0], block[1]), hi = Math.max(block[0], block[1]);
    if (cur < lo - 2) return pad3(hi) + pad3(cur);
    if (cur > hi + 2) return pad3(lo) + pad3(cur);
    return pad3(lo) + "B" + pad3(hi);
  }
  if (interim != null) return pad3(interim) + "T" + pad3(cur);
  if (assigned != null) {
    const a = +assigned;
    if (Math.abs(cur - a) <= 2) return pad3(a) + "C";
    return pad3(a) + (cur < a ? "↑" : "↓") + pad3(cur);
  }
  return pad3(cur);
}

/**
 * Line 4 (5.1, e): the flight plan assigned altitude when an interim is assigned and the aircraft is climbing,
 * or the block ("290B370") while climbing or descending into it. Else "".
 */
export function line4({ present, assigned, interim, block }) {
  const cur = Math.round(+present || 0);
  if (block && block.length === 2) {
    const lo = Math.min(block[0], block[1]), hi = Math.max(block[0], block[1]);
    return (cur < lo - 2 || cur > hi + 2) ? pad3(lo) + "B" + pad3(hi) : "";
  }
  if (interim != null && assigned != null && +assigned !== +interim && cur < +interim + 3) return pad3(assigned);
  return "";
}

/**
 * Line 0 (5.1, a): alert indicators. A not-probed status (X, S, H, F) replaces each indicator (brown).
 * acked: {r, y, a} true when every problem of that type is acknowledged (shown white).
 * Returns [{sev, text, muted, acked, status}] for r, y, a (text "" when none).
 */
export function alertCells(entry, acked) {
  const out = [];
  for (const sev of ["r", "y", "a"]) {
    if (entry && entry.status) { out.push({ sev, text: entry.status, status: true }); continue; }
    const n = entry ? +entry[sev] || 0 : 0;
    out.push({ sev, text: n ? String(Math.min(9, n)) : "", muted: !!(entry && entry[sev + "Muted"]), acked: !!(acked && acked[sev]) });
  }
  return out;
}

/** Data block color: the worst unacknowledged, not muted alert ('r', 'y') or '' (white). */
export function blockSeverity(entry, acked) {
  if (!entry || entry.status) return "";
  if (entry.r && !entry.rMuted && !(acked && acked.r)) return "r";
  if (entry.y && !entry.yMuted && !(acked && acked.y)) return "y";
  return "";
}

/** Leaflet zoom that shows `rangeNm` across `widthPx` at latitude `lat` (fractional; zoomSnap 0). */
export function zoomForRange(rangeNm, widthPx, lat) {
  const c = Math.cos(((+lat || 0) * Math.PI) / 180);
  return Math.log2((EARTH_M * c * Math.max(50, widthPx)) / (M_PER_NM * Math.max(1, rangeNm))) - 8;
}

/** Range (NM across) that a zoom level shows. */
export function rangeForZoom(zoom, widthPx, lat) {
  const c = Math.cos(((+lat || 0) * Math.PI) / 180);
  return (EARTH_M * c * Math.max(50, widthPx)) / (M_PER_NM * Math.pow(2, zoom + 8));
}

/** The Range button value: the nearest step, or the value itself rounded to 5. */
export function roundRange(nm) {
  const n = Math.max(5, Math.round(+nm / 5) * 5);
  for (const r of RANGES) if (Math.abs(r - nm) / r < 0.04) return r;
  return n;
}

/** Next range step out (dir +1) or in (dir -1). */
export function stepRange(nm, dir) {
  if (dir > 0) return RANGES.find((r) => r > nm + 0.5) || RANGES[RANGES.length - 1];
  const smaller = RANGES.filter((r) => r < nm - 0.5);
  return smaller.length ? smaller[smaller.length - 1] : RANGES[0];
}

/** Range scale (5.1.2): the scale length in NM (five increments) for a range; about 1/8 of the width. */
export function scaleNm(rangeNm) {
  const want = (+rangeNm || 0) / 8;
  let best = SCALE_STEPS[0];
  for (const s of SCALE_STEPS) if (s <= want) best = s;
  return best;
}

export function distNm(la1, lo1, la2, lo2) {
  const R = 3440.065, r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destPoint(lat, lon, brgDeg, nm) {
  const R = 3440.065, d = nm / R, b = (brgDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180, lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(la2 * 180) / Math.PI, (((lo2 * 180) / Math.PI + 540) % 360) - 180];
}

export function bearingDeg(la1, lo1, la2, lo2) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(lo2 - lo1)) * Math.cos(r(la2));
  const x = Math.cos(r(la1)) * Math.sin(r(la2)) - Math.sin(r(la1)) * Math.cos(r(la2)) * Math.cos(r(lo2 - lo1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * The point `nm` along a path ([[lat,lon],...]) and the track there. Past the end: the last point.
 * @returns {{lat, lon, hdg, end: boolean}|null}
 */
export function pointAlong(coords, nm) {
  if (!coords || !coords.length) return null;
  let left = Math.max(0, +nm || 0);
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const seg = distNm(a[0], a[1], b[0], b[1]);
    const hdg = bearingDeg(a[0], a[1], b[0], b[1]);
    if (left <= seg || i === coords.length - 2) {
      if (left > seg) return { lat: b[0], lon: b[1], hdg, end: true };
      const u = seg > 1e-6 ? left / seg : 0;
      return { lat: a[0] + (b[0] - a[0]) * u, lon: a[1] + (b[1] - a[1]) * u, hdg, end: false };
    }
    left -= seg;
  }
  const last = coords[coords.length - 1];
  return { lat: last[0], lon: last[1], hdg: null, end: true };
}

/** The part of a path from its start to `nm` along it (route preview). */
export function pathUpTo(coords, nm) {
  if (!coords || coords.length < 2) return [];
  const out = [coords[0]];
  let left = Math.max(0, +nm || 0);
  for (let i = 0; i < coords.length - 1 && left > 0; i++) {
    const a = coords[i], b = coords[i + 1];
    const seg = distNm(a[0], a[1], b[0], b[1]);
    if (left >= seg) { out.push(b); left -= seg; continue; }
    const u = seg > 1e-6 ? left / seg : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    left = 0;
  }
  return out.length > 1 ? out : [];
}

/**
 * Where an aircraft will be `min` minutes from now (Future Time): along its remaining route when there is one
 * (path starts at the aircraft), else straight ahead on its heading. Ground speed below 60 kt: stays put.
 */
export function projectPosition(ac, path, min) {
  const lat = +ac.lat, lon = +ac.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const gs = +ac.gs || 0;
  if (!(min > 0) || gs < 60) return { lat, lon, hdg: +ac.hdg || 0 };
  const nm = (gs / 60) * min;
  if (path && path.length >= 2) {
    const p = pointAlong(path, nm);
    if (p) return { lat: p.lat, lon: p.lon, hdg: p.hdg != null ? p.hdg : +ac.hdg || 0 };
  }
  const [la, lo] = destPoint(lat, lon, +ac.hdg || 0, nm);
  return { lat: la, lon: lo, hdg: +ac.hdg || 0 };
}

// Leader directions tried by automatic data block offsetting, first is the default (up and right).
export const LEADER_DIRS = [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0]];

/**
 * Automatic data block offsetting (Map Options > AC Display): for each aircraft (screen x, y), pick the leader
 * direction whose block overlaps the blocks placed so far the least. Fixed order, so a block doesn't hop
 * around between redraws unless something moves into it.
 * items: [{x, y, w, h}] -> [{dx, dy}] (block's top-left offset from the position symbol)
 */
export function placeBlocks(items, { leader = 26, auto = true } = {}) {
  // Every position symbol is an obstacle too, so a block never sits on another aircraft.
  const placed = items.map((it) => ({ x: it.x - 6, y: it.y - 6, w: 12, h: 12 }));
  const out = [];
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (const it of items) {
    let best = null;
    for (const [sx, sy] of auto ? LEADER_DIRS : LEADER_DIRS.slice(0, 1)) {
      const lx = sx * leader, ly = sy * leader * 0.8;
      const dx = sx < 0 ? lx - it.w : sx > 0 ? lx : -it.w / 2;
      const dy = sy < 0 ? ly - it.h + 6 : sy > 0 ? ly - 6 : ly - it.h / 2;
      const box = { x: it.x + dx, y: it.y + dy, w: it.w, h: it.h };
      const cost = placed.reduce((s, p) => s + overlap(box, p), 0)
        + overlap(box, { x: it.x - 5, y: it.y - 5, w: 10, h: 10 });
      if (!best || cost < best.cost) best = { cost, dx, dy, lx, ly, box };
      if (cost === 0) break;
    }
    placed.push(best.box);
    out.push({ dx: best.dx, dy: best.dy, lx: best.lx, ly: best.ly });
  }
  return out;
}

/** Altitude filter (AC Display): keep aircraft between lo and hi (FL, inclusive). */
export function inAltFilter(fl, lo, hi) {
  const v = +fl || 0;
  return v >= (+lo || 0) && v <= (hi == null || hi === "" ? 999 : +hi);
}

/** ERAM lat/lon fix for a graphic trial point: 38.57N 80.67W -> "3834/08040" (DDMM/DDDMM). */
export function graphicFix(lat, lon) {
  const dm = (v) => {
    v = Math.abs(+v);
    let d = Math.floor(v), m = Math.round((v - d) * 60);
    if (m === 60) { d++; m = 0; }
    return { d, m };
  };
  const a = dm(lat), o = dm(lon);
  return String(a.d).padStart(2, "0") + String(a.m).padStart(2, "0") + "/" + String(o.d).padStart(3, "0") + String(o.m).padStart(2, "0");
}

/**
 * Graphic trial route (5.2.2): the picked points, then the rejoin fix and the rest of the route after it.
 * route: the remaining route ("LVL AML KIAD" style tokens). Returns the route string.
 */
export function graphicRoute(points, rejoin, route) {
  const t = String(route || "").trim().toUpperCase().split(/[\s.]+/).filter((x) => x && x !== "DCT");
  const fix = String(rejoin || "").toUpperCase();
  const i = t.indexOf(fix);
  const rest = i >= 0 ? t.slice(i) : (fix ? [fix] : []);
  return (points || []).map((p) => graphicFix(p[0], p[1])).concat(rest).join(" ");
}

/** Future time title (5.1.1): "Graphic Plan Display - Current Time" / "... - Future Time +5". */
export function gpdTitle(futureMin) {
  return "Graphic Plan Display - " + (futureMin > 0 ? "Future Time +" + futureMin : "Current Time");
}
