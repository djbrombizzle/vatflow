/**
 * EDST R/Y/A conflict probe — aircraft-to-aircraft and aircraft-to-SAA.
 *
 * R (red):    A–A ≤ 5 NM
 * Y (yellow): A–A 5–12 NM
 * A (orange): within 3 NM of Special Activity Airspace (SUA)
 *
 * Muted = conflict only appears when projecting an uncleared altitude change
 * (assigned alt ≠ present alt, and no altitude uplink pending WILCO).
 *
 * No audio — visual only.
 */

const RED_NM = 5;
const YELLOW_NM = 12;
const SAA_NM = 3;
const VERT_FT = 2000;          // treat as conflict if |Δalt| < this
const SAMPLE_NM = 8;           // route sample spacing
const LOOKAHEAD_NM = 120;      // max route look-ahead
const TIME_STEP_MIN = 0.5;     // synchronized probe time step (minutes)

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toR = d => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function destPoint(lat, lon, brgDeg, distNm) {
  const R = 3440.065;
  const brg = (brgDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180, lon1 = (lon * Math.PI) / 180;
  const ang = distNm / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
    Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [(lat2 * 180) / Math.PI, (((lon2 * 180) / Math.PI + 540) % 360) - 180];
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toR = d => (d * Math.PI) / 180;
  const φ1 = toR(lat1), φ2 = toR(lat2), Δλ = toR(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function inRing(lat, lon, ring) {
  // ring: [[lon,lat],...] GeoJSON
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function distToSegmentNm(lat, lon, aLat, aLon, bLat, bLon) {
  // Approximate local NM projection
  const cos = Math.cos((lat * Math.PI) / 180);
  const ax = (aLon - lon) * 60 * cos, ay = (aLat - lat) * 60;
  const bx = (bLon - lon) * 60 * cos, by = (bLat - lat) * 60;
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? (-ax * abx - ay * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * abx, py = ay + t * aby;
  return Math.hypot(px, py);
}

function distToPolygonNm(lat, lon, rings) {
  for (const ring of rings) {
    if (inRing(lat, lon, ring)) return 0;
  }
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const d = distToSegmentNm(lat, lon, lat1, lon1, lat2, lon2);
      if (d < best) best = d;
    }
  }
  return best;
}

function flToFt(fl) {
  return (fl == null ? 0 : +fl) * 100;
}

/**
 * Build time-tagged samples along remaining route.
 * @returns {{lat,lon,tMin,altFl,projected}[]}
 */
export function buildProbeSamples(ac, opts = {}) {
  const lat = ac.lat != null ? +ac.lat : null;
  const lon = ac.lon != null ? +ac.lon : null;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const curFl = ac.alt != null ? +ac.alt : (ac.fl != null ? +ac.fl : 0);
  const assigned = opts.assignedFl != null ? +opts.assignedFl : null;
  const uncleared = !!(assigned != null && Math.abs(assigned - curFl) >= 5 && !opts.altPending);
  const targetFl = assigned != null ? assigned : curFl;
  const gs = Math.max(120, +(ac.gs || 0) || 400); // kt
  const nmPerMin = gs / 60;

  // Collect path points: now → remaining fixes
  const pts = [[lat, lon]];
  const fixes = ac.routeFixes || ac.route_fixes || [];
  if (Array.isArray(fixes)) {
    for (const x of fixes) {
      const la = x.lat != null ? +x.lat : (x.latitude != null ? +x.latitude : null);
      const lo = x.lon != null ? +x.lon : (x.longitude != null ? +x.longitude : null);
      if (la == null || lo == null || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
      const prev = pts[pts.length - 1];
      if (haversineNm(prev[0], prev[1], la, lo) < 0.5) continue;
      pts.push([la, lo]);
    }
  }
  // Dead-reckon ahead if no route
  if (pts.length < 2 && ac.hdg != null) {
    pts.push(destPoint(lat, lon, +ac.hdg, Math.min(LOOKAHEAD_NM, 40)));
  }

  const samples = [];
  let traveled = 0;
  let tMin = 0;
  samples.push({
    lat, lon, tMin: 0, altFl: curFl, projected: false,
  });

  for (let i = 0; i < pts.length - 1; i++) {
    const [aLat, aLon] = pts[i];
    const [bLat, bLon] = pts[i + 1];
    const segNm = haversineNm(aLat, aLon, bLat, bLon);
    if (segNm < 0.1) continue;
    const brg = bearingDeg(aLat, aLon, bLat, bLon);
    let along = 0;
    while (along + SAMPLE_NM < segNm && traveled < LOOKAHEAD_NM) {
      along += SAMPLE_NM;
      traveled += SAMPLE_NM;
      tMin = traveled / nmPerMin;
      const [sLat, sLon] = destPoint(aLat, aLon, brg, along);
      // Blend altitude toward assigned over first ~40 NM. Mark projected
      // (muted) only when the maneuver is uncleared — cleared climbs still
      // project for vertical math but stay bright if they conflict.
      let altFl = curFl;
      let projected = false;
      if (assigned != null && Math.abs(assigned - curFl) >= 5) {
        const frac = Math.min(1, traveled / 40);
        altFl = curFl + (targetFl - curFl) * frac;
        projected = uncleared && Math.abs(altFl - curFl) >= 3;
      }
      samples.push({ lat: sLat, lon: sLon, tMin, altFl, projected });
      if (traveled >= LOOKAHEAD_NM) break;
    }
    traveled += segNm - along;
    tMin = traveled / nmPerMin;
    if (traveled <= LOOKAHEAD_NM) {
      let altFl = curFl;
      let projected = false;
      if (assigned != null && Math.abs(assigned - curFl) >= 5) {
        const frac = Math.min(1, traveled / 40);
        altFl = curFl + (targetFl - curFl) * frac;
        projected = uncleared && Math.abs(altFl - curFl) >= 3;
      }
      samples.push({ lat: bLat, lon: bLon, tMin, altFl, projected });
    }
    if (traveled >= LOOKAHEAD_NM) break;
  }
  return samples;
}

/** Interpolate sample path to a common clock time (minutes from now). */
function sampleAtTime(samples, tMin) {
  if (!samples || !samples.length) return null;
  if (tMin <= samples[0].tMin) return samples[0];
  const last = samples[samples.length - 1];
  if (tMin >= last.tMin) return last;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (tMin > b.tMin) continue;
    const span = b.tMin - a.tMin;
    const u = span > 1e-6 ? (tMin - a.tMin) / span : 0;
    return {
      lat: a.lat + (b.lat - a.lat) * u,
      lon: a.lon + (b.lon - a.lon) * u,
      tMin,
      altFl: a.altFl + (b.altFl - a.altFl) * u,
      projected: !!(a.projected || b.projected),
    };
  }
  return last;
}

function considerHit(bestRed, bestYel, d, muted) {
  function better(best, dist, isMuted) {
    if (!best) return { dist, muted: isMuted };
    // Prefer bright (non-muted) over muted whenever both exist
    if (best.muted && !isMuted) return { dist, muted: false };
    if (!best.muted && isMuted) return best;
    if (dist < best.dist) return { dist, muted: isMuted };
    return best;
  }
  if (d <= RED_NM) return [better(bestRed, d, muted), bestYel];
  if (d <= YELLOW_NM) return [bestRed, better(bestYel, d, muted)];
  return [bestRed, bestYel];
}

/**
 * Pair two aircraft by comparing positions at the same clock times.
 * (Loose time-slack pairing falsely flags parallel tracks when one sample
 * reaches the other's present position minutes later.)
 */
function pairConflicts(sa, sb) {
  let bestRed = null;   // {dist, muted}
  let bestYel = null;
  if (!sa.length || !sb.length) return { red: null, yellow: null };

  const tMax = Math.min(sa[sa.length - 1].tMin, sb[sb.length - 1].tMin);
  for (let t = 0; t <= tMax + 1e-9; t += TIME_STEP_MIN) {
    const a = sampleAtTime(sa, t);
    const b = sampleAtTime(sb, t);
    if (!a || !b) continue;
    const vert = Math.abs(flToFt(a.altFl) - flToFt(b.altFl));
    if (vert >= VERT_FT) continue;
    const d = haversineNm(a.lat, a.lon, b.lat, b.lon);
    const muted = !!(a.projected || b.projected);
    [bestRed, bestYel] = considerHit(bestRed, bestYel, d, muted);
  }

  // Current-position check (always bright if conflict now)
  const vert0 = Math.abs(flToFt(sa[0].altFl) - flToFt(sb[0].altFl));
  if (vert0 < VERT_FT) {
    const d0 = haversineNm(sa[0].lat, sa[0].lon, sb[0].lat, sb[0].lon);
    if (d0 <= RED_NM) bestRed = { dist: d0, muted: false };
    else if (d0 <= YELLOW_NM && !bestRed) bestYel = { dist: d0, muted: false };
  }
  return { red: bestRed, yellow: bestYel };
}

// ---- SUA cache ----
let suaPolys = []; // [{rings, floorFt, ceilFt, type, name}]
let suaLoaded = false;
let suaLoading = null;

function ingestSua(geo) {
  suaPolys = [];
  for (const f of (geo && geo.features) || []) {
    const p = f.properties || {};
    const g = f.geometry;
    if (!g) continue;
    const rings = [];
    if (g.type === "Polygon" && g.coordinates.length) rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") {
      g.coordinates.forEach(poly => poly.length && rings.push(poly[0]));
    }
    if (!rings.length) continue;
    suaPolys.push({
      rings,
      floorFt: p.floorFt != null ? +p.floorFt : 0,
      ceilFt: p.ceilFt != null ? +p.ceilFt : 60000,
      type: p.type || "",
      name: p.name || p.id || "",
    });
  }
  suaLoaded = suaPolys.length > 0;
  return suaPolys.length;
}

export function isSuaReady() { return suaLoaded; }

/** Test/helper: inject SUA polygons (GeoJSON FeatureCollection or features[]). */
export function setSuaFeatures(geo) {
  return ingestSua(geo && geo.type === "FeatureCollection" ? geo : { features: geo || [] });
}

export async function loadSuaData(baseUrl = "") {
  if (suaLoaded) return suaPolys.length;
  if (suaLoading) return suaLoading;
  const root = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  suaLoading = (async () => {
    // Prefer gzip (small); fall back to raw JSON.
    try {
      const r = await fetch(root + "data/sua.geojson.gz");
      if (r.ok && typeof DecompressionStream !== "undefined") {
        const stream = r.body.pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(stream).text();
        return ingestSua(JSON.parse(text));
      }
    } catch (_) { /* fall through */ }
    try {
      const r = await fetch(root + "data/sua.geojson");
      if (r.ok) return ingestSua(await r.json());
    } catch (_) { /* ignore */ }
    return 0;
  })().finally(() => { suaLoading = null; });
  return suaLoading;
}

function countSaaHits(samples) {
  if (!suaLoaded || !samples.length) return { count: 0, muted: false };
  let count = 0;
  let anyMuted = false;
  const seen = new Set();
  for (const s of samples) {
    const altFt = flToFt(s.altFl);
    for (let i = 0; i < suaPolys.length; i++) {
      const poly = suaPolys[i];
      if (altFt < poly.floorFt - 100 || altFt > poly.ceilFt + 100) continue;
      const d = distToPolygonNm(s.lat, s.lon, poly.rings);
      if (d <= SAA_NM) {
        if (!seen.has(i)) {
          seen.add(i);
          count++;
          if (s.projected) anyMuted = true;
        }
      }
    }
  }
  return { count, muted: anyMuted && count > 0 };
}

/**
 * Probe a list of aircraft.
 * @param {object[]} aircraft — board rows with cs, lat, lon, alt, gs, hdg, routeFixes
 * @param {{ assigned?: Record<string,number>, altPending?: Set<string>,
 *           stopProbe?: Set<string>, holdActive?: Set<string>, frozen?: Set<string> }} ctx
 * @returns {Map<string, {r:number,y:number,a:number,rMuted:boolean,yMuted:boolean,aMuted:boolean,
 *                        status:null|'X'|'S'|'H'|'F', partners:{r:string[],y:string[]}}>}
 */
export function probeConflicts(aircraft, ctx = {}) {
  const assigned = ctx.assigned || {};
  const altPending = ctx.altPending || new Set();
  const stopProbe = ctx.stopProbe || new Set();
  const holdActive = ctx.holdActive || new Set();
  const frozen = ctx.frozen || new Set();

  const list = (aircraft || []).filter(a => a && a.cs);
  const out = new Map();

  const samplesBy = new Map();
  for (const a of list) {
    const cs = a.cs.toUpperCase();
    let status = null;
    if (frozen.has(cs)) status = "F";
    else if (holdActive.has(cs)) status = "H";
    else if (stopProbe.has(cs)) status = "S";
    else if (a.lat == null || a.lon == null) status = "X";

    out.set(cs, {
      r: 0, y: 0, a: 0,
      rMuted: false, yMuted: false, aMuted: false,
      status,
      partners: { r: [], y: [] },
    });

    if (status) continue;
    samplesBy.set(cs, buildProbeSamples(a, {
      assignedFl: assigned[cs],
      altPending: altPending.has(cs),
    }));
  }

  const keys = [...samplesBy.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const ca = keys[i], cb = keys[j];
      const hit = pairConflicts(samplesBy.get(ca), samplesBy.get(cb));
      if (hit.red) {
        const ea = out.get(ca), eb = out.get(cb);
        ea.r++; eb.r++;
        ea.partners.r.push(cb); eb.partners.r.push(ca);
        if (hit.red.muted) {
          if (ea.r === 1) ea.rMuted = true;
          if (eb.r === 1) eb.rMuted = true;
        } else {
          ea.rMuted = false; eb.rMuted = false;
        }
      } else if (hit.yellow) {
        const ea = out.get(ca), eb = out.get(cb);
        ea.y++; eb.y++;
        ea.partners.y.push(cb); eb.partners.y.push(ca);
        if (hit.yellow.muted) {
          if (ea.y === 1) ea.yMuted = true;
          if (eb.y === 1) eb.yMuted = true;
        } else {
          ea.yMuted = false; eb.yMuted = false;
        }
      }
    }
  }

  // If both bright and muted partners somehow — prefer bright (already handled by overwrite)

  for (const [cs, samples] of samplesBy) {
    const saa = countSaaHits(samples);
    const e = out.get(cs);
    e.a = saa.count;
    e.aMuted = !!saa.muted;
  }

  return out;
}

/** Worst GPD route severity for an aircraft: 'r'|'y'|'a'|null */
export function routeAlertSeverity(entry) {
  if (!entry || entry.status) return null;
  if (entry.r > 0) return "r";
  if (entry.y > 0) return "y";
  if (entry.a > 0) return "a";
  return null;
}
