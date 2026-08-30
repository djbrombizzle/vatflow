/**
 * RampView — live traffic.
 *
 * Polls the VATSIM datafeed, keeps a target store for one field, and dead-reckons
 * between polls. The feed refreshes every 15 s; without dead reckoning the scope
 * visibly teleports, so targets advance every frame along their own heading and
 * groundspeed and are smoothed onto each new fix.
 */

import { sizeCodeForType } from "./ramp-alloc.js";

export const VATSIM_DATA_URL = "https://data.vatsim.net/v3/vatsim-data.json";
export const POLL_MS = 15000;

const KT_TO_MPS = 0.514444;
const NM_TO_M = 1852;
const SMOOTH_TAU_MS = 2500;

/** Phases a target moves through on the surface. */
export const PHASES = ["INBOUND", "LANDED", "TAXI_IN", "IN_BLOCK", "TURN", "PUSHBACK", "TAXI_OUT", "HOLDING", "DEPARTED"];

/**
 * @param {object} p raw datafeed pilot
 * @param {object} proj projection from ramp-airport
 */
function toTarget(p, proj, fieldElevFt) {
  const fp = p.flight_plan || {};
  const [x, y] = proj.toXY(p.latitude, p.longitude);
  const agl = (p.altitude || 0) - (fieldElevFt || 0);
  return {
    callsign: String(p.callsign || "").toUpperCase(),
    cid: p.cid,
    x, y,
    lat: p.latitude, lon: p.longitude,
    hdg: p.heading || 0,
    gs: p.groundspeed || 0,
    alt: p.altitude || 0,
    agl,
    onGround: agl < 150 && (p.groundspeed || 0) < 90,
    type: (fp.aircraft_short || fp.aircraft || "").toUpperCase().split("/")[0],
    dep: (fp.departure || "").toUpperCase(),
    arr: (fp.arrival || "").toUpperCase(),
    route: fp.route || "",
    sid: firstRouteToken(fp.route),
    hasPlan: !!fp.departure,
    intl: false,
    updatedMs: Date.now(),
  };
}

/** First token of a route — good enough to show the SID on a departure tag. */
function firstRouteToken(route) {
  const t = String(route || "").trim().split(/\s+/)[0] || "";
  return /^[A-Z]{4,7}\d[A-Z]?$/.test(t) ? t : "";
}

