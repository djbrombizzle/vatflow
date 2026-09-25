/**
 * Ramp Management core: stand layout, chart projection, aircraft state
 * derivation, the push queue, and the shared-state reducer.
 *
 * DOM-free on purpose. The page, the demo simulator and the Node tests all use
 * it, and vUSAlink-hub mirrors applyOp() in ramp.py so the demo store and the
 * live hub agree on what every operation does.
 *
 * Positions come from the ramp charts: every stand, spot and lane carries the
 * chart it was read from plus its pixel x/y. Each chart has lat/lon grid
 * references, so a chart point and a VATSIM position convert both ways by
 * piecewise-linear interpolation between grid lines.
 */

export const STATES = {
  INBOUND: "INBOUND",
  TAXI_IN: "TAXI IN",
  PARKED: "PARKED",
  PUSH_REQ: "PUSH REQ",
  PUSH_HELD: "PUSH HELD",
  PUSH_APPR: "PUSH APPR",
  PUSHING: "PUSHING",
  TAXI_OUT: "TAXI OUT",
};

export const PUSH = { REQ: "REQ", HELD: "HELD", APPROVED: "APPROVED" };

/** Parked: groundspeed at or below this (kt). VATSIM reports 0 for a parked aircraft; pushbacks run 2-5 kt. */
export const PARKED_GS = 1;
/** A parked aircraft is "at" the nearest stand within this radius (m). */
export const STAND_RADIUS_M = 60;
/** Moving this slowly this close to the stand it left counts as the push. */
export const PUSH_GS = 9;
export const PUSH_RADIUS_M = 90;
/** Inbounds beyond this are not listed. */
export const INBOUND_MAX_NM = 300;
/** Hoppie packet budget, same as the vUSAlink free-text inputs. */
export const TELEX_MAX = 220;

const M_PER_NM = 1852;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export function distM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function distNm(lat1, lon1, lat2, lon2) {
  return distM(lat1, lon1, lat2, lon2) / M_PER_NM;
}

/** "N39-02.2" -> 39.036667, "W084-39.5" -> -84.658333. */
export function parseDm(s) {
  const m = /^([NSEW])(\d+)-(\d+(?:\.\d+)?)$/.exec(String(s || "").trim().toUpperCase());
  if (!m) return NaN;
  const v = Number(m[2]) + Number(m[3]) / 60;
  return m[1] === "S" || m[1] === "W" ? -v : v;
}

/** Piecewise-linear map through sorted [[from, to], ...] pairs, extrapolating at the ends. */
function interp(pairs, v) {
  if (pairs.length < 2) return NaN;
  let i = 0;
  while (i < pairs.length - 2 && v > pairs[i + 1][0]) i++;
  const [a0, b0] = pairs[i];
  const [a1, b1] = pairs[i + 1];
  if (a1 === a0) return b0;
  return b0 + ((v - a0) * (b1 - b0)) / (a1 - a0);
}

function gridPairs(refs, pixKey, geoKey) {
  return (refs || [])
    .map(r => [Number(r[pixKey]), parseDm(r[geoKey])])
    .filter(([p, g]) => Number.isFinite(p) && Number.isFinite(g))
    .sort((a, b) => a[0] - b[0]);
}

/** Build a projection for one chart. Returns null when the chart lacks a lat or lon grid. */
export function makeProjection(chart) {
  const latPix = gridPairs(chart.latRef, "y", "lat");
  const lonPix = gridPairs(chart.lonRef, "x", "lon");
  if (latPix.length < 2 || lonPix.length < 2) return null;
  const pixLat = latPix.map(([p, g]) => [g, p]).sort((a, b) => a[0] - b[0]);
  const pixLon = lonPix.map(([p, g]) => [g, p]).sort((a, b) => a[0] - b[0]);
  return {
    toLatLon: (x, y) => ({ lat: interp(latPix, y), lon: interp(lonPix, x) }),
    toXY: (lat, lon) => ({ x: interp(pixLon, lon), y: interp(pixLat, lat) }),
  };
}

/** Nearest point on a polyline. Returns {x, y, d, seg}. */
export function projectOnPolyline(pts, x, y) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { x: px, y: py, d, seg: i };
  }
  return best;
}

