/**
 * Unattended FCA crossing archive — freeze first profile ETA, interpolate
 * the actual line crossing from consecutive VATSIM samples.
 */
import {
  AIR_MIN_GS,
  explainFcaExclusion,
  haversineNm,
  hasPassedFca,
  pathCrossing,
  plannedProfileEta,
} from "../shared/fca-metering.js";

export const LOST_MS = 15 * 60 * 1000;

export function isTrackableFca(fca) {
  return !!(fca && fca.enabled && fca.trackCrossings
    && Array.isArray(fca.points) && fca.points.length >= 2);
}

export function flightKey(p) {
  if (!p || !p.callsign) return "";
  const cid = p.cid != null && p.cid !== "" ? String(p.cid) : "0";
  const logon = p.logonTime || p.logon_time || "";
  return `${p.callsign}|${cid}|${logon}`;
}

export function vatsimToTrackPilot(p) {
  const fp = p && p.flight_plan;
  if (!fp || typeof p.latitude !== "number" || typeof p.longitude !== "number") return null;
  if (!p.callsign) return null;
  const gs = p.groundspeed || 0;
  return {
    callsign: p.callsign,
    cid: p.cid != null ? p.cid : null,
    logonTime: p.logon_time || null,
    lat: p.latitude,
    lon: p.longitude,
    alt: p.altitude || 0,
    gs,
    hdg: p.heading || 0,
    phase: gs < AIR_MIN_GS ? "gnd" : "air",
    dep: (fp.departure || "").toUpperCase(),
    arr: (fp.arrival || "").toUpperCase(),
    type: fp.aircraft_short || fp.aircraft_faa || "",
    tas: parseInt(fp.cruise_tas, 10) || 0,
    fpAlt: parseFpAlt(fp.altitude),
    deptime: fp.deptime || "",
    route: fp.route || "",
  };
}

function parseFpAlt(a) {
  if (a == null) return 0;
  a = ("" + a).toUpperCase().replace(/\s|FL/g, "");
  const n = parseInt(a, 10);
  if (isNaN(n)) return 0;
  return n < 1000 ? n * 100 : n;
}

/**
 * Interpolate when a two-sample track segment crosses the FCA polyline.
 * prev/curr: { lat, lon, t } with t in unix ms.
 */
export function interpolateTrackCrossing(prev, curr, fca) {
  if (!prev || !curr || !fca || !fca.points || fca.points.length < 2) return null;
  if (prev.lat == null || prev.lon == null || curr.lat == null || curr.lon == null) return null;
  if (!(curr.t > prev.t)) return null;
  const path = [[prev.lat, prev.lon], [curr.lat, curr.lon]];
  const x = pathCrossing(path, fca);
  if (!x) return null;
  const segNm = haversineNm(prev.lat, prev.lon, curr.lat, curr.lon);
  if (segNm < 0.01) return null;
  const frac = Math.max(0, Math.min(1, x.dist / segNm));
  return {
    lat: x.lat,
    lon: x.lon,
    actualMs: prev.t + frac * (curr.t - prev.t),
    frac,
  };
}

function cloneTrack(t) {
  return { ...t };
}

function openTrack(fca, p, planned, nowMs) {
  return {
    fca_id: fca.id,
    flight_key: flightKey(p),
    callsign: p.callsign,
    cid: p.cid != null ? p.cid : null,
    logon_time: p.logonTime || p.logon_time || null,
    dep: p.dep || null,
    arr: p.arr || null,
    route: p.route || null,
    planned_at: nowMs + planned.etaSec * 1000,
    planned_from: planned.plannedFrom,
    dist_nm_at_plan: planned.dist,
    first_seen_at: nowMs,
    last_lat: p.lat,
    last_lon: p.lon,
    last_alt: p.alt || 0,
    last_gs: p.gs || 0,
    last_hdg: p.hdg || 0,
    last_seen_at: nowMs,
    last_phase: p.phase,
    status: "open",
  };
}

function touchTrack(existing, p, nowMs) {
  const next = cloneTrack(existing);
  next.last_lat = p.lat;
  next.last_lon = p.lon;
  next.last_alt = p.alt || 0;
  next.last_gs = p.gs || 0;
  next.last_hdg = p.hdg || 0;
  next.last_seen_at = nowMs;
  next.last_phase = p.phase;
  next.status = "open";
  return next;
}

function crossingFrom(fca, track, p, hit) {
  const actualMs = Math.round(hit.actualMs);
  const plannedMs = Math.round(track.planned_at);
  return {
    fca_id: fca.id,
    fca_name: fca.name || null,
    artcc: fca.artcc || null,
    flight_key: track.flight_key,
    callsign: track.callsign,
    cid: track.cid != null ? track.cid : null,
    dep: track.dep || p.dep || null,
    arr: track.arr || p.arr || null,
    planned_at: plannedMs,
    actual_at: actualMs,
    delta_sec: Math.round((actualMs - plannedMs) / 1000),
    planned_from: track.planned_from,
    dist_nm_at_plan: track.dist_nm_at_plan,
    cross_lat: hit.lat,
    cross_lon: hit.lon,
    cross_alt: p.alt || track.last_alt || null,
    cross_gs: p.gs || track.last_gs || null,
  };
}

/**
 * Advance one FCA against the current pilot snapshot.
 * tracks: Map(flightKey -> track) mutated in place (ms timestamps).
 * completedKeys: Set of flight keys already written to fca_crossings.
 */
export function processFcaPoll(fca, pilots, tracks, completedKeys, nowMs, opts = {}) {
  const lostMs = opts.lostMs != null ? opts.lostMs : LOST_MS;
  const seen = new Set();
  const upserts = [];
  const crossings = [];
  const lost = [];

  for (const p of pilots || []) {
    if (!p || !p.callsign) continue;
    const key = flightKey(p);
    if (!key) continue;
    seen.add(key);
    if (completedKeys && completedKeys.has(key)) continue;

    const existing = tracks.get(key);
    if (existing && existing.status === "open") {
      const airborne = p.phase === "air" && (p.gs || 0) >= AIR_MIN_GS;
      if (airborne && existing.last_lat != null && existing.last_lon != null) {
        const hit = interpolateTrackCrossing(
          { lat: existing.last_lat, lon: existing.last_lon, t: existing.last_seen_at },
          { lat: p.lat, lon: p.lon, t: nowMs },
          fca,
        );
        if (hit) {
          crossings.push(crossingFrom(fca, existing, p, hit));
          tracks.delete(key);
          if (completedKeys) completedKeys.add(key);
          continue;
        }
      }
      const next = touchTrack(existing, p, nowMs);
      tracks.set(key, next);
      upserts.push(next);
      continue;
    }

    const gate = explainFcaExclusion(fca, p);
    if (!gate.included) continue;
    if (hasPassedFca(p, fca)) continue;
    const planned = plannedProfileEta(p, fca, nowMs);
    if (!planned || planned.etaSec == null || !isFinite(planned.etaSec)) continue;

    const track = openTrack(fca, p, planned, nowMs);
    tracks.set(key, track);
    upserts.push(track);
  }

  for (const [key, t] of tracks) {
    if (t.status !== "open") continue;
    if (seen.has(key)) continue;
    if (nowMs - t.last_seen_at >= lostMs) {
      const closed = cloneTrack(t);
      closed.status = "lost";
      tracks.set(key, closed);
      lost.push(closed);
    }
  }

  return { upserts, crossings, lost };
}
