/**
 * Dispatch Center (Airline Ops) core: DOM-free, unit-tested
 * (scripts/test-aoc-core.mjs).
 *
 * - which VATSIM callsigns belong to an operator (callsign prefix, regional
 *   partners, remarks for carriers that fly for several brands, and any
 *   callsigns the dispatcher adds to the watch list)
 * - flight phase and OOOI times (Out / Off / On / In) from feed snapshots,
 *   with a per-flight memory the page keeps between snapshots
 * - ETA, delay and alerts
 * - the shared ops state reducer (notes, acknowledged alerts, telex log),
 *   which the hub mirrors
 * - telex templates (220-character Hoppie budget) and the downlink classifier
 */

export const PHASE = {
  SCHED: "SCHED",
  GATE: "AT GATE",
  TAXI_OUT: "TAXI OUT",
  CLIMB: "CLIMB",
  CRUISE: "CRUISE",
  DESCENT: "DESCENT",
  APPROACH: "APPROACH",
  LANDED: "LANDED",
  TAXI_IN: "TAXI IN",
  ARRIVED: "ARRIVED",
  LOST: "LOST",
};

/** Board tabs by phase. */
export const PHASE_GROUP = {
  [PHASE.SCHED]: "sched",
  [PHASE.GATE]: "ground",
  [PHASE.TAXI_OUT]: "ground",
  [PHASE.CLIMB]: "enroute",
  [PHASE.CRUISE]: "enroute",
  [PHASE.DESCENT]: "enroute",
  [PHASE.LOST]: "enroute",
  [PHASE.APPROACH]: "arriving",
  [PHASE.LANDED]: "arriving",
  [PHASE.TAXI_IN]: "arriving",
  [PHASE.ARRIVED]: "arrived",
};

/** Below this ground speed an aircraft is on the ground (no feed flag for it). */
export const AIRBORNE_GS = 50;
/** Moving on the ground: pushing or taxiing. */
export const MOVING_GS = 5;
/** Rolling out after landing, above taxi speed. */
export const ROLLOUT_GS = 30;
/** Moved this far from where it was first seen parked: it has left the gate. */
export const OUT_MOVE_M = 80;
/** "At" an airport. */
export const NEAR_APT_NM = 6;
export const APPROACH_NM = 40;
export const APPROACH_ALT = 12000;
/** Stopped this long after landing: in at the gate. */
export const ARRIVED_DWELL_MS = 120000;
/** Disconnected while airborne: shown as LOST this long, in case they reconnect. */
export const LOST_MS = 15 * 60000;
/** Arrived flights stay on the board this long. */
export const KEEP_ARRIVED_MS = 2 * 3600000;
/** Parked or taxiing flights that disconnect drop off after this. */
export const KEEP_GROUND_MS = 3 * 60000;
export const LATE_DEP_MIN = 15;
export const LOW_FUEL_MIN = 45;
export const HOLD_WINDOW_MS = 8 * 60000;
export const HOLD_TURN_DEG = 300;
export const HOLD_MAX_ALT = 20000;
export const REPLY_WAIT_MS = 10 * 60000;
export const TRACK_EVERY_MS = 60000;
export const TRACK_MAX = 300;
export const TELEX_MAX = 220;

/* ---------------- geometry ---------------- */

const RAD = Math.PI / 180;
const R_NM = 3440.065;

export function distNm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Point a fraction f of the way along the great circle from a to b. */
export function gcPoint(a, b, f) {
  const d = distNm(a.lat, a.lon, b.lat, b.lon) / R_NM;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const p1 = a.lat * RAD, l1 = a.lon * RAD, p2 = b.lat * RAD, l2 = b.lon * RAD;
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
}

/** Great circle a→b as [[lat, lon]…], for a map line. */
export function gcLine(a, b, n = 48) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const p = gcPoint(a, b, i / n);
    out.push([p.lat, p.lon]);
  }
  return out;
}