/** Heading in degrees (0 = north/up on the chart) from chart point a to b. */
export function chartHeading(ax, ay, bx, by) {
  const h = (Math.atan2(bx - ax, -(by - ay)) * 180) / Math.PI;
  return (h + 360) % 360;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/**
 * Index a raw layout (data/ramp/<ICAO>.json): projections per chart, stand
 * lat/lon filled from the chart grid where the file leaves them null, nose
 * headings derived from the push lane, and lookup maps.
 */
export function indexLayout(raw) {
  const L = { ...raw };
  L.proj = {};
  for (const [id, chart] of Object.entries(raw.charts || {})) {
    L.proj[id] = makeProjection(chart);
  }
  L.lanesByChart = {};
  for (const lane of raw.lanes || []) {
    (L.lanesByChart[lane.chart] ||= []).push(lane);
  }
  L.rampById = new Map((raw.ramps || []).map(r => [r.id, r]));
  L.spotById = new Map((raw.callSpots || []).map(s => [s.id, s]));
  L.stands = (raw.stands || []).map(s => {
    const st = { ...s };
    const pr = L.proj[s.chart];
    if ((st.lat == null || st.lon == null) && pr) {
      const g = pr.toLatLon(s.x, s.y);
      st.lat = g.lat;
      st.lon = g.lon;
      st.approx = true;
    }
    const lane = findLane(L, s.chart, s.pushTo);
    if (lane) {
      const p = projectOnPolyline(lane.pts, s.x, s.y);
      st.laneX = p.x;
      st.laneY = p.y;
      // Nose-in: the aircraft points away from the lane it pushes onto.
      st.noseHdg = chartHeading(p.x, p.y, s.x, s.y);
    } else {
      st.noseHdg = null;
    }
    st.group = (L.rampById.get(s.ramp) || {}).group || "";
    return st;
  });
  L.standById = new Map(L.stands.map(s => [s.id, s]));
  return L;
}

/** A stand's chart name. Two ramps can share one (Amazon A10, Concourse A A10), so the id may differ. */
export function standLabel(L, id) {
  const s = L.standById.get(id);
  return (s && s.label) || id || "";
}

export function findLane(L, chart, id) {
  if (!id) return null;
  return (L.lanesByChart[chart] || []).find(l => l.id === id) || null;
}

/** The ramp position (name + first freq) that works a ramp. */
export function positionForRamp(L, rampId) {
  return (L.positions || []).find(p => (p.owns || []).includes(rampId)) || null;
}

/**
 * Entry call spot for a stand: its push lane's spot. A lane with a spot at each
 * end (Dulles: 72 west, 73 east on taxilane B) lists both, and the stand gets
 * the nearer one.
 */
export function entrySpotFor(L, stand) {
  const map = (L.laneSpots || {})[stand.chart] || {};
  const ids = [].concat(map[stand.pushTo] || []);
  let best = null;
  for (const id of ids) {
    const sp = L.spotById.get(id);
    if (!sp) continue;
    const d = Math.hypot(sp.x - stand.x, sp.y - stand.y);
    if (!best || d < best.d) best = { sp, d };
  }
  return best ? best.sp : null;
}

/** Nearest stand to a position, within radius (m). */
export function nearestStand(L, lat, lon, radiusM = STAND_RADIUS_M) {
  let best = null;
  for (const s of L.stands) {
    if (s.lat == null || s.lon == null) continue;
    const d = distM(lat, lon, s.lat, s.lon);
    if (d <= radiusM && (!best || d < best.d)) best = { stand: s, d };
  }
  return best;
}

/** Chart and chart x/y for a position, or null when it is on neither chart. */
export function locateOnChart(L, lat, lon) {
  let best = null;
  for (const [id, pr] of Object.entries(L.proj)) {
    if (!pr) continue;
    const c = L.charts[id];
    const { x, y } = pr.toXY(lat, lon);
    if (!(x >= 0 && y >= 0 && x <= c.width && y <= c.height)) continue;
    // Prefer the chart whose centre is closest; the two KCVG charts only touch.
    const d = Math.hypot(x - c.width / 2, y - c.height / 2);
    if (!best || d < best.d) best = { chart: id, x, y, d };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

/**
 * Which operator group a flight parks with. Remarks win, then the callsign
 * match lists. Carriers that fly for both (ABX, ATN, GTI...) come back as
 * "?" with the candidate ramps, for the controller to pick.
 */
export function operatorFor(L, callsign, remarks) {
  const ops = L.operators || {};
  const rmk = String(remarks || "").toUpperCase();
  for (const [name, o] of Object.entries(ops)) {
    if (name === "shared") continue;
    if ((o.remarks || []).some(k => rmk.includes(k))) return { group: name, ramps: o.ramps || [] };
  }
  const pfx = String(callsign || "").toUpperCase().slice(0, 3);
  for (const [name, o] of Object.entries(ops)) {
    if ((o.match || []).includes(pfx)) {
      return name === "shared" ? { group: "?", ramps: o.ramps || [] } : { group: name, ramps: o.ramps || [] };
    }
  }
  return { group: "?", ramps: (L.ramps || []).map(r => r.id) };
}

/* ------------------------------------------------------------------ */
/* Shared state and the reducer (mirrored in vUSAlink-hub ramp.py)     */
/* ------------------------------------------------------------------ */

export function emptyState(icao) {
  return { icao, rev: 0, settings: { holdAll: false, spacingSec: 0 }, flights: {}, log: [], logSeq: 0 };
}

function entry(state, cs) {
  return (state.flights[cs] ||= { stand: null, push: null, callTime: null, qkey: null, sent: [], msgs: [] });
}

function addLog(state, now, by, text) {
  state.logSeq += 1;
  state.log.push({ id: state.logSeq, t: now, by, text });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

const CS_RE = /^[A-Z0-9]{2,10}$/;
const STAND_RE = /^[A-Z0-9-]{1,6}$/;

/**
 * Apply one operation to shared state. Returns {ok, error?}. `now` is epoch ms;
 * `by` is who did it (a controller callsign, "TELEX", or "DEMO").
 *
 * ops:
 *   {op:"assign", callsign, stand}            stand null clears
 *   {op:"push", callsign, push}               push: REQ | HELD | APPROVED | null
 *   {op:"move", callsign, dir}                dir -1 up / +1 down in the queue
 *   {op:"resort"}                             queue back to call order
 *   {op:"settings", holdAll?, spacingSec?}
 *   {op:"remove", callsign}
 *   {op:"reqStand", callsign}                 pilot asked for a stand (downlink)
 *   {op:"msg", callsign, dir, text}           message log line (up/dn)
 */
export function applyOp(state, o, by, now) {
  const cs = String(o.callsign || "").toUpperCase();
  const needCs = !["resort", "settings"].includes(o.op);
  if (needCs && !CS_RE.test(cs)) return { ok: false, error: "bad callsign" };
  switch (o.op) {
    case "assign": {
      const stand = o.stand == null || o.stand === "" ? null : String(o.stand).toUpperCase();
      if (stand != null && !STAND_RE.test(stand)) return { ok: false, error: "bad stand" };
      if (stand) {
        for (const [other, e] of Object.entries(state.flights)) {
          if (other !== cs && e.stand === stand) return { ok: false, error: `stand ${stand} is assigned to ${other}` };
        }
      }
      const e = entry(state, cs);
      const prev = e.stand;
      e.stand = stand;
      e.reqStand = null;
      addLog(state, now, by, stand ? `${cs} stand ${stand}${prev && prev !== stand ? ` (was ${prev})` : ""}` : `${cs} stand cleared`);
      break;
    }
    case "push": {
      const p = o.push == null ? null : String(o.push).toUpperCase();
      if (p != null && !Object.values(PUSH).includes(p)) return { ok: false, error: "bad push state" };
      const e = entry(state, cs);
      if (p && !e.callTime) {
        e.callTime = now;
        e.qkey = now;
      }
      if (!p) {
        e.callTime = null;
        e.qkey = null;
      }
      e.push = p;
      if (p === PUSH.APPROVED) e.approvedAt = now;
      addLog(state, now, by, p ? `${cs} push ${p === PUSH.REQ ? "requested" : p === PUSH.HELD ? "held" : "approved"}` : `${cs} push cleared`);
      break;
    }
    case "move": {
      const q = queueOrder(state);
      const i = q.indexOf(cs);
      const j = i + (Number(o.dir) < 0 ? -1 : 1);
      if (i < 0) return { ok: false, error: "not in the push queue" };
      if (j < 0 || j >= q.length) return { ok: true };
      const a = state.flights[cs];
      const b = state.flights[q[j]];
      [a.qkey, b.qkey] = [b.qkey, a.qkey];
      if (a.qkey === b.qkey) a.qkey += j < i ? -1 : 1;
      a.moved = true;
      addLog(state, now, by, `${cs} moved ${j < i ? "up" : "down"} in the push queue`);
      break;
    }
    case "resort": {
      for (const e of Object.values(state.flights)) {
        if (e.callTime) {
          e.qkey = e.callTime;
          e.moved = false;
        }
      }
      addLog(state, now, by, "push queue back to call order");
      break;
    }
    case "settings": {
      if (o.holdAll != null) state.settings.holdAll = !!o.holdAll;
      if (o.spacingSec != null) {
        const n = Math.round(Number(o.spacingSec));
        if (!(n >= 0 && n <= 900)) return { ok: false, error: "spacing must be 0-900 s" };
        state.settings.spacingSec = n;
      }
      addLog(state, now, by, `ramp ${state.settings.holdAll ? "HOLD ALL" : "open"}, spacing ${state.settings.spacingSec}s`);
      break;
    }
    case "remove": {
      delete state.flights[cs];
      break;
    }
    case "reqStand": {
      entry(state, cs).reqStand = now;
      addLog(state, now, by, `${cs} requests a stand`);
      break;
    }
    case "msg": {
      const text = String(o.text || "").slice(0, TELEX_MAX);
      const e = entry(state, cs);
      e.msgs.push({ t: now, dir: o.dir === "up" ? "up" : "dn", text, by });
      if (e.msgs.length > 20) e.msgs.splice(0, e.msgs.length - 20);
      break;
    }
    default:
      return { ok: false, error: "unknown op" };
  }
  state.rev += 1;
  return { ok: true };
}

/** Callsigns in the push queue, in queue order (call order unless moved). */
export function queueOrder(state) {
  return Object.entries(state.flights)
    .filter(([, e]) => e.push)
    .sort((a, b) => (a[1].qkey ?? a[1].callTime) - (b[1].qkey ?? b[1].callTime) || a[0].localeCompare(b[0]))
    .map(([cs]) => cs);
}

/**
 * Queue rows with metering applied: which aircraft is next to push, and how
 * long until the spacing allows it. Holds keep their place in line.
 */
export function queueView(state, now) {
  const { holdAll, spacingSec } = state.settings;
  const lastAppr = Math.max(0, ...Object.values(state.flights).map(e => e.approvedAt || 0));
  const waitSec = spacingSec ? Math.max(0, Math.ceil((lastAppr + spacingSec * 1000 - now) / 1000)) : 0;
  let nextGiven = false;
  return queueOrder(state).map((cs, i) => {
    const e = state.flights[cs];
    let status = e.push === PUSH.HELD || (holdAll && e.push === PUSH.REQ) ? "HELD" : e.push === PUSH.APPROVED ? "APPROVED" : "WAIT";
    let wait = 0;
    if (status === "WAIT" && !nextGiven) {
      nextGiven = true;
      status = waitSec > 0 ? "SPACING" : "READY";
      wait = waitSec;
    }
    return { pos: i + 1, callsign: cs, status, wait, callTime: e.callTime, moved: !!e.moved, stand: e.stand };
  });
}

/* ------------------------------------------------------------------ */
/* Aircraft state derivation                                           */
/* ------------------------------------------------------------------ */

/**
 * Derive the ramp picture from VATSIM pilots plus shared state.
 *
 * pilots: VATSIM feed pilots (callsign, latitude, longitude, groundspeed,
 *         altitude, heading, flight_plan{departure, arrival, aircraft_short, remarks}).
 * memory: Map callsign -> {lastStand, wasAirborne}, kept across calls so a
 *         pushing aircraft is still tied to the stand it left.
 *
 * Returns rows: {callsign, type, dep, arr, state, stand, atStand, wrongStand,
 *   chart, x, y, hdg, gs, etaMin, distNm, op, entry}.
 */
export function deriveFlights(L, pilots, state, memory, now) {
  const icao = L.icao;
  const f = L.field;
  const rows = [];
  const seen = new Set();
  for (const p of pilots || []) {
    const cs = String(p.callsign || "").toUpperCase();
    const fp = p.flight_plan || {};
    const dep = String(fp.departure || "").toUpperCase();
    const arr = String(fp.arrival || "").toUpperCase();
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dNm = distNm(lat, lon, f.lat, f.lon);
    const gs = Number(p.groundspeed) || 0;
    const onGround = dNm <= f.radiusNm && (Number(p.altitude) || 0) < f.elevFt + 300 && gs < 60;
    const e = state.flights[cs] || null;
    const mem = memory.get(cs) || {};
    if (!onGround && arr !== icao) continue;
    if (!onGround && dNm > INBOUND_MAX_NM) continue;
    seen.add(cs);
    const type = String(fp.aircraft_short || fp.aircraft || "").split("/")[0].toUpperCase();
    const op = operatorFor(L, cs, fp.remarks);
    const row = {
      callsign: cs, type, dep, arr, gs, hdg: Number(p.heading) || 0,
      op, entry: e, stand: e?.stand || null, atStand: null, wrongStand: false,
      chart: null, x: null, y: null, distNm: dNm, etaMin: null, state: null,
    };
    if (!onGround) {
      if (Number(p.altitude) > f.elevFt + 300) {
        mem.wasAirborne = true;
        mem.taxied = false;
      }
      row.state = STATES.INBOUND;
      row.etaMin = gs > 40 ? Math.round((dNm / gs) * 60) : null;
      memory.set(cs, mem);
      rows.push(row);
      continue;
    }
    const loc = locateOnChart(L, lat, lon);
    if (loc) {
      row.chart = loc.chart;
      row.x = loc.x;
      row.y = loc.y;
    }
    const near = nearestStand(L, lat, lon);
    // Moving on the ground since connecting: a stop after this is a hold on a
    // taxiway, not parking.
    if (gs > 5) mem.taxied = true;
    const arriving = mem.wasAirborne || (arr === icao && dep !== icao && !mem.parkedHere);
    if (gs <= PARKED_GS && near) {
      row.atStand = near.stand.id;
      mem.lastStand = near.stand.id;
      mem.parkedHere = true;
      mem.wasAirborne = false;
      row.wrongStand = !!(row.stand && row.stand !== near.stand.id);
      if (!row.stand) row.stand = near.stand.id;
      row.state = e?.push === PUSH.HELD ? STATES.PUSH_HELD
        : e?.push === PUSH.REQ ? (state.settings.holdAll ? STATES.PUSH_HELD : STATES.PUSH_REQ)
        : e?.push === PUSH.APPROVED ? STATES.PUSH_APPR
        : STATES.PARKED;
    } else if (gs <= PARKED_GS && !mem.taxied && !mem.wasAirborne) {
      // Stopped, has not flown or taxied since connecting, but not on a stand we know
      // (a gate the chart places a little off, or a spot we have no stand for).
      // It is parked: show it that way, with its push request, rather than taxiing.
      mem.parkedHere = true;
      mem.wasAirborne = false;
      row.unknownStand = true;
      row.state = e?.push === PUSH.HELD ? STATES.PUSH_HELD
        : e?.push === PUSH.REQ ? (state.settings.holdAll ? STATES.PUSH_HELD : STATES.PUSH_REQ)
        : e?.push === PUSH.APPROVED ? STATES.PUSH_APPR
        : STATES.PARKED;
    } else if (arriving) {
      row.state = STATES.TAXI_IN;
    } else {
      const left = mem.lastStand ? L.standById.get(mem.lastStand) : null;
      const dLeft = left ? distM(lat, lon, left.lat, left.lon) : Infinity;
      row.state = gs <= PUSH_GS && dLeft <= PUSH_RADIUS_M ? STATES.PUSHING : STATES.TAXI_OUT;
      if (left) row.stand = row.stand || left.id;
    }
    memory.set(cs, mem);
    rows.push(row);
  }
  for (const cs of memory.keys()) if (!seen.has(cs)) memory.delete(cs);
  return rows;
}

/** Colour key for a stand: empty | assigned | occupied | pushreq | pushheld. */
export function standStatuses(L, rows) {
  const out = new Map();
  for (const r of rows) {
    if (r.stand && !r.atStand && L.standById.has(r.stand) && !out.has(r.stand)) {
      if (r.state === STATES.INBOUND || r.state === STATES.TAXI_IN) out.set(r.stand, { key: "assigned", callsign: r.callsign });
    }
  }
  for (const r of rows) {
    if (!r.atStand) continue;
    const key = r.state === STATES.PUSH_REQ ? "pushreq" : r.state === STATES.PUSH_HELD ? "pushheld" : "occupied";
    out.set(r.atStand, { key, callsign: r.callsign });
  }
  return out;
}

/** First free stand on the flight's ramps: not occupied, not assigned, not maintenance. */
export function suggestStand(L, rows, op) {
  const taken = new Set();
  for (const r of rows) {
    if (r.atStand) taken.add(r.atStand);
    if (r.stand) taken.add(r.stand);
  }
  const ramps = new Set(op?.ramps || []);
  const off = s => (s.tags || []).some(t => t === "maintenance" || t === "closed");
  return L.stands.find(s => ramps.has(s.ramp) && !taken.has(s.id) && !off(s)) || null;
}

/* ------------------------------------------------------------------ */
/* Telex composer                                                      */
/* ------------------------------------------------------------------ */

function rampPrefix(L, stand) {
  const pos = stand ? positionForRamp(L, stand.ramp) : null;
  const name = pos ? pos.name.replace(/\s+CONTROL$/i, "").toUpperCase() : "RAMP";
  return `${L.icao} ${name}`;
}

function freqShort(f) {
  return String(f || "").replace(/0+$/, "").replace(/\.$/, ".0");
}

/** Stand assignment telex. */
export function composeStandTelex(L, standId, { change = false } = {}) {
  const s = L.standById.get(standId);
  if (!s) return "";
  const spot = entrySpotFor(L, s);
  const pos = positionForRamp(L, s.ramp);
  // A lane can carry its chart name ("RAMP 3 TAXILANE") and its own frequency (Ramp 3 is 130.375).
  const laneObj = findLane(L, s.chart, s.pushTo);
  const lane = laneObj?.name || (s.pushTo ? (/^[A-Z0-9]$/.test(s.pushTo) ? `TAXILANE ${s.pushTo}` : s.pushTo) : "");
  const freq = laneObj?.freq || pos?.freqs[0];
  const name = s.label || s.id;
  const parts = [`${rampPrefix(L, s)}:`, change ? `STAND CHANGE. NEW STAND ${name}.` : `PARK STAND ${name}.`];
  if (spot) parts.push(`ENTER AT SPOT ${spot.id}${lane ? ` VIA ${lane}` : ""}.`);
  else if (laneObj?.name) parts.push(`ENTER VIA ${laneObj.name}.`);
  // No CTC line when the chart gives the ramp no frequency (e.g. KDCA).
  if (pos && freq) parts.push(`CTC ${pos.name.replace(/\s+CONTROL$/i, "").toUpperCase()} ${freqShort(freq)}${spot ? ` AT SPOT ${spot.id}` : ""}.`);
  return parts.join(" ");
}

/** Push expectation telex: queue position. */
export function composePushTelex(L, standId, pos) {
  const s = L.standById.get(standId);
  return `${rampPrefix(L, s)}: PUSH REQUEST RECEIVED. YOU ARE NUMBER ${pos} FOR PUSH. ADVISE READY ON FREQ.`;
}

/** Classify a pilot downlink. Mirrors ramp.py parse_downlink(). */
export function parseDownlink(text) {
  const t = String(text || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(REQ(UEST)?|RDY|READY)( FOR)? (PUSH|PUSHBACK|PUSH BACK)\b/.test(t) || /^PUSH( BACK)?( REQ(UEST)?)?$/.test(t)) return "push";
  if (/\b(REQ(UEST)?|NEED)( A)? (STAND|GATE|PARKING|SPOT)\b/.test(t) || /^(STAND|GATE|PARKING)( REQ(UEST)?)?$/.test(t)) return "stand";
  return "other";
}