/** Great-circle distance in NM. */
export function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class TrafficStore {
  /**
   * @param {object} opts { icao, proj, ref, elevFt, horizonNm }
   */
  constructor(opts) {
    this.icao = opts.icao;
    this.proj = opts.proj;
    this.ref = opts.ref;
    this.elevFt = opts.elevFt || 0;
    this.horizonNm = opts.horizonNm || 40;
    /** @type {Map<string, object>} */
    this.targets = new Map();
    this.lastFetchMs = 0;
    this.lastError = null;
  }

  /** Pull one datafeed snapshot and fold it into the store. */
  async poll(fetchImpl) {
    const f = fetchImpl || fetch;
    const res = await f(VATSIM_DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("datafeed HTTP " + res.status);
    const data = await res.json();
    this.ingest(data, Date.now());
    return this.targets;
  }

  /** @param {object} data datafeed JSON @param {number} nowMs */
  ingest(data, nowMs) {
    const keep = new Set();
    for (const p of data.pilots || []) {
      if (!isFinite(p.latitude) || !isFinite(p.longitude)) continue;
      const fp = p.flight_plan || {};
      const dep = (fp.departure || "").toUpperCase();
      const arr = (fp.arrival || "").toUpperCase();
      const near = distNm(p.latitude, p.longitude, this.ref[0], this.ref[1]);
      const relevant = near < 6 || ((arr === this.icao || dep === this.icao) && near < this.horizonNm);
      if (!relevant) continue;

      const t = toTarget(p, this.proj, this.elevFt);
      t.distNm = near;
      t.sizeCode = sizeCodeForType(t.type, fp.wake);
      t.intl = isIntl(dep, arr, this.icao);
      t.field = this.icao;
      const prev = this.targets.get(t.callsign);
      t.dispX = prev ? prev.dispX : t.x;
      t.dispY = prev ? prev.dispY : t.y;
      t.trail = prev ? prev.trail.slice(-30) : [];
      t.trail.push([t.x, t.y]);
      t.phase = nextPhase(prev, t, nowMs);
      t.phaseSinceMs = prev && prev.phase === t.phase ? prev.phaseSinceMs : nowMs;
      this.targets.set(t.callsign, t);
      keep.add(t.callsign);
    }
    for (const cs of [...this.targets.keys()]) {
      if (!keep.has(cs)) {
        const t = this.targets.get(cs);
        if (nowMs - t.updatedMs > 90000) this.targets.delete(cs);
      }
    }
    this.lastFetchMs = nowMs;
  }

  /**
   * Advance display positions. Called every animation frame: targets glide
   * along their own vector and converge on the last real fix.
   * @param {number} dtMs
   */
  extrapolate(dtMs) {
    const k = 1 - Math.exp(-dtMs / SMOOTH_TAU_MS);
    for (const t of this.targets.values()) {
      const d = (t.gs || 0) * KT_TO_MPS * (dtMs / 1000);
      const th = (t.hdg || 0) * Math.PI / 180;
      t.dispX += Math.sin(th) * d;
      t.dispY += Math.cos(th) * d;
      // Pull back toward the truth so error never accumulates.
      t.dispX += (t.x - t.dispX) * k;
      t.dispY += (t.y - t.dispY) * k;
    }
  }

  /** Inbounds inside the horizon, soonest first. */
  arrivals(nowMs) {
    const out = [];
    for (const t of this.targets.values()) {
      if (t.arr !== this.icao) continue;
      if (t.phase === "IN_BLOCK" || t.phase === "DEPARTED") continue;
      out.push({ ...t, etaMs: etaMs(t, nowMs) });
    }
    return out.sort((a, b) => a.etaMs - b.etaMs);
  }

  /** Departures on the surface, furthest along first. */
  departures() {
    const out = [];
    for (const t of this.targets.values()) {
      if (t.dep !== this.icao) continue;
      if (!["TURN", "PUSHBACK", "TAXI_OUT", "HOLDING"].includes(t.phase)) continue;
      out.push(t);
    }
    return out.sort((a, b) => (b.gs || 0) - (a.gs || 0));
  }
}

function isIntl(dep, arr, icao) {
  const other = dep === icao ? arr : dep;
  if (!other || other.length !== 4) return false;
  return !/^[KPC]/.test(other);
}

/** Rough ETA from range and groundspeed, floored at taxi speed. */
export function etaMs(t, nowMs) {
  const gs = Math.max(20, t.gs || 0);
  const hours = (t.distNm || 0) / gs;
  return (nowMs || Date.now()) + hours * 3600000;
}

/**
 * Surface state machine, with hysteresis carried by phaseSinceMs. Deliberately
 * conservative: a phase only advances, never flaps back and forth.
 */
export function nextPhase(prev, t, nowMs) {
  const p = prev ? prev.phase : null;
  const airborne = !t.onGround;
  const moving = (t.gs || 0) > 3;

  if (airborne) {
    if (p === "TAXI_OUT" || p === "HOLDING" || p === "PUSHBACK") return "DEPARTED";
    return t.arr === t.field ? "INBOUND" : "DEPARTED";
  }

  switch (p) {
    case null: {
      // First sight of a target already on the surface: which way it is going
      // comes from the flight plan, not from its speed. Without this, a page
      // opened mid-bank shows every taxiing departure as an arrival.
      const outbound = t.dep === t.field && t.arr !== t.field;
      if (!moving) return "IN_BLOCK";
      if (t.gs > 40) return outbound ? "TAXI_OUT" : "LANDED";
      return outbound ? "TAXI_OUT" : "TAXI_IN";
    }
    case "INBOUND":
      return moving ? (t.gs > 40 ? "LANDED" : "TAXI_IN") : "IN_BLOCK";
    case "LANDED":
      return t.gs < 40 ? "TAXI_IN" : "LANDED";
    case "TAXI_IN":
      return moving ? "TAXI_IN" : "IN_BLOCK";
    case "IN_BLOCK":
      return moving ? "PUSHBACK" : "IN_BLOCK";
    case "TURN":
      return moving ? "PUSHBACK" : "TURN";
    case "PUSHBACK":
      return nowMs - (prev.phaseSinceMs || nowMs) > 60000 && moving ? "TAXI_OUT" : "PUSHBACK";
    case "TAXI_OUT":
      return moving ? "TAXI_OUT" : "HOLDING";
    case "HOLDING":
      return moving ? "TAXI_OUT" : "HOLDING";
    default:
      return p || "TAXI_IN";
  }
}