/** Point `nm` along `hdg` from (lat, lon). */
export function movePoint(lat, lon, hdg, nm) {
  const d = nm / R_NM, t = hdg * RAD, p1 = lat * RAD, l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / RAD, lon: ((l2 / RAD + 540) % 360) - 180 };
}

function turn(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/* ---------------- airports ---------------- */

/**
 * Airport reference points from data/nav/runways.json
 * ({ICAO: [[rwy, lat, lon, hdg, length]…]}): the mean of the thresholds.
 */
export function airportIndex(runways) {
  const idx = new Map();
  for (const [icao, rwys] of Object.entries(runways || {})) {
    if (!Array.isArray(rwys) || !rwys.length) continue;
    let la = 0, lo = 0, n = 0;
    for (const r of rwys) {
      if (Number.isFinite(r[1]) && Number.isFinite(r[2])) { la += r[1]; lo += r[2]; n++; }
    }
    if (n) idx.set(icao, { icao, lat: la / n, lon: lo / n });
  }
  return idx;
}

/** Nearest airport within maxNm, or null. */
export function nearestAirport(idx, lat, lon, maxNm = NEAR_APT_NM) {
  let best = null, bd = maxNm;
  const dLat = maxNm / 60;
  for (const a of idx.values()) {
    if (Math.abs(a.lat - lat) > dLat) continue;
    const d = distNm(lat, lon, a.lat, a.lon);
    if (d <= bd) { bd = d; best = a; }
  }
  return best;
}

/* ---------------- operators ---------------- */

export function normCode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normCallsign(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

/**
 * What the page is watching: an operator code (from data/aoc/operators.json,
 * or any code typed in, for virtual airlines) plus extra callsigns.
 */
export function makeWatch(operators, code, callsigns = []) {
  code = normCode(code);
  const o = (operators && operators[code]) || null;
  const family = new Map();
  for (const [pfx, v] of Object.entries((o && o.family) || {})) {
    family.set(normCode(pfx), typeof v === "string" ? { name: v, shared: false } : { name: v.name || pfx, shared: !!v.shared });
  }
  return {
    code,
    known: !!o,
    name: (o && o.name) || "",
    telephony: (o && o.telephony) || "",
    hubs: (o && o.hubs) || [],
    family,
    remarks: [...((o && o.remarks) || []), `OPR/${code}`].map(s => s.toUpperCase()),
    station: (o && o.station) || (code ? `${code}OPS`.slice(0, 8) : ""),
    callsigns: new Set(callsigns.map(normCallsign).filter(Boolean)),
  };
}

function prefixMatch(cs, pfx) {
  return pfx && cs.length > pfx.length && cs.startsWith(pfx) && /^\d[A-Z0-9]*$/.test(cs.slice(pfx.length));
}

/**
 * Does this flight belong to the watch? {via, carrier} or null.
 * via: "mainline" | "family" | "remarks" (a shared regional whose remarks name
 * the brand) | "watch" (a callsign added by hand).
 */
export function matchFlight(W, callsign, remarks, { regionals = true } = {}) {
  const cs = normCallsign(callsign);
  if (!cs) return null;
  if (W.callsigns.has(cs)) return { via: "watch", carrier: "" };
  if (prefixMatch(cs, W.code)) return { via: "mainline", carrier: "" };
  if (!regionals) return null;
  for (const [pfx, f] of W.family) {
    if (!prefixMatch(cs, pfx)) continue;
    if (!f.shared) return { via: "family", carrier: f.name };
    const rmk = String(remarks || "").toUpperCase();
    if (W.remarks.some(r => rmk.includes(r))) return { via: "remarks", carrier: f.name };
    return null;
  }
  return null;
}

/* ---------------- flight plan fields ---------------- */

/** "FL350" / "35000" / "350" -> 35000 ft, or null. */
export function parseFiledAlt(s) {
  const str = String(s ?? "").toUpperCase();
  const n = Number(str.replace(/\D/g, ""));
  if (!n) return null;
  return /FL/.test(str) || n < 1000 ? n * 100 : n;
}

/** "0215" -> 135 minutes, or null. */
export function hhmmToMin(s) {
  const d = String(s ?? "").replace(/\D/g, "");
  if (!d || /^0+$/.test(d)) return null;
  const p = d.padStart(4, "0");
  const h = +p.slice(0, -2), m = +p.slice(-2);
  return m > 59 ? null : h * 60 + m;
}

/**
 * Filed departure time ("1435", HHMM Z) as epoch ms: the occurrence nearest
 * `now` (within 12 h either side), or null. Same rule as the Ramp P-time.
 */
export function stdMs(deptime, now) {
  const d = String(deptime ?? "").replace(/\D/g, "");
  if (!d || /^0+$/.test(d)) return null;
  const s = d.padStart(4, "0").slice(0, 4);
  const h = +s.slice(0, 2), m = +s.slice(2, 4);
  if (h > 23 || m > 59) return null;
  const t = new Date(now);
  let ms = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, m);
  if (ms - now > 12 * 36e5) ms -= 864e5;
  else if (now - ms > 12 * 36e5) ms += 864e5;
  return ms;
}

export function zulu(t) {
  if (t == null) return "";
  const d = new Date(t);
  return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}

/* ---------------- flight memory ---------------- */

function newMemo(leg, now) {
  return {
    leg, first: now, lastSeen: now,
    out: null, off: null, on: null, in: null,
    seenGround: false, wasAir: false, gatePos: null, stopSince: null, moved: false,
    arrAtOff: null, landedAt: null, connectedAtDest: false,
    prev: null, vs: null, hdgs: [], track: [], trackT: 0, eta: null, snap: null,
  };
}

/**
 * Seed memory with times the page could not have seen (demo history, or the
 * hub's tracker in phase 2): {callsign: {leg?, out, off, on, in}}.
 */
export function primeMemory(memory, hist, now) {
  for (const [cs, h] of Object.entries(hist || {})) {
    const m = memory.get(cs) || newMemo(h.leg || "", now);
    Object.assign(m, {
      leg: h.leg || m.leg,
      out: h.out ?? m.out, off: h.off ?? m.off, on: h.on ?? m.on, in: h.in ?? m.in,
      seenGround: true, moved: !!(h.out ?? m.out), wasAir: !!(h.off ?? m.off),
      arrAtOff: h.arr ?? m.arrAtOff,
    });
    if (h.in) m.stopSince = h.in;
    memory.set(cs, m);
  }
}

/** Memory as JSON for localStorage (tracks trimmed), and back. */
export function saveMemory(memory, now, maxAgeMs = 3 * 3600000) {
  const out = {};
  for (const [cs, m] of memory) {
    if (now - m.lastSeen > maxAgeMs) continue;
    out[cs] = { ...m, track: m.track.slice(-120), hdgs: [] };
  }
  return out;
}

export function loadMemory(obj, now, maxAgeMs = 3 * 3600000) {
  const memory = new Map();
  for (const [cs, m] of Object.entries(obj || {})) {
    if (!m || typeof m !== "object" || now - (m.lastSeen || 0) > maxAgeMs) continue;
    memory.set(cs, { ...newMemo(m.leg || "", now), ...m, hdgs: [], prev: null });
  }
  return memory;
}

/* ---------------- phases ---------------- */

function legOf(fp) {
  return `${(fp && fp.departure) || ""}-${(fp && fp.arrival) || ""}`;
}

/**
 * One feed pilot through the phase machine. Updates memory `m` and returns
 * the phase. `A(icao)` is the airport lookup.
 */
function stepPhase(m, p, fp, A, idx, now, fresh) {
  const gs = +p.groundspeed || 0;
  const alt = +p.altitude || 0;
  const dep = A(fp.departure), arr = A(fp.arrival);
  const dDep = dep ? distNm(p.latitude, p.longitude, dep.lat, dep.lon) : null;
  const dArr = arr ? distNm(p.latitude, p.longitude, arr.lat, arr.lon) : null;

  // Vertical speed (ft/min), smoothed over snapshots at least 5 s apart.
  // Only a new snapshot says anything about the climb rate (the page re-derives between feeds).
  if (!fresh) {
    /* same position as last time */
  } else if (m.prev && now - m.prev.t >= 5000) {
    const vs = Math.max(-6000, Math.min(6000, ((alt - m.prev.alt) / (now - m.prev.t)) * 60000));
    // Blend only close snapshots; after a gap the new rate stands alone.
    m.vs = m.vs == null || now - m.prev.t > 120000 ? vs : m.vs * 0.3 + vs * 0.7;
    m.prev = { t: now, alt };
  } else if (!m.prev) m.prev = { t: now, alt };

  if (gs < AIRBORNE_GS) {
    if (m.wasAir) {
      // Landed.
      if (!m.on) {
        m.on = now;
        const at = dArr != null && dArr <= NEAR_APT_NM ? arr : nearestAirport(idx, p.latitude, p.longitude, NEAR_APT_NM);
        m.landedAt = at ? at.icao : "?";
      }
      if (gs >= ROLLOUT_GS) { m.stopSince = null; return PHASE.LANDED; }
      if (gs >= MOVING_GS) { m.stopSince = null; m.taxiIn = true; return PHASE.TAXI_IN; }
      m.stopSince ||= now;
      if (now - m.stopSince >= ARRIVED_DWELL_MS) {
        m.in ||= m.stopSince;
        return PHASE.ARRIVED;
      }
      return m.taxiIn ? PHASE.TAXI_IN : PHASE.LANDED;
    }
    m.seenGround = true;
    // Connected on the ground at the destination, not the origin: this leg is already flown.
    if (!m.moved && dArr != null && dArr <= NEAR_APT_NM && (dDep == null || dDep > NEAR_APT_NM)) {
      m.connectedAtDest = true;
      return PHASE.ARRIVED;
    }
    m.gatePos ||= { lat: p.latitude, lon: p.longitude };
    const movedM = distNm(p.latitude, p.longitude, m.gatePos.lat, m.gatePos.lon) * 1852;
    if (!m.moved && (gs >= MOVING_GS || movedM > OUT_MOVE_M)) {
      m.moved = true;
      m.out = now;
    }
    return m.moved ? PHASE.TAXI_OUT : PHASE.GATE;
  }

  // Airborne.
  if (!m.wasAir) {
    m.wasAir = true;
    if (m.seenGround) {
      m.off = now;
      m.out ||= now;
    }
    m.arrAtOff = fp.arrival || "";
  }
  m.stopSince = null;
  if (dArr != null && dArr <= APPROACH_NM && alt < APPROACH_ALT) return PHASE.APPROACH;
  if (m.vs != null) {
    if (m.vs > 400) return PHASE.CLIMB;
    if (m.vs < -400) return PHASE.DESCENT;
    return PHASE.CRUISE;
  }
  const filed = parseFiledAlt(fp.altitude);
  if (filed && alt < filed - 2000) return dDep != null && dArr != null && dDep < dArr ? PHASE.CLIMB : PHASE.DESCENT;
  return PHASE.CRUISE;
}

/** Holding: at least HOLD_TURN_DEG of turn one way in the last HOLD_WINDOW_MS, below HOLD_MAX_ALT. */
export function isHolding(hdgs, now) {
  const h = hdgs.filter(x => now - x.t <= HOLD_WINDOW_MS);
  if (h.length < 4) return false;
  let sum = 0;
  for (let i = 1; i < h.length; i++) sum += turn(h[i - 1].h, h[i].h);
  return Math.abs(sum) >= HOLD_TURN_DEG;
}

/**
 * The board rows. `ctx`: {W, A (icao -> {lat, lon}|null), idx (airport index
 * for "where did it land"), regionals}. `feed`: {pilots, prefiles}. `memory`
 * is kept by the caller between snapshots.
 */
export function deriveFlights(ctx, feed, memory, now) {
  const { W, A = () => null, idx = new Map(), regionals = true } = ctx;
  const rows = [];
  const seen = new Set();

  for (const p of feed.pilots || []) {
    const fp = p.flight_plan || {};
    const match = matchFlight(W, p.callsign, fp.remarks, { regionals });
    if (!match) continue;
    const cs = normCallsign(p.callsign);
    seen.add(cs);
    const leg = legOf(fp);
    let m = memory.get(cs);
    // A new leg once the last one is finished (or never started): start over.
    if (!m || (m.leg !== leg && (!m.wasAir || m.in || m.connectedAtDest) && (+p.groundspeed || 0) < AIRBORNE_GS)) {
      m = newMemo(leg, now);
      memory.set(cs, m);
    }
    m.lastSeen = now;
    const key = `${p.latitude},${p.longitude},${p.altitude},${p.heading}`;
    const fresh = key !== m.lastKey;
    m.lastKey = key;
    const phase = stepPhase(m, p, fp, A, idx, now, fresh);
    // Heading history (holding) and flown track.
    if (fresh && phase !== PHASE.GATE && phase !== PHASE.ARRIVED) {
      m.hdgs.push({ t: now, h: +p.heading || 0 });
      while (m.hdgs.length && now - m.hdgs[0].t > HOLD_WINDOW_MS) m.hdgs.shift();
    }
    if (m.wasAir && (now - m.trackT >= TRACK_EVERY_MS || !m.track.length)) {
      m.track.push([+p.latitude.toFixed(4), +p.longitude.toFixed(4)]);
      if (m.track.length > TRACK_MAX) m.track.shift();
      m.trackT = now;
    }
    const row = buildRow(ctx, m, p, fp, match, phase, now, true);
    m.snap = { ...row, alerts: undefined, connected: false };
    rows.push(row);
  }

  // Watched flights no longer in the feed.
  for (const [cs, m] of memory) {
    if (seen.has(cs)) continue;
    const gone = now - m.lastSeen;
    const s = m.snap;
    if (!s) { if (gone > KEEP_ARRIVED_MS) memory.delete(cs); continue; }
    if (m.wasAir && !m.on && gone <= LOST_MS) {
      rows.push({ ...s, phase: PHASE.LOST, connected: false, gs: 0, alerts: [{ key: "lost", level: "bad", text: `Lost contact ${Math.round(gone / 60000)} min ago` }] });
    } else if ((m.in || m.on || m.connectedAtDest) && now - (m.in || m.on || m.lastSeen) <= KEEP_ARRIVED_MS) {
      rows.push({ ...s, phase: PHASE.ARRIVED, in: m.in || m.stopSince || s.in, connected: false, gs: 0, alerts: [] });
    } else if (gone > (m.wasAir ? LOST_MS : KEEP_GROUND_MS)) {
      memory.delete(cs);
    } else if (!m.wasAir) {
      rows.push({ ...s, connected: false, alerts: [] });
    }
  }

  // Filed but not connected.
  for (const pf of feed.prefiles || []) {
    const fp = pf.flight_plan || {};
    const cs = normCallsign(pf.callsign);
    if (seen.has(cs) || rows.some(r => r.callsign === cs)) continue;
    const match = matchFlight(W, cs, fp.remarks, { regionals });
    if (!match) continue;
    rows.push(buildRow(ctx, null, null, fp, match, PHASE.SCHED, now, false, cs));
  }
  return rows;
}

function buildRow(ctx, m, p, fp, match, phase, now, connected, csOverride) {
  const { A = () => null } = ctx;
  const cs = csOverride || normCallsign(p.callsign);
  const std = stdMs(fp.deptime, now);
  const eet = hhmmToMin(fp.enroute_time);
  const fuel = hhmmToMin(fp.fuel_time);
  const dep = A(fp.departure), arr = A(fp.arrival);
  const lat = p ? +p.latitude : dep ? dep.lat : null;
  const lon = p ? +p.longitude : dep ? dep.lon : null;
  const gs = p ? +p.groundspeed || 0 : 0;
  const distTotal = dep && arr ? distNm(dep.lat, dep.lon, arr.lat, arr.lon) : null;
  const distToGo = arr && lat != null ? distNm(lat, lon, arr.lat, arr.lon) : null;
  const filedEta = std != null && eet != null ? std + eet * 60000 : null;

  let eta = null;
  if (m && m.on) eta = m.on;
  else if (m && m.wasAir && distToGo != null && gs > 80) {
    const raw = now + (distToGo / gs) * 3600000;
    // Smooth it: ground speed jumps with wind and turns.
    m.eta = m.eta == null ? raw : m.eta * 0.7 + raw * 0.3;
    eta = m.eta;
  } else if (eet != null) {
    const offAt = (m && m.off) || Math.max(std ?? now, now) + (m && m.out ? 0 : 10 * 60000);
    eta = offAt + eet * 60000;
  }

  let delay = null;
  if (m && m.wasAir && eta != null && filedEta != null) delay = Math.round((eta - filedEta) / 60000);
  else if (std != null) delay = Math.round((((m && m.out) || Math.max(now, std)) - std) / 60000);

  const row = {
    callsign: cs,
    carrier: match.carrier,
    via: match.via,
    type: String(fp.aircraft_short || fp.aircraft || "").split("/")[0].toUpperCase(),
    dep: fp.departure || "",
    arr: fp.arrival || "",
    altn: fp.alternate || "",
    route: fp.route || "",
    remarks: fp.remarks || "",
    filedAlt: parseFiledAlt(fp.altitude),
    lat, lon,
    alt: p ? +p.altitude || 0 : 0,
    gs,
    hdg: p ? +p.heading || 0 : 0,
    squawk: p ? String(p.transponder || "") : "",
    cid: p ? p.cid : null,
    phase,
    connected,
    std, eet, fuel, filedEta, eta, delay,
    out: m ? m.out : null, off: m ? m.off : null, on: m ? m.on : null, in: m ? m.in : null,
    landedAt: m ? m.landedAt : null,
    distTotal, distToGo,
    track: m ? m.track : [],
    alerts: [],
  };
  row.alerts = alertsFor(row, m, now);
  return row;
}

/** Alerts for one row: {key, level: "bad"|"warn", text}. */
export function alertsFor(r, m, now) {
  const out = [];
  if (["7500", "7600", "7700"].includes(r.squawk)) {
    const what = { 7500: "hijack", 7600: "radio failure", 7700: "emergency" }[r.squawk];
    out.push({ key: `sq${r.squawk}`, level: "bad", text: `Squawk ${r.squawk} (${what})` });
  }
  if (m && m.wasAir && !m.on && m.arrAtOff && r.arr && r.arr !== m.arrAtOff) {
    out.push({ key: `div-${r.arr}`, level: "bad", text: `Diverting to ${r.arr} (filed ${m.arrAtOff})` });
  }
  if (m && m.on && m.landedAt && m.landedAt !== r.arr) {
    out.push({ key: `ldg-${m.landedAt}`, level: "bad", text: m.landedAt === "?" ? `Landed away from ${r.arr}` : `Landed at ${m.landedAt}, not ${r.arr}` });
  }
  if ((r.phase === PHASE.GATE || r.phase === PHASE.SCHED) && r.std != null && now - r.std > LATE_DEP_MIN * 60000) {
    out.push({ key: "late", level: "warn", text: `Late departure +${Math.round((now - r.std) / 60000)} min` });
  }
  if (m && m.wasAir && !m.on && r.alt < HOLD_MAX_ALT && isHolding(m.hdgs, now)) {
    out.push({ key: "hold", level: "warn", text: "Holding" });
  }
  if (m && m.off && r.fuel != null && r.eta != null && !m.on) {
    const reserve = Math.round((m.off + r.fuel * 60000 - r.eta) / 60000);
    if (reserve < LOW_FUEL_MIN) out.push({ key: "fuel", level: reserve < 30 ? "bad" : "warn", text: `Fuel ~${Math.max(0, reserve)} min at ETA` });
  }
  return out;
}

/* ---------------- shared ops state ---------------- */

export function emptyState(op) {
  return { op, rev: 0, flights: {}, log: [] };
}

function entry(state, cs) {
  return (state.flights[cs] ||= { msgs: [], note: "", ack: {} });
}

/**
 * Apply one op to the shared state (mutates; returns {ok, error?}). The demo
 * store and the hub (aoc.py) apply the same ops.
 *   {op: "note", callsign, note}
 *   {op: "ack", callsign, key}            acknowledge an alert
 *   {op: "msg", callsign, dir, text}      telex log (the hub adds these on send / poll)
 */
export function applyOp(state, o, by, now) {
  const cs = normCallsign(o.callsign);
  if (!cs) return { ok: false, error: "No callsign" };
  const e = entry(state, cs);
  if (o.op === "note") {
    e.note = String(o.note || "").slice(0, 500);
    state.log.push({ t: now, by, text: `${cs} note ${e.note ? "updated" : "cleared"}` });
  } else if (o.op === "ack") {
    if (!o.key) return { ok: false, error: "No alert" };
    e.ack[o.key] = now;
    state.log.push({ t: now, by, text: `${cs} alert acknowledged` });
  } else if (o.op === "msg") {
    const text = String(o.text || "").toUpperCase().slice(0, 500);
    if (!text) return { ok: false, error: "Empty message" };
    e.msgs.push({ t: now, dir: o.dir === "dn" ? "dn" : "up", text, by: o.dir === "dn" ? cs : by });
    if (e.msgs.length > 50) e.msgs.splice(0, e.msgs.length - 50);
    if (o.dir !== "dn") state.log.push({ t: now, by, text: `Telex to ${cs}` });
  } else {
    return { ok: false, error: `Unknown op ${o.op}` };
  }
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  state.rev++;
  return { ok: true };
}

/** Every telex in the state, newest first: [{callsign, t, dir, text, by}]. */
export function allMessages(state) {
  const out = [];
  for (const [cs, e] of Object.entries(state.flights || {})) for (const m of e.msgs || []) out.push({ callsign: cs, ...m });
  return out.sort((a, b) => b.t - a.t);
}

/**
 * An uplink that asked for an answer (REPLY / ADVISE / REQUEST) with no
 * downlink since, older than REPLY_WAIT_MS: the alert, or null.
 */
export function pendingReply(e, now) {
  const msgs = (e && e.msgs) || [];
  let lastUp = null;
  for (const m of msgs) {
    if (m.dir === "up") lastUp = /\b(REPLY|ADVISE|REQUEST|REQ)\b/.test(m.text) ? m : null;
    else lastUp = null;
  }
  if (!lastUp || now - lastUp.t < REPLY_WAIT_MS) return null;
  return { key: `reply-${lastUp.t}`, level: "warn", text: `No reply to telex sent ${zulu(lastUp.t)}` };
}

/* ---------------- telex ---------------- */

export function opsPrefix(W) {
  return `${W.code || "OPS"} OPS:`;
}

export const TEMPLATES = [
  { id: "free", label: "Free text" },
  { id: "release", label: "Dispatch release" },
  { id: "gate", label: "Arrival gate" },
  { id: "wx", label: "Weather (METAR)" },
  { id: "eta", label: "Request ETA / fuel" },
  { id: "delay", label: "Arrival delays" },
  { id: "divert", label: "Divert" },
];

function fl(ft) {
  return ft ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : "";
}

function hhmm(min) {
  return min == null ? "" : String(Math.floor(min / 60)).padStart(2, "0") + String(min % 60).padStart(2, "0");
}

/**
 * Telex text for a template. `x`: {gate, icao, metar}. Always <= TELEX_MAX
 * (a long METAR is cut, never the instruction).
 */
export function composeTelex(tpl, W, r, x = {}) {
  const P = opsPrefix(W);
  let t;
  switch (tpl) {
    case "release":
      t = `${P} RELEASE ${r.callsign} ${r.dep}-${r.arr} ${r.type}.` +
        (r.altn ? ` ALTN ${r.altn}.` : "") + (r.filedAlt ? ` ${fl(r.filedAlt)}.` : "") +
        (r.eet != null ? ` EET ${hhmm(r.eet)}.` : "") + " HAVE A GOOD FLIGHT.";
      break;
    case "gate":
      t = `${P} ARR GATE ${x.gate || "___"} AT ${r.arr}. REPLY WILCO.`;
      break;
    case "wx": {
      const head = `${P} `;
      const body = x.metar ? String(x.metar).toUpperCase().replace(/\s+/g, " ").trim() : `${x.icao || r.arr} METAR NOT AVAILABLE.`;
      t = head + body;
      if (t.length > TELEX_MAX) t = t.slice(0, TELEX_MAX - 3).replace(/\s+\S*$/, "") + "...";
      break;
    }
    case "eta":
      t = `${P} REQUEST ETA ${r.arr} AND FUEL REMAINING.`;
      break;
    case "delay":
      t = `${P} EXPECT ARRIVAL DELAYS AT ${r.arr}. ADVISE FUEL REMAINING.`;
      break;
    case "divert":
      t = `${P} DIVERT ${x.icao || r.altn || "___"}. ADVISE ETA AND FUEL. REPLY WILCO.`;
      break;
    default:
      t = `${P} `;
  }
  return t.length > TELEX_MAX ? t.slice(0, TELEX_MAX) : t;
}

/**
 * Classify a pilot downlink: {kind, icao?}. kind: wilco | unable | roger |
 * gate | wx | delay | divert | other.
 */
export function classifyDownlink(text) {
  const t = String(text || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const icao = (re) => { const m = t.match(re); return m ? m[1] : ""; };
  if (/^(WILCO|WILL COMPLY)\b/.test(t)) return { kind: "wilco" };
  if (/^(UNABLE|NEGATIVE)\b/.test(t)) return { kind: "unable" };
  if (/^(ROGER|RGR|ACK|COPY|THANKS|THX)\b/.test(t)) return { kind: "roger" };
  if (/\bDIVERT(ING)?\b/.test(t)) return { kind: "divert", icao: icao(/\bDIVERT(?:ING)?(?: TO)? ([A-Z]{4})\b/) };
  if (/\b(REQ(UEST)?|NEED)( A| ARR| ARRIVAL)? (GATE|STAND|PARKING)\b/.test(t) || /^(GATE|STAND)\b/.test(t)) return { kind: "gate" };
  if (/\b(WX|METAR|WEATHER)\b/.test(t)) return { kind: "wx", icao: icao(/\b(?:WX|METAR|WEATHER)(?: FOR)? ([A-Z]{4})\b/) || icao(/\b([A-Z]{4}) (?:WX|METAR|WEATHER)\b/) };
  if (/\b(DELAY(ED)?|DLA|MX|MAINT(ENANCE)?|LATE)\b/.test(t)) return { kind: "delay" };
  return { kind: "other" };
}

/** The template that answers a downlink, or null. */
export function replyTemplateFor(kind) {
  return { gate: "gate", wx: "wx", divert: "divert" }[kind] || null;
}
