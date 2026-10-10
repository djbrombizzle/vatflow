/**
 * VATSMART — one-page picture of an event field and what to do about it.
 *
 * Inspired by the FAA's SMART (Strategic Management of Airspace, Routes and
 * Trajectories, 2026): pull schedules, weather, capacity and the TMIs already in
 * force into one view, look about two hours ahead, and recommend actions before
 * the arrival flow piles up instead of after.
 *
 * Pure functions on top of the existing VATFLOW math, so every number matches the
 * page it came from:
 *   - gates, MIT per gate, rolling 60-minute demand, MIT plan, in-trail spacing:
 *     shared/mit-monitor.js (same as Airport TMU's rate calculator and MIT Monitor)
 *   - weather capacity factor, TMI tiers, past-event peaks: shared/event-planner.js
 * The page (vatsmart.html) feeds it the VATSIM feed, the hub's programs / EDCTs /
 * ground stops, the NWS forecast, METAR / TAF, taxi-out times and the event calendar.
 *
 * Recommendations are advice only. Programs are still set on Airport TMU, ground
 * delays are still issued from an FCA (FCA Builder / IDST).
 */
import {
  buildMitMonitor, rollingGateDemand, gateMitTimeline, gateMitSchedule, programGateMitNm,
  calcGateMit, normRate, gateKey, NO_GATE, MIT_NOMINAL_KT,
} from "./mit-monitor.js";
import { buildMergePoints } from "./merge-points.js";
import { weatherAarFactor, THUNDER_LIKELY, THUNDER_POSSIBLE, TMI_TIERS, peakFromEvent, likelyEvents, pickBasisEvent } from "./event-planner.js";

const MIN = 60000, HOUR = 3600000;
export const HORIZON_MIN = 180;          // look this far ahead (SMART's ~2 hours, plus the hour that's landing)
export const STEP_MIN = 15;
export const EDCT_TOL_MIN = 5;           // EDCT compliance window, +/- minutes
const NEAR_START_MIN = 30;               // a gate MIT change this close is "do it now"

/* ---------------- small helpers ---------------- */

export const fmtZ = ms => {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "z";
};
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

/** "2330", "2330z", "2330Z" → the occurrence of that clock time nearest to now (ms), or null. */
export function nearestZulu(hhmm, now) {
  const s = String(hhmm || "").replace(/\D/g, "");
  if (s.length !== 4) return null;
  const h = +s.slice(0, 2), m = +s.slice(2);
  if (h > 23 || m > 59) return null;
  const d = new Date(now);
  d.setUTCHours(h, m, 0, 0);
  let t = d.getTime();
  if (t - now > 12 * HOUR) t -= 24 * HOUR;
  else if (now - t > 12 * HOUR) t += 24 * HOUR;
  return t;
}

/* ---------------- capacity ---------------- */

/**
 * The rate VATSMART plans against: the AAR typed on this page (a what-if that only
 * this page uses), else the hub program's AAR, cut for the field's forecast weather
 * the same way the Event planner does.
 * Returns { aar, capacity, source: "local"|"program"|"none", programAar, factor, reasons }.
 */
export function capacityFor({ prog, localAar = 0, wx = null }) {
  const programAar = prog && prog.aar > 0 ? prog.aar : 0;
  const aar = localAar > 0 ? localAar : programAar;
  const source = localAar > 0 ? "local" : programAar ? "program" : "none";
  const w = weatherAarFactor(wx);
  return { aar, capacity: aar ? Math.max(1, Math.round(aar * w.factor)) : 0, source, programAar, factor: w.factor, reasons: w.reasons };
}

/* ---------------- arrival queue ---------------- */

/**
 * Arrivals per 15-minute bin against capacity, carrying the backlog forward:
 * how long the queue gets if nothing is done. The first bin also takes anyone overdue.
 * Returns { bins: [{ start, n, prefiled, backlog, delayMin }], maxDelay, maxAt }.
 */
export function queueProjection(flights, now, capacity, horizonMin = HORIZON_MIN, binMin = STEP_MIN) {
  const per = capacity * binMin / 60;
  const bins = [];
  let backlog = 0, maxDelay = 0, maxAt = null;
  for (let off = 0; off < horizonMin; off += binMin) {
    const start = now + off * MIN, end = start + binMin * MIN;
    let n = 0, prefiled = 0;
    for (const f of flights) {
      if (!(f.eta < end) || (off > 0 && f.eta < start)) continue;
      n++; if (f.prefiled) prefiled++;
    }
    backlog = capacity > 0 ? Math.max(0, backlog + n - per) : 0;
    const delayMin = capacity > 0 ? Math.round(backlog / capacity * 60) : 0;
    if (delayMin > maxDelay) { maxDelay = delayMin; maxAt = start; }
    bins.push({ start, n, prefiled, backlog: Math.round(backlog * 10) / 10, delayMin });
  }
  return { bins, maxDelay, maxAt };
}

/** TMI tier for the peak hour vs capacity and the projected queue (same thresholds as the Event planner). */
export function tmiTier(ratio, maxDelay) {
  if (ratio > 1.4 || maxDelay > 45) return TMI_TIERS[3];
  if (ratio > 1.15 || maxDelay > 15) return TMI_TIERS[2];
  if (ratio > 1) return TMI_TIERS[1];
  return TMI_TIERS[0];
}

/* ---------------- EDCTs and ground stops from the hub ---------------- */

/**
 * EDCTs (hub wire: { key: { cs, t } }) for flights landing at the airport, with
 * compliance: early = airborne more than 5 min before its EDCT, late = still on
 * the ground more than 5 min after it.
 */
export function edctCompliance({ edcts, airport, pilots = [], now }) {
  const byCs = new Map(pilots.map(p => [p.callsign, p]));
  const rows = [];
  for (const k in (edcts || {})) {
    const e = edcts[k];
    if (!e || !e.cs || !(+e.t > 0)) continue;
    const p = byCs.get(e.cs);
    if (!p || String(p.arr || "").toUpperCase() !== airport) continue;
    const airborne = p.phase !== "gnd" && (p.gs || 0) > 60;
    let status = "ok";
    if (airborne && now < +e.t - EDCT_TOL_MIN * MIN) status = "early";
    else if (!airborne && now > +e.t + EDCT_TOL_MIN * MIN) status = "late";
    else if (airborne) status = "departed";
    else status = "waiting";
    rows.push({ cs: e.cs, t: +e.t, dep: p.dep, status });
  }
  rows.sort((a, b) => a.t - b.t);
  return {
    rows,
    early: rows.filter(r => r.status === "early"),
    late: rows.filter(r => r.status === "late"),
    waiting: rows.filter(r => r.status === "waiting"),
  };
}

/** Ground stops (hub wire) at the airport, with their end time resolved. */
export function groundStopsFor(groundStops, airport, now) {
  const norm = s => { s = String(s || "").toUpperCase().trim(); return s.length === 3 ? "K" + s : s; };
  const out = [];
  for (const k in (groundStops || {})) {
    const g = groundStops[k];
    if (!g || norm(g.airport) !== airport) continue;
    const untilMs = nearestZulu(g.until, now);
    out.push({ id: g.id || k, scope: String(g.scope || "").trim(), until: g.until || "", untilMs, expired: untilMs != null && untilMs < now });
  }
  return out;
}

/* ---------------- TAF ---------------- */

/**
 * The TAF itself from an api.weather.gov TAF product (WMO header, "TAFMCO", "TAF"
 * lines, then the forecast ending in "="). Returns its lines, indentation kept, or "".
 */
export function tafFromNwsProduct(text, icao) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const re = new RegExp("^(TAF\\s+(AMD\\s+|COR\\s+)?)?" + icao + "\\s+\\d{6}Z");
  const i = lines.findIndex(l => re.test(l.trim()));
  if (i < 0) return "";
  const out = [];
  for (let j = i; j < lines.length; j++) {
    const l = lines[j].replace(/\s+$/, "");
    if (!l.trim() || /^\$\$/.test(l.trim())) break;
    out.push(l);
    if (/=\s*$/.test(l)) break;
  }
  return out.join("\n").replace(/=\s*$/, "");
}

/* ---------------- departure taxi-out ---------------- */

/* same rules as the Taxi Monitor (vatflow-tbfm v2.html): the clock starts at 7 kt
   and stops at 60 kt or a 100 ft climb, for departures within 15 nm of the field */
export const TAXI_GS_START = 7, TAXI_GS_STOP = 60, TAXI_CLIMB_FT = 100, TAXI_PROX_NM = 15, TAXI_MIN_MS = 3000;
export const TAXI_SLOW_MIN = 20;         // average taxi-out that counts as a departure delay
export const TAXI_LONG_MIN = 30;         // one aircraft taxiing this long is worth a look
const TAXI_WINDOW_MS = 2 * HOUR;         // samples older than this don't describe the field now

function gcNm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Time departures' taxi-out from successive VATSIM feeds while the page is open.
 *   sessions  { callsign: { phase: "watching"|"rolling", firstSeen, startMs, baseAlt } } (mutated)
 * Returns completed samples [{ airport, callsign, startMs, endMs, durationMs }].
 */
export function trackTaxi(sessions, pilots, airport, aptLL, now) {
  const done = [];
  const seen = new Set();
  const finish = (cs, s) => {
    if (s.phase === "rolling" && now - s.startMs >= TAXI_MIN_MS)
      done.push({ airport, callsign: cs, startMs: s.startMs, endMs: now, durationMs: now - s.startMs });
    delete sessions[cs];
  };
  for (const p of pilots) {
    if (String(p.dep || "").toUpperCase() !== airport || p.lat == null || !aptLL) continue;
    const cs = p.callsign, gs = p.gs || 0, alt = p.alt || 0;
    let s = sessions[cs];
    const near = gcNm(p.lat, p.lon, aptLL[0], aptLL[1]) <= TAXI_PROX_NM;
    if (!s) {
      if (!near || gs > TAXI_GS_STOP) continue;          // already flying when first seen
      s = sessions[cs] = { phase: "watching", firstSeen: now, startMs: null, baseAlt: alt };
    }
    seen.add(cs);
    if (s.phase === "watching" && gs > TAXI_GS_START) { s.phase = "rolling"; s.startMs = now; s.baseAlt = alt; }
    if (s.phase === "rolling" && now > s.startMs && (gs > TAXI_GS_STOP || alt >= s.baseAlt + TAXI_CLIMB_FT || !near)) finish(cs, s);
  }
  for (const cs of Object.keys(sessions)) if (!seen.has(cs)) delete sessions[cs];   // disconnected
  return done;
}

/**
 * Taxi-out picture for one field from completed samples (the shared Taxi Monitor
 * log plus this page's own) and the aircraft on the ground now.
 * Returns { avgMin, trend, perHour, sampleCount, groundQueue, taxiing: [{ cs, min }], longestCs, longestMin } or null.
 */
export function taxiSummary({ samples = [], sessions = {}, now }) {
  const seen = new Set();
  const recent = samples
    .filter(x => x && now - x.endMs <= TAXI_WINDOW_MS && x.durationMs > 0)
    .sort((a, b) => b.endMs - a.endMs)
    .filter(x => { const k = x.callsign + "|" + Math.round(x.startMs / 120000); if (seen.has(k)) return false; seen.add(k); return true; });
  const last = recent.slice(0, 20);
  const avg = list => list.reduce((n, x) => n + x.durationMs, 0) / list.length / 60000;
  let trend = "stable";
  if (recent.length >= 10) {
    const d = avg(recent.slice(0, 5)) - avg(recent.slice(5, 10));
    trend = d >= 2 ? "increasing" : d <= -2 ? "decreasing" : "stable";
  }
  const taxiing = Object.entries(sessions).filter(([, s]) => s.phase === "rolling")
    .map(([cs, s]) => ({ cs, min: Math.round((now - s.startMs) / 60000) })).sort((a, b) => b.min - a.min);
  const groundQueue = Object.keys(sessions).length;
  if (!last.length && !groundQueue) return null;
  return {
    avgMin: last.length ? Math.round(avg(last)) : null, trend, sampleCount: last.length,
    perHour: recent.filter(x => now - x.endMs <= HOUR).length,
    groundQueue, taxiing, longestCs: taxiing[0] ? taxiing[0].cs : "", longestMin: taxiing[0] ? taxiing[0].min : 0,
  };
}

/* ---------------- the situation ---------------- */

/**
 * Everything VATSMART shows for one field.
 *   airport, aptLL, prog (hub program or null), localAar (AAR typed on the page)
 *   pilots, prefiles, airportLL   same as buildMitMonitor
 *   wx        worst NWS conditions over the lookahead (event-planner gridWindow) or null
 *   hub       { edcts, groundStops, restrictions } wire maps (may be empty)
 *   taxi      taxiSummary(...) for departures from the field, or null
 *   routing   { stars: starOptions(...), cdrs: { origin: CDR rows to this field } } for reroutes, or null
 *   events    upcoming VATSIM events [{ name, startMs, endMs, airports: [icao], link }]
 *   pastEvents data/event-history.json entries for the field
 *   actual    { rate: landingRate(...), holding: holdingNow(...) } from shared/arrival-track.js, or null
 *   merge     { routeOf, anchorsFor, gateIndex, artccFor, originCenter } hooks for buildMergePoints, or null
 *   config    this page's field config, or null: { closed: [gate], runways: { arr: [], dep: [], source }, ends: runways.json rows, wind: windFromMetar(...) }
 */
export function buildSituation({
  airport, aptLL, prog = null, localAar = 0, pilots = [], prefiles = [], airportLL = () => null,
  now = Date.now(), wx = null, hub = {}, taxi = null, events = [], pastEvents = [], routing = null, etaFor = null, actual = null, merge = null,
  config = null,
}) {
  const cap = capacityFor({ prog, localAar, wx });
  const program = prog || normRate({ aar: cap.aar });
  const mon = buildMitMonitor({ airport, aptLL, prog: { ...program, aar: cap.capacity || 9999 }, pilots, prefiles, airportLL, now, etaFor });

  const live = mon.flights.filter(f => !f.excluded && f.status !== "ARRIVED" && f.eta != null)
    .map(f => ({ ...f, prefiled: f.status === "PREFILE", airborne: f.status === "AIRBORNE" }));
  const expect = {};
  for (const x of program.expect || []) expect[x.gate] = x.rate;
  const roll = rollingGateDemand({ flights: live, now, horizonMin: HORIZON_MIN, stepMin: STEP_MIN, windowMin: 60, expect });
  const peakWin = roll.windows[roll.peak];
  const next60 = roll.windows[0];
  const queue = queueProjection(live, now, cap.capacity);
  const ratio = cap.capacity > 0 ? peakWin.total / cap.capacity : 0;
  const tier = cap.capacity > 0 ? tmiTier(ratio, queue.maxDelay) : null;

  /* MIT plan per gate against the weather-adjusted capacity */
  const timeline = cap.capacity > 0 ? gateMitTimeline(roll.windows, cap.capacity, MIT_NOMINAL_KT) : [];
  const gates = mon.gates.map(g => {
    const tl = timeline.find(t => t.gate === g.name);
    const nowNm = programGateMitNm(program, g.name).nm;
    const mits = tl ? tl.mits : roll.windows.map(() => 0);
    const schedule = gateMitSchedule(mits, nowNm).map(s => ({ ...s, at: roll.windows[s.i].start }));
    const peakEntry = (peakWin.entries.find(([n]) => n === g.name) || [])[1] || 0;
    return { ...g, nowNm, mits, schedule, peakDemand: peakEntry, peakMit: tl ? tl.peakMit : 0, expectedHr: expect[g.name] || 0 };
  });
  for (const t of timeline) {            // a gate with only expected demand (no inbound yet)
    if (gates.some(g => g.name === t.gate)) continue;
    const nowNm = programGateMitNm(program, t.gate).nm;
    gates.push({ name: t.gate, color: "#6b7a89", demand60: 0, inbound: 0, airborne: 0, spacing: [], tight: 0, nowNm,
      mits: t.mits, schedule: gateMitSchedule(t.mits, nowNm).map(s => ({ ...s, at: roll.windows[s.i].start })),
      peakDemand: (peakWin.entries.find(([n]) => n === t.gate) || [])[1] || 0, peakMit: t.peakMit, expectedHr: expect[t.gate] || 0 });
  }

  const counts = { airborne: 0, ground: 0, prefile: 0, arrived: 0, excluded: 0 };
  for (const f of mon.flights) {
    if (f.status === "ARRIVED") counts.arrived++;
    else if (f.excluded) counts.excluded++;
    else if (f.status === "AIRBORNE") counts.airborne++;
    else if (f.status === "GROUND") counts.ground++;
    else counts.prefile++;
  }

  const edct = edctCompliance({ edcts: hub.edcts, airport, pilots, now });
  const gs = groundStopsFor(hub.groundStops, airport, now);
  const restrictions = Object.values(hub.restrictions || {}).filter(r => r && new RegExp("\\b(" + airport + "|" + airport.replace(/^K/, "") + ")\\b", "i")
    .test([r.requesting, r.providing, r.restriction].join(" ")));

  /* the next event at (or including) this field in the next 24 h, and a past one like it */
  const upcoming = (events || []).filter(e => e.endMs > now && e.startMs < now + 24 * HOUR && (e.airports || []).includes(airport))
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
  let reference = null;
  if (upcoming) {
    const plan = { name: upcoming.name, startMs: upcoming.startMs, endMs: upcoming.endMs, fields: upcoming.airports };
    const like = likelyEvents(pastEvents, plan, 1)[0];
    const ev = like ? like.ev : pickBasisEvent(pastEvents, null, upcoming.endMs - upcoming.startMs);
    if (ev) reference = { ev, peak: peakFromEvent(ev), reasons: like ? like.reasons : ["most recent at this field"] };
  }

  const sit = {
    airport, aptLL, now, cap, prog, program, mon, flights: mon.flights, live, roll, peakWin, next60, queue, ratio, tier,
    gates, counts, edct, gs, restrictions, wx, taxi, upcoming, reference, actual,
  };
  sit.airportLL = airportLL;
  sit.slots = slotBalance(live, now, cap.capacity);
  sit.merges = merge && cap.capacity ? buildMergePoints({ ...merge, flights: live, aptLL, windows: roll.windows, capacity: cap.capacity, now }) : [];
  sit.config = config || { closed: [], runways: null, ends: [], wind: null };
  sit.closedGates = sit.config.closed || [];
  sit.closures = routing ? closedGateReroutes({ sit, stars: routing.stars, cdrs: routing.cdrs, closed: sit.closedGates }) : [];
  sit.reroutes = routing ? routeRecommendations({ sit, stars: routing.stars, cdrs: routing.cdrs }) : [];
  sit.rwyWinds = sit.config.runways ? runwayWinds(sit.config.runways.arr || [], sit.config.ends, sit.config.wind) : [];
  sit.recs = recommend(sit);
  return sit;
}

/* ---------------- route recommendations ---------------- */

export const REROUTE_MIN_DIST_NM = 150;   // airborne: too late to change the STAR inside this
export const REROUTE_MAX_EXTRA_NM = 60;   // a STAR swap that costs more than this isn't offered
const REROUTE_MAX_PER_GATE = 6;
export const CORNER_SEP_DEG = 60;          // gates closer than this in bearing from the field feed the same corner

function bearingDeg(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b) + 540) % 360 - 180);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassOf = deg => COMPASS[Math.round(deg / 45) % 8];

/** Bearing from the field to each gate: the circular mean of its STAR entry fixes. */
export function gateBearings(stars, fieldLL) {
  const acc = {};
  for (const s of stars) {
    const b = bearingDeg(fieldLL[0], fieldLL[1], s.ll[0], s.ll[1]) * Math.PI / 180;
    const a = acc[s.gate] = acc[s.gate] || [0, 0];
    a[0] += Math.sin(b); a[1] += Math.cos(b);
  }
  const out = {};
  for (const g in acc) out[g] = (Math.atan2(acc[g][0], acc[g][1]) * 180 / Math.PI + 360) % 360;
  return out;
}

/**
 * STAR entry points at a field from navdata (data/nav/procedures.json):
 * [{ star: "SNFLD3", gate: "SNFLD", fix, ll: [lat, lon] }], one per transition start
 * plus the common route's first fix, skipping points within 15 nm of the field.
 */
export function starOptions(procs, icao, fieldLL) {
  const out = [];
  for (const [name, p] of Object.entries(procs || {})) {
    if (!p || p.type !== "STAR" || !/\d[A-Z]?$/.test(name) || !(p.apt || []).includes(icao)) continue;
    const pts = Object.values(p.transitions || {}).map(t => t && t[0]).filter(Boolean);
    if (p.common && p.common[0]) pts.push(p.common[0]);
    const seen = new Set();
    for (const [fix, lat, lon] of pts) {
      if (seen.has(fix) || gcNm(lat, lon, fieldLL[0], fieldLL[1]) < 15) continue;
      seen.add(fix);
      out.push({ star: name, gate: gateKey(name), fix, ll: [lat, lon] });
    }
  }
  return out;
}

/** Last STAR (as written) in a route string, or "". */
function lastStar(route) {
  const toks = String(route || "").toUpperCase().split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) if (/^[A-Z]{3,5}\d[A-Z]?$/.test(toks[i])) return toks[i];
  return "";
}

/**
 * Concrete reroutes that move arrivals off saturated gates onto gates with room in another
 * corner of the field (CORNER_SEP_DEG or more apart in bearing): a STAR into the same corner
 * shares the same airspace and relieves nothing.
 * A gate is saturated when the peak hour gives it more arrivals than its share of
 * the rate (the MIT split), and has room when it carries less than an even share.
 * For each saturated gate, its arrivals in the peak hour, soonest first:
 *   - still on the ground / prefiled: a FAA CDR from its origin to the field that
 *     ends on a STAR into a gate with room (cdrs: { origin: [[code, depFix, route, eq, coordReq, play]] })
 *   - else (or airborne, 150+ nm out): the other gate's STAR via its nearest entry
 *     fix, when it adds no more than 60 nm.
 * Up to the gate's excess (max 6 per gate). Returns
 *   [{ gate, to, excess, demandBefore, demandAfter, added: [{ gate, before, after }], moves: [{ callsign, dep, status, eta, kind: "cdr"|"star", code?, route?, coordReq?, star, fix?, extraNm }] }]
 */
export function routeRecommendations({ sit, stars = [], cdrs = {} }) {
  const cap = sit.cap.capacity, win = sit.peakWin, apt = sit.airport;
  if (!cap || !win || win.total <= cap || !stars.length) return [];
  const fieldLL = sit.aptLL || null;
  if (!fieldLL) return [];
  const brg = gateBearings(stars, fieldLL);
  /* demand of everything feeding the same corner as gate g */
  const cornerDemand = g => win.entries.reduce((n, [o, d]) => n + (brg[o] != null && angDiff(brg[o], brg[g]) < CORNER_SEP_DEG ? d : 0), 0);
  const calc = calcGateMit(cap, win.entries, win.unassigned, MIT_NOMINAL_KT);
  const shut = new Set(sit.closedGates || []);
  const starGates = [...new Set(stars.map(s => s.gate))].filter(g => !shut.has(g));
  const demand = g => (win.entries.find(([n]) => n === g) || [])[1] || 0;
  const out = [];
  const saturated = calc.rows.filter(r => r.limited && r.demand - r.slice >= 1).sort((a, b) => (b.demand - b.slice) - (a.demand - a.slice));
  for (const sat of saturated) {
    if (brg[sat.gate] == null || shut.has(sat.gate)) continue; // no STAR geometry, or closed (closedGateReroutes moves all of it)
    const excess = Math.min(REROUTE_MAX_PER_GATE, Math.ceil(sat.demand - sat.slice));
    const flights = sit.live.filter(f => f.gate === sat.gate && f.eta >= win.start - 15 * MIN && f.eta < win.end)
      .sort((a, b) => (a.status === "AIRBORNE") - (b.status === "AIRBORNE") || a.eta - b.eta);
    /* a gate in another corner has room while its corner would still carry fewer than the saturated corner after the moves */
    const satCorner = cornerDemand(sat.gate);
    const room = {};
    for (const g of starGates) {
      if (angDiff(brg[g], brg[sat.gate]) < CORNER_SEP_DEG) continue;
      const r = Math.floor((satCorner - cornerDemand(g)) / 2);
      if (r >= 1) room[g] = r;
    }
    const used = new Set();
    const moves = [];
    for (const f of flights) {
      if (moves.length >= excess) break;
      const open = Object.keys(room).filter(g => room[g] > 0);
      if (!open.length) break;
      let move = null;
      /* a CDR first: a published route the origin's center already knows */
      if (f.status !== "AIRBORNE") {
        for (const r of (cdrs[f.dep] || [])) {
          const star = lastStar(r[2]), g = gateKey(star);
          if (!star || !open.includes(g)) continue;
          const better = !move || (used.has(g) && !used.has(move.to)) || (used.has(g) === used.has(move.to) &&
            (demand(g) < demand(move.to) || (demand(g) === demand(move.to) && r[4] !== "Y" && move.coordReq)));
          if (better)
            move = { to: g, kind: "cdr", code: r[0], route: r[2], coordReq: r[4] === "Y", star, extraNm: null };
        }
      }
      /* else swap the STAR: the other gate's nearest entry fix */
      if (!move && fieldLL) {
        const from = f.status === "AIRBORNE" && f.lat != null ? [f.lat, f.lon] : sit.airportLL ? sit.airportLL(f.dep) : null;
        if (from && !(f.status === "AIRBORNE" && (f.dist == null || f.dist < REROUTE_MIN_DIST_NM))) {
          const via = s => gcNm(from[0], from[1], s.ll[0], s.ll[1]) + gcNm(s.ll[0], s.ll[1], fieldLL[0], fieldLL[1]);
          const cur = stars.filter(s => s.gate === sat.gate).reduce((m, s) => Math.min(m, via(s)), Infinity);
          for (const s of stars) {
            if (!open.includes(s.gate) || !isFinite(cur)) continue;
            const extra = Math.round(via(s) - cur);
            if (extra > REROUTE_MAX_EXTRA_NM) continue;
            const score = extra - (used.has(s.gate) ? 15 : 0);      // keep the reroutes on as few gates as practical
            if (!move || score < move.score) move = { to: s.gate, kind: "star", star: s.star, fix: s.fix, extraNm: Math.max(0, extra), score };
          }
        }
      }
      if (!move) continue;
      room[move.to]--; used.add(move.to);
      delete move.score;
      moves.push({ callsign: f.callsign, dep: f.dep, status: f.status, eta: f.eta, ...move });
    }
    if (!moves.length) continue;
    const added = {};
    for (const m of moves) added[m.to] = (added[m.to] || 0) + 1;
    out.push({ gate: sat.gate, dir: compassOf(brg[sat.gate]), dirs: Object.fromEntries(Object.keys(added).map(g => [g, compassOf(brg[g])])), to: Object.keys(added), excess, demandBefore: sat.demand, demandAfter: sat.demand - moves.length,
      added: Object.entries(added).map(([g, n]) => ({ gate: g, before: demand(g), after: demand(g) + n })), moves });
  }
  return out;
}

/* ---------------- field config: closed gates ---------------- */

export const CLOSED_MAX_EXTRA_NM = 150;   // a closed gate has to move everyone, so a longer swap is still offered
const CLOSED_PAST_NM = 40;                 // airborne this close with no gate ETA is taken as past the gate already

/**
 * Arrivals filed over a gate the user closed on this page, each moved to an open gate:
 * a CDR for flights still on the ground, else the open gate's STAR via its nearest entry
 * fix (any corner: the closure, not saturation, is the reason). Spreads the moves by
 * scoring extra distance plus the target's load. Flights already past the gate are left.
 * Returns [{ gate, closed: true, dir, dirs, to, moves, stuck: [callsign], demandBefore, demandAfter, added }].
 */
export function closedGateReroutes({ sit, stars = [], cdrs = {}, closed = [] }) {
  const shut = new Set(closed);
  if (!shut.size || !sit.aptLL) return [];
  const fieldLL = sit.aptLL, now = sit.now;
  const brg = stars.length ? gateBearings(stars, fieldLL) : {};
  const open = [...new Set(stars.map(s => s.gate))].filter(g => !shut.has(g));
  const load = {};
  for (const f of sit.live) if (f.gate) load[f.gate] = (load[f.gate] || 0) + 1;
  const out = [];
  for (const gate of shut) {
    const flights = sit.live.filter(f => f.gate === gate &&
      !(f.gateEta != null ? f.gateEta <= now : f.status === "AIRBORNE" && f.dist != null && f.dist < CLOSED_PAST_NM))
      .sort((a, b) => a.eta - b.eta);
    if (!flights.length) continue;
    const moves = [], stuck = [];
    for (const f of flights) {
      let move = null;
      if (f.status !== "AIRBORNE") {
        for (const r of (cdrs[f.dep] || [])) {
          const star = lastStar(r[2]), g = gateKey(star);
          if (!star || !open.includes(g)) continue;
          const better = !move || (load[g] || 0) < (load[move.to] || 0) || ((load[g] || 0) === (load[move.to] || 0) && r[4] !== "Y" && move.coordReq);
          if (better) move = { to: g, kind: "cdr", code: r[0], route: r[2], coordReq: r[4] === "Y", star, extraNm: null };
        }
      }
      if (!move) {
        const from = f.status === "AIRBORNE" && f.lat != null ? [f.lat, f.lon] : sit.airportLL ? sit.airportLL(f.dep) : null;
        if (from) {
          const via = s => gcNm(from[0], from[1], s.ll[0], s.ll[1]) + gcNm(s.ll[0], s.ll[1], fieldLL[0], fieldLL[1]);
          const cur = stars.filter(s => s.gate === gate).reduce((m, s) => Math.min(m, via(s)), Infinity);
          const base = isFinite(cur) ? cur : gcNm(from[0], from[1], fieldLL[0], fieldLL[1]);
          for (const s of stars) {
            if (!open.includes(s.gate)) continue;
            const extra = Math.round(via(s) - base);
            if (extra > CLOSED_MAX_EXTRA_NM) continue;
            const score = Math.max(0, extra) + 2 * (load[s.gate] || 0);
            if (!move || score < move.score) move = { to: s.gate, kind: "star", star: s.star, fix: s.fix, extraNm: Math.max(0, extra), score };
          }
        }
      }
      if (!move) { stuck.push(f.callsign); continue; }
      delete move.score;
      load[move.to] = (load[move.to] || 0) + 1;
      moves.push({ callsign: f.callsign, dep: f.dep, status: f.status, eta: f.eta, ...move });
    }
    const added = {};
    for (const m of moves) added[m.to] = (added[m.to] || 0) + 1;
    out.push({ gate, closed: true, dir: brg[gate] != null ? compassOf(brg[gate]) : "",
      dirs: Object.fromEntries(Object.keys(added).map(g => [g, brg[g] != null ? compassOf(brg[g]) : ""])),
      to: Object.keys(added), moves, stuck, demandBefore: flights.length, demandAfter: stuck.length,
      added: Object.entries(added).map(([g, n]) => ({ gate: g, before: load[g] - n, after: load[g] })) });
  }
  return out;
}

/* ---------------- field config: runways ---------------- */

const RWY_RE = /^(0?[1-9]|[12]\d|3[0-6])([LRC])?$/;
const normRwy = r => { const m = String(r || "").toUpperCase().match(RWY_RE); return m ? String(+m[1]).padStart(2, "0") + (m[2] || "") : ""; };
export { normRwy };

/**
 * Arrival and departure runways from an ATIS text, checked against the field's known
 * runway ends (data/nav/runways.json) so altimeters, times and frequencies never count.
 * A runway goes to whichever of landing / departing was said last before it; with
 * neither ("RWYS 27L 28R IN USE") it counts for both. Sentences about closures are skipped.
 */
export function runwaysFromAtis(text, known = []) {
  const ok = new Set(known.map(normRwy).filter(Boolean));
  const arr = new Set(), dep = new Set();
  const t = String(text || "").toUpperCase().replace(/\s+/g, " ");
  const ARR = /^(APCH|APCHS|APPROACH|APPROACHES|APP|APPS|LNDG|LDG|LANDING|LAND|ARRIVAL|ARRIVALS|ARR|ARRS|ARRIVING|ARVNG|ARRVG)$/;
  const DEP = /^(DEPG|DEPTG|DEPARTING|DEPARTURE|DEPARTURES|DEP|DEPS|DEPART|TKOF|TAKEOFF|TAKEOFFS)$/;
  const APPR = /^(ILS|RNAV|RNP|VISUAL|VIS|LOC|GPS|LDA|VOR)$/;
  const NEUTRAL = /^(SIMUL|SIMULTANEOUS|CONVERGING|PARALLEL|DEPENDENT|INDEPENDENT|IN|USE|EXPECT|EXP)$/;
  const RWYW = /^(RWY|RWYS|RY|RYS|RUNWAY|RUNWAYS)$/;
  const JOIN = /^(,|AND|Y|Z|X|W|-)$/;
  for (const sentence of t.split(/\.(?=\s|$)|\.\.\.|;/)) {
    if (/\b(CLSD|CLOSED|OTS|UNUSABLE|U\/S)\b/.test(sentence)) continue;
    const toks = sentence.replace(/[,/&()]/g, " , ").split(" ").map(w => w.replace(/\.+$/, "")).filter(Boolean);
    let mode = "", list = false, prevKw = "";
    const pending = [];
    const put = r => { if (mode === "arr" || mode === "both") arr.add(r); if (mode === "dep" || mode === "both") dep.add(r); if (!mode) pending.push(r); };
    for (const w of toks) {
      const kw = ARR.test(w) || APPR.test(w) ? "arr" : DEP.test(w) ? "dep" : "";
      if (kw) {
        /* "LANDING AND DEPARTING RWY 27" is both */
        mode = prevKw && prevKw !== kw ? "both" : kw;
        prevKw = kw; list = true;               // "ARR 6, DEP 1"
        continue;
      }
      if (RWYW.test(w)) { list = true; continue; }
      if (JOIN.test(w)) continue;
      prevKw = "";
      const r = normRwy(w);
      /* "RWYS 24 AND 25" at a field with 24L/24R and 25L/25R means both sides */
      const hits = !r ? [] : ok.has(r) ? [r] : /^\d\d$/.test(r) ? [...ok].filter(x => x.slice(0, 2) === r) : [];
      if (list && hits.length) { hits.forEach(put); continue; }
      if (!NEUTRAL.test(w)) list = false;
    }
    /* "RWYS 27L 28R IN USE": no landing or departing word in the sentence */
    if (/\b(IN USE|IN PROG|IN EFFECT|ACTIVE)\b/.test(sentence)) for (const r of pending) { arr.add(r); dep.add(r); }
  }
  const sort = s => [...s].sort();
  return { arr: sort(arr), dep: sort(dep) };
}

/** Wind from a METAR: { dir (true, or null when variable), spd, gust } or null. */
export function windFromMetar(metar) {
  const m = String(metar || "").match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/);
  if (!m) return null;
  const k = m[4] === "MPS" ? 1.944 : 1;
  return { dir: m[1] === "VRB" ? null : +m[1], spd: Math.round(+m[2] * k), gust: m[3] ? Math.round(+m[3] * k) : 0 };
}

/** Headwind (negative = tailwind) and crosswind on each runway end, steady and gust. */
export function runwayWinds(rwys, ends = [], wind) {
  if (!wind || wind.dir == null) return [];
  return rwys.map(r => {
    const e = ends.find(x => normRwy(x[0]) === normRwy(r));
    if (!e) return null;
    const a = (wind.dir - e[3]) * Math.PI / 180;
    const g = Math.max(wind.gust || 0, wind.spd);
    return { rwy: normRwy(r), hdg: e[3], head: Math.round(wind.spd * Math.cos(a)), cross: Math.round(Math.abs(wind.spd * Math.sin(a))),
      crossGust: Math.round(Math.abs(g * Math.sin(a))), tailGust: Math.round(-g * Math.cos(a)) };
  }).filter(Boolean);
}

export const TAILWIND_KT = 5;            // more than this on an arrival runway is worth turning the field for
export const CROSSWIND_KT = 20;

/** The field's runway ends grouped into runways: [[endA, endB]] from runways.json rows. */
export function runwayPairs(ends = []) {
  const left = ends.slice(), out = [];
  while (left.length) {
    const a = left.shift();
    const num = +normRwy(a[0]).slice(0, 2), side = normRwy(a[0]).slice(2);
    const opp = { L: "R", R: "L", C: "C", "": "" }[side];
    const want = String(((num + 17) % 36) + 1).padStart(2, "0") + opp;
    const i = left.findIndex(b => normRwy(b[0]) === want);
    out.push(i >= 0 ? [a, left.splice(i, 1)[0]] : [a]);
  }
  return out;
}

/* ---------------- what needs fixing, per aircraft ---------------- */

/**
 * Every aircraft the advice names, with why: { callsign: [{ kind, sev, text, move? }] }.
 * kinds: closed (filed over a closed gate), reroute, slot, holding, tight, edct, nogate.
 */
export function flightIssues(s) {
  const out = {};
  const add = (cs, x) => (out[cs] = out[cs] || []).push(x);
  for (const r of s.closures || []) {
    for (const m of r.moves) add(m.callsign, { kind: "closed", sev: "action", move: m,
      text: `${r.gate} is closed: ` + (m.kind === "cdr" ? `CDR ${m.code} via ${m.star}` : `DCT ${m.fix} ${m.star}`) + ` to ${m.to}` + (m.extraNm ? ` (+${m.extraNm} nm)` : "") });
    for (const cs of r.stuck) add(cs, { kind: "closed", sev: "action", text: `${r.gate} is closed and no open gate is within ${CLOSED_MAX_EXTRA_NM} nm extra: reroute by hand` });
  }
  for (const r of s.reroutes || []) for (const m of r.moves)
    add(m.callsign, { kind: "reroute", sev: "action", move: m,
      text: `Off saturated ${r.gate}: ` + (m.kind === "cdr" ? `CDR ${m.code} via ${m.star}` : `DCT ${m.fix} ${m.star}`) + ` to ${m.to}` + (m.extraNm ? ` (+${m.extraNm} nm)` : "") });
  for (const b of s.slots || []) for (const m of b.moves)
    add(m.callsign, { kind: "slot", sev: b.start - s.now <= 60 * MIN ? "action" : "watch", move: m,
      text: `${m.shiftMin > 0 ? "+" : "−"}${Math.abs(m.shiftMin)} min into the ${fmtZ(m.to)} slot: ${slotMoveHow(m)}` });
  for (const h of (s.actual && s.actual.holding) || [])
    add(h.cs, { kind: "holding", sev: h.min >= 10 ? "action" : "watch", text: `Holding ${h.min} min, ${h.nm} nm ${h.dir}` });
  for (const g of s.gates) for (const x of (g.spacing || []).filter(x => x.tight))
    add(x.callsign, { kind: "tight", sev: "watch", text: `${Math.round(x.gap)} nm behind ${x.ahead} on ${g.name}, inside ${g.nowNm || g.recMit} MIT` });
  for (const r of s.edct.early) add(r.cs, { kind: "edct", sev: "watch", text: `Departed early for EDCT ${fmtZ(r.t)}` });
  for (const r of s.edct.late) add(r.cs, { kind: "edct", sev: "watch", text: `On the ground past EDCT ${fmtZ(r.t)}` });
  for (const f of s.live) if (f.gate === NO_GATE && !f.excluded && f.status === "AIRBORNE")
    add(f.callsign, { kind: "nogate", sev: "info", text: "Route ends without a STAR or fix VATFLOW knows: no gate MIT covers it" });
  return out;
}

/* ---------------- recommendations ---------------- */

const SEV_RANK = { action: 0, watch: 1, info: 2 };
const LINK = {
  tmu: { href: "vatflow-tbfm%20v2.html", label: "Airport TMU" },
  fca: { href: "FCA-builderv02.html", label: "FCA Builder" },
  idst: { href: "idst.html", label: "IDST" },
  dash: { href: "vatflow-tbfm%20v2.html", label: "Apt Dashboard" },
};

/** "Ask ZJX for Q83 (TAALN) 35 MIT and Q85 (IGARY) 40 MIT at ROYCO" for a merge point. */
export function mergeAsk(m) {
  const by = {};
  for (const b of m.branches) if (b.mit) (by[b.center || "the upstream center"] = by[b.center || "the upstream center"] || []).push(`${b.label} ${b.mit} MIT`);
  const asks = Object.entries(by).map(([c, l]) => `ask ${c} for ${l.join(" and ")}`);
  const when = m.peak.atFix ? `, passing ${fmtZ(m.peak.atFix[0])}–${fmtZ(m.peak.atFix[1])}` : "";
  if (!asks.length) {
    const owner = [...new Set(m.branches.map(b => b.center).filter(Boolean))];
    return `Ask ${owner.length === 1 ? owner[0] : "the center that owns the merge"} for ${m.mergedMit} MIT over ${m.fix} for all ${m.gate} traffic${when}, so the streams interleave instead of arriving together`;
  }
  const s = asks.join("; ") + ` at ${m.fix}` + when;
  return s[0].toUpperCase() + s.slice(1);
}

/** Origins of the still-on-the-ground arrivals landing in [startMs, endMs), busiest first. */
export function groundOrigins(live, startMs, endMs) {
  const by = {};
  for (const f of live) {
    if (f.status !== "GROUND" && f.status !== "PREFILE") continue;
    if (!(f.eta >= startMs && f.eta < endMs)) continue;
    by[f.dep || "?"] = (by[f.dep || "?"] || 0) + 1;
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Rebalancing: the MIT split holds every gate under its fair share and leaves the
 * whole excess queued on the busiest gate. Moving some of its arrivals to the
 * quietest gate spreads that queue. Finds the move (arrivals per hour) that most
 * cuts the longest gate queue (demand over its slice). Gate geometry isn't known
 * here, so it's a suggestion "where a reroute is practical". Null when the
 * longest queue wouldn't drop by at least 3 an hour.
 */
export function rebalanceSuggestion(win, capacity) {
  if (!win || !capacity || win.total <= capacity || win.entries.length < 2) return null;
  const worst = entries => {
    const rows = calcGateMit(capacity, entries, win.unassigned, MIT_NOMINAL_KT).rows;
    return rows.reduce((a, r) => (r.demand - r.slice > a.q ? { q: r.demand - r.slice, r } : a), { q: 0, r: null });
  };
  const before = worst(win.entries);
  if (!before.r) return null;
  const from = before.r.gate, fromN = before.r.demand;
  const [to, toN] = win.entries.filter(([g]) => g !== from).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
  let best = null;
  for (let k = 1; k <= Math.floor((fromN - toN) / 2); k++) {
    const moved = win.entries.map(([g, n]) => [g, g === from ? n - k : g === to ? n + k : n]);
    const w = worst(moved);
    if (!best || w.q < best.q - 1e-9) best = { k, q: w.q };
  }
  if (!best || before.q - best.q < 3) return null;
  return { from, to, move: best.k, queueBefore: Math.round(before.q), queueAfter: Math.round(best.q) };
}

/** Reroute moves grouped by what to issue: "CDR ATLMCOGA via SNFLD3 for DAL1, DAL2 (KATL)". */
/* ---------------- 15-minute landing slots ---------------- */

export const SLOT_MIN = 15;
export const SLOT_COUNT = 13;           // the current quarter hour plus the next three hours

/** Arrivals in clock-aligned 15-minute slots by landing time; anyone overdue counts in the first slot. */
export function landingSlots(flights, now, n = SLOT_COUNT) {
  const SLOT = SLOT_MIN * MIN, t0 = Math.floor(now / SLOT) * SLOT;
  const slots = Array.from({ length: n }, (_, i) => ({ start: t0 + i * SLOT, end: t0 + (i + 1) * SLOT, gates: {}, total: 0, prefiled: 0, flights: [] }));
  for (const f of flights) {
    if (f.eta == null) continue;
    const i = Math.max(0, Math.floor((f.eta - t0) / SLOT));
    if (i >= n) continue;
    const sl = slots[i], g = f.gate || "—";
    sl.gates[g] = (sl.gates[g] || 0) + 1; sl.total++; if (f.prefiled) sl.prefiled++; sl.flights.push(f);
  }
  return slots;
}

export const SLOT_PULL_MAX_MIN = 3;     // most an airborne arrival can be pulled earlier (speed, a direct)
export const SLOT_PULL_MIN_NM = 100;    // and only with room to do it
export const SLOT_MOVES_MAX = 12;

/**
 * STAR balancing across 15-minute slots: for each slot over the AAR's quarter-hour share,
 * move airborne arrivals (ground flights are left to the FCA) off its busiest STAR into the slot 15 minutes after (a short delay) or before
 * (a small pull, airborne only) when that slot has room.
 * Returns [{ start, end, count, allow, moves: [{ callsign, dep, gate, gateFix, status, dist, eta, to, shiftMin }], left }].
 */
export function slotBalance(flights, now, capacity) {
  if (!(capacity > 0)) return [];
  const slots = landingSlots(flights, now);
  const allow = Math.floor(capacity * SLOT_MIN / 60 + 1e-9);
  const count = slots.map(sl => sl.total);
  const out = [];
  let used = 0;
  slots.forEach((sl, i) => {
    if (count[i] <= allow || used >= SLOT_MOVES_MAX) return;
    const rec = { start: sl.start, end: sl.end, count: count[i], allow, moves: [] };
    const load = {};
    for (const f of sl.flights) load[f.gate] = (load[f.gate] || 0) + 1;
    const pool = sl.flights.filter(f => f.status === "AIRBORNE");   // ground and prefiled flights are the FCA's to meter
    while (count[i] > allow && used < SLOT_MOVES_MAX) {
      const options = [];
      for (const f of pool) {
        if (i + 1 < slots.length && count[i + 1] < allow)
          options.push({ f, to: i + 1, shiftMin: Math.max(1, Math.ceil((sl.end - f.eta) / MIN)) });
        if (i > 0 && count[i - 1] < allow && (f.dist || 0) >= SLOT_PULL_MIN_NM) {
          const pull = Math.ceil((f.eta - sl.start) / MIN) + 1;
          if (pull <= SLOT_PULL_MAX_MIN && f.eta - pull * MIN > now) options.push({ f, to: i - 1, shiftMin: -pull });
        }
      }
      if (!options.length) break;
      /* off the busiest STAR first, then the smallest shift, a delay before a pull */
      options.sort((a, b) => (load[b.f.gate] || 0) - (load[a.f.gate] || 0) || Math.abs(a.shiftMin) - Math.abs(b.shiftMin) || b.shiftMin - a.shiftMin);
      const o = options[0];
      pool.splice(pool.indexOf(o.f), 1);
      load[o.f.gate]--; count[i]--; count[o.to]++; used++;
      const f = o.f;
      const shiftNm = f.status === "AIRBORNE" ? Math.round(Math.abs(o.shiftMin) * Math.max(f.gs || 0, 200) / 60) : null;
      rec.moves.push({ callsign: f.callsign, dep: f.dep, gate: f.gate, gateFix: f.gateFix || null, gateEta: f.gateEta || null,
        status: f.status, dist: f.dist, eta: f.eta, to: slots[o.to].start, shiftMin: o.shiftMin, shiftNm });
    }
    rec.left = count[i] - allow;
    if (rec.moves.length) out.push(rec);
  });
  return out;
}

/* shiftNm: track miles to add (delay) or save (pull) at the aircraft's groundspeed; null on the ground */
/** How to get one arrival into its new slot. */
export function slotMoveHow(m) {
  const n = Math.abs(m.shiftMin);
  if (m.shiftMin < 0) return `keep the speed up or give a direct, about ${n} min earlier${m.shiftNm ? ` (about ${m.shiftNm} nm shorter)` : ""}`;
  const nm = m.shiftNm ? ` (about ${m.shiftNm} nm)` : "";
  if ((m.dist || 0) > 150) return `speed control, ${n} min later${nm}`;
  return n <= 6 ? `vector or extend downwind, ${n} min later${nm}` : `hold ${n} min`;
}

export function rerouteGroups(moves) {
  const groups = new Map();
  for (const m of moves) {
    const k = m.kind === "cdr" ? `CDR ${m.code}${m.coordReq ? " (coord req)" : ""} via ${m.star}` : `${m.star} via ${m.fix}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return [...groups].map(([k, ms]) => {
    const deps = [...new Set(ms.map(m => m.dep).filter(Boolean))];
    const extra = Math.max(...ms.map(m => m.extraNm || 0));
    return `${k} for ${ms.map(m => m.callsign).join(", ")}` +
      (ms[0].kind === "cdr" ? ` (${deps.join("/")})` : ` (${ms.every(m => m.status === "AIRBORNE") ? "airborne" : "amend route"}${extra ? `, up to +${extra} nm` : ""})`);
  });
}

/** Ranked advice: { id, sev: action|watch|info, title, why, at?, link? }. */
export function recommend(s) {
  const out = [];
  const add = r => out.push(r);
  const cap = s.cap.capacity;
  const apt = s.airport;

  if (!cap) {
    add({ id: "no-aar", sev: "action", title: `Set an AAR for ${apt}`,
      why: `There is no Airport TMU program for ${apt}, so there is nothing to plan against. Type an AAR above to plan here, or set a program on Airport TMU so every page and controller sees it.`, link: LINK.tmu });
    return out;
  }

  /* weather cuts capacity */
  if (s.cap.factor < 1 && s.cap.aar > cap) {
    /* the AAR is taken as the clear-weather rate and cut here, so this is a note, not "lower the AAR"
       (typing the cut rate back in would cut it twice) */
    add({ id: "wx-aar", sev: "info", title: `Planning at ${cap}/hr for weather`,
      why: `The forecast over the next 3 hours cuts ${apt}'s rate (${s.cap.reasons.join(", ")}), so VATSMART plans against ${cap}/hr instead of the ${s.cap.aar}/hr ${s.cap.source === "program" ? "program" : "AAR"}. Keep the AAR at the clear-weather rate; the weather cut is applied on top of it.` });
  }

  /* the overall TMI call */
  const pw = s.peakWin;
  const over = pw.total - cap;
  const firstOver = s.roll.windows.find(w => w.total > cap);
  if (s.tier && s.tier.id !== "none") {
    const delay = s.queue.maxDelay ? ` The queue would reach about ${s.queue.maxDelay} min around ${fmtZ(s.queue.maxAt)} if nothing is done.` : "";
    const ground = groundOrigins(s.live, pw.start, pw.end);
    const groundN = ground.reduce((n, [, c]) => n + c, 0);
    let what = "";
    if (s.tier.id === "mit") what = " Miles-in-trail on the loaded gates absorbs it in the air (gate plan below).";
    else {
      const top = ground.slice(0, 4).map(([a, n]) => `${a} ${n}`).join(", ");
      what = groundN
        ? ` ${plural(groundN, "arrival")} for that hour ${groundN === 1 ? "is" : "are"} still on the ground or prefiled${top ? ` (${top})` : ""}: ` +
          (groundN >= over ? `holding about ${Math.min(over, groundN)} of them with RDY / EDCT times covers the excess.` : `ground delays cover ${groundN} of the ${over} extra, the rest has to hold in the air.`)
        : " Everyone in that hour is already airborne, so the excess has to be absorbed with MIT and holding.";
    }
    add({ id: "tier", sev: "action", title: s.tier.id === "mit" ? "Run MIT on the loaded gates" : s.tier.label,
      why: `Demand peaks at ${pw.total}/hr (${fmtZ(pw.start)}–${fmtZ(pw.end)}) against ${cap}/hr` +
        (firstOver ? `, over capacity from ${fmtZ(firstOver.start)}.` : ".") + delay + what,
      at: firstOver ? firstOver.start : null, link: s.tier.id === "mit" ? LINK.tmu : LINK.fca });
    if (!s.prog) add({ id: "no-prog", sev: "action", title: `Publish a program for ${apt}`,
      why: `Demand is over capacity but ${apt} has no Airport TMU program, so MIT Monitor, dashboards and the other controllers can't see the rate. Set AAR ${s.cap.aar} on Airport TMU.`, link: LINK.tmu });
  }

  /* gates closed on this page: everyone filed over them needs another gate */
  const shut = new Set(s.closedGates || []);
  for (const r of s.closures || []) {
    const n = r.moves.length + r.stuck.length;
    add({ id: "closed-" + r.gate, sev: "action", title: `${plural(n, "arrival")} filed over closed ${r.gate}`,
      why: (r.moves.length ? `Reroute ${r.moves.length === n ? "them" : r.moves.length} to an open gate: ` + rerouteGroups(r.moves).join("; ") + "." : "") +
        (r.stuck.length ? ` No CDR or STAR within ${CLOSED_MAX_EXTRA_NM} nm extra reaches an open gate for ${r.stuck.slice(0, 6).join(", ")}${r.stuck.length > 6 ? " …" : ""}: reroute by hand.` : "") +
        (r.added.length ? ` ${r.added.map(a => `${a.gate} goes from ${a.before} to ${a.after}`).join(", ")} inbound.` : "") +
        " The closure is set on this page only; tell the adjacent centers and pass the reroutes upstream.",
      at: (r.moves[0] || {}).eta || null, link: LINK.tmu });
  }

  /* runway config against the wind */
  const rw = s.rwyWinds || [];
  const tail = rw.filter(x => -x.head > TAILWIND_KT).sort((a, b) => a.head - b.head);
  const cfg = s.config && s.config.runways;
  if (tail.length) {
    const flip = (cfg.arr || []).map(r => {
      const n = (+r.slice(0, 2) + 17) % 36 + 1, side = { L: "R", R: "L", C: "C" }[r.slice(2)] || "";
      return String(n).padStart(2, "0") + side;
    }).filter(r => (s.config.ends || []).some(e => normRwy(e[0]) === r));
    const w = s.config.wind;
    add({ id: "rwy-tail", sev: -tail[0].head >= 10 ? "action" : "watch", title: `Tailwind ${-tail[0].head} kt landing ${tail.map(x => x.rwy).join(", ")}`,
      why: `Wind ${String(w.dir).padStart(3, "0")}° at ${w.spd}${w.gust ? "G" + w.gust : ""} kt puts ${tail.map(x => `${-x.head} kt of tailwind on ${x.rwy}`).join(", ")}. ` +
        (flip.length ? `Turning the field to ${flip.join(", ")} lands into the wind; plan the change for a gap in the arrivals, since a config change costs landings while the final is rebuilt.` : "Consider a runway change into the wind.") });
  }
  const xw = rw.filter(x => x.crossGust >= CROSSWIND_KT && !tail.includes(x));
  if (xw.length) add({ id: "rwy-xwind", sev: "watch", title: `Crosswind ${xw[0].crossGust} kt on ${xw.map(x => x.rwy).join(", ")}`,
    why: `Expect more go-arounds and wider spacing on final; the achieved rate may drop below the AAR.` });

  /* gate MIT plan: the next change on each gate */
  for (const g of s.gates) {
    const next = g.schedule[0];
    if (!next || shut.has(g.name)) continue;
    const soon = next.at - s.now <= NEAR_START_MIN * MIN;
    const when = next.i === 0 ? "now" : `at ${fmtZ(next.at)}`;
    const verb = { start: `Start ${next.to} MIT on ${g.name}`, tighten: `Tighten ${g.name} to ${next.to} MIT`,
      relax: `Relax ${g.name} to ${next.to} MIT`, stop: `Stop MIT on ${g.name}` }[next.kind];
    const later = g.schedule.slice(1, 3).map(x => `${x.kind} ${x.to ? x.to + " MIT " : ""}at ${fmtZ(x.at)}`).join(", ");
    add({ id: "gate-" + g.name, sev: soon && next.kind !== "relax" && next.kind !== "stop" ? "action" : soon ? "watch" : "info",
      title: `${verb} ${when}`,
      why: (next.kind === "stop" || next.kind === "relax"
        ? `${g.name} is held to ${next.from} MIT but its demand no longer needs it` + (next.to ? ` (${next.to} MIT is enough).` : ".")
        : `${g.name} carries ${g.peakDemand}/hr at the peak; ${next.to} MIT keeps ${apt} at ${cap}/hr.`) +
        (later ? ` Then ${later}.` : "") + (next.i > 0 ? " Pass it to the adjacent facility ahead of time." : ""),
      at: next.at, link: LINK.tmu });
  }

  /* reroutes off saturated gates (CDRs / STAR swaps), else the general rebalance idea */
  for (const r of s.reroutes || []) {
    const cdr = r.moves.filter(m => m.kind === "cdr").length;
    add({ id: "reroute-" + r.gate, sev: "action", title: `Reroute ${plural(r.moves.length, "arrival")} off ${r.gate} to ${r.to.join(" / ")}`,
      why: `${r.gate} (${r.dir}) is saturated at the peak. Move arrivals to the ${[...new Set(Object.values(r.dirs))].join(" / ")} side of the field: ` + rerouteGroups(r.moves).join("; ") +
        `. At the peak ${r.gate} drops from ${r.demandBefore} to ${r.demandAfter} an hour, ` + r.added.map(a => `${a.gate} goes from ${a.before} to ${a.after}`).join(", ") +
        ", so the queue is shared across feeds instead of stacking up in one" + (cdr ? ". CDRs are published routes the departure center can issue as is." : "."),
      at: r.moves[0].eta });
  }
  /* STAR balancing across 15-minute slots */
  for (const b of (s.slots || []).slice(0, 3)) {
    const by = {};
    for (const m of b.moves) (by[m.to] = by[m.to] || []).push(m);
    const where = Object.keys(by).map(t => fmtZ(+t)).join(" and ");
    const lines = b.moves.map(m => `${m.callsign} (${m.gate}${m.dep ? ", from " + m.dep : ""}, lands ${fmtZ(m.eta)}): ${slotMoveHow(m)}`);
    add({ id: "slot-" + b.start, sev: b.start - s.now <= 60 * MIN ? "action" : "watch",
      title: `Move ${plural(b.moves.length, "arrival")} from the ${fmtZ(b.start)} slot into ${where}`,
      why: `${fmtZ(b.start)}–${fmtZ(b.end)} has ${b.count} landings against ${+(cap / 4).toFixed(1)} per 15 min (${cap}/hr), mostly off ${b.moves[0].gate}. ` +
        `The slot${Object.keys(by).length > 1 ? "s" : ""} at ${where} ${Object.keys(by).length > 1 ? "have" : "has"} room. ${lines.join("; ")}.` +
        (b.left > 0 ? ` That still leaves ${plural(b.left, "arrival")} over; ground flights are left to the FCA, and the MIT or ground delay above covers the rest.` : ""),
      at: b.start });
  }

  const rb = !(s.reroutes || []).length && rebalanceSuggestion(pw, cap);
  if (rb) add({ id: "rebalance", sev: "info", title: `Shift ~${rb.move}/hr from ${rb.from} to ${rb.to}`,
    why: `At the peak the whole excess queues on ${rb.from} (${rb.queueBefore} more an hour than its share of the rate). Rerouting about ${rb.move} an hour to ${rb.to}, where a reroute is practical, spreads the delay so no gate queues more than ${rb.queueAfter} an hour.` });

  /* streams merging upstream of a gate faster than the gate's share */
  for (const m of (s.merges || []).filter(x => x.status !== "ok").slice(0, 4)) {
    const at = m.peak.atFix ? m.peak.atFix[0] : m.peak.start;
    add({ id: "merge-" + m.gate + "-" + m.fix, sev: at - s.now <= 60 * MIN || m.status === "over" ? "action" : "watch",
      title: m.status === "over"
        ? `${m.gate}: ${m.peak.n}/hr merging at ${m.fix}, ${Math.round(m.over)} over its share`
        : `${m.gate}: ${m.burst} arrivals bunch at ${m.fix} inside 15 minutes`,
      why: `${m.branches.map(b => `${b.label} ${b.n}/hr` + (b.from.length ? ` (from ${b.from.slice(0, 2).map(([c, n]) => c + " " + n).join(", ")})` : "")).join(" + ")} join at ${m.fix}, ${m.nmToField} nm out, ` +
        `landing ${fmtZ(m.peak.start)}–${fmtZ(m.peak.end)} against a ${m.share}/hr share for ${m.gate}. ` + mergeAsk(m) + ".",
      at, link: LINK.tmu });
  }

  /* what the runways are actually doing, and who is holding */
  const act = s.actual;
  if (act && act.rate && act.rate.perHr != null && act.rate.covered >= 45) {
    const r = act.rate, wanted = s.next60.total;
    if (r.perHr < cap * 0.85 && wanted >= cap * 0.9)
      add({ id: "achieved", sev: r.perHr < cap * 0.75 ? "action" : "watch", title: `Landing ${r.perHr}/hr against ${cap}/hr`,
        why: `${apt} landed ${r.last60} in the last ${r.covered === 60 ? "hour" : r.covered + " minutes"} while ${wanted} want to land in the next hour, so the rate isn't being achieved. ` +
          `Plan against what the runways are doing (type ${r.perHr} in the AAR box to see the MIT and ground delays it needs), or find out what is holding them up: runway configuration, spacing on final, go-arounds.`, link: LINK.tmu });
  }
  const holdBy = {};
  for (const h of (act && act.holding) || []) (holdBy[h.gate] = holdBy[h.gate] || []).push(h);
  for (const [gate, hs] of Object.entries(holdBy)) {
    const g = s.gates.find(x => x.name === gate);
    const longest = hs[0];
    const target = g ? Math.max(g.mits[0] || 0, (g.nowNm || 0) + 10, 20) : 0;
    const fix = gate === NO_GATE ? "with no gate" : `on ${gate}`;
    add({ id: "holding-" + gate, sev: hs.length >= 2 || longest.min >= 10 ? "action" : "watch",
      title: `${plural(hs.length, "aircraft", "aircraft")} holding ${fix}, longest ${longest.min} min`,
      why: hs.slice(0, 5).map(h => `${h.cs} ${h.min} min, ${h.nm} nm ${h.dir}`).join("; ") + ". " +
        (gate === NO_GATE ? "Check their routes; no gate MIT covers them."
          : g && g.nowNm ? `${gate} is held to ${g.nowNm} MIT and still delivers more than the runways take: tighten it to ${target} MIT so the hold drains, and pass it upstream now.`
          : `${gate} has no MIT: start ${target} MIT so the next arrivals take the delay in trail instead of in the hold.`),
      link: LINK.tmu });
  }

  /* in-trail spacing right now */
  for (const g of s.gates) {
    if (!g.tight) continue;
    const pairs = g.spacing.filter(x => x.tight).slice(0, 3).map(x => `${x.callsign} ${Math.round(x.gap)} nm behind ${x.ahead}`).join("; ");
    const nm = g.nowNm || g.recMit;
    add({ id: "spacing-" + g.name, sev: "watch", title: `${plural(g.tight, "pair")} inside ${nm} MIT on ${g.name}`,
      why: `${pairs}. Vector, speed or hand off with the spacing fixed before the gate.` });
  }

  /* ground stops and EDCTs */
  for (const g of s.gs) {
    if (g.expired) add({ id: "gs-exp-" + g.id, sev: "action", title: `Ground stop ended ${g.until}${/z$/i.test(g.until) ? "" : "z"}: cancel or extend it`,
      why: `The ${apt} ground stop${g.scope ? " for " + g.scope : ""} is still posted past its end time.`, link: LINK.tmu });
    else if (s.tier && (s.tier.id === "none" || (s.tier.id === "mit" && s.queue.maxDelay < 10)))
      add({ id: "gs-lift-" + g.id, sev: "watch", title: "Consider lifting the ground stop",
        why: `Demand peaks at ${pw.total}/hr against ${cap}/hr, so the ${apt} ground stop${g.scope ? " (" + g.scope + ")" : ""} may be holding more than it needs to.`, link: LINK.tmu });
  }
  if (s.edct.early.length) add({ id: "edct-early", sev: "watch", title: `${plural(s.edct.early.length, "EDCT flight")} departed early`,
    why: s.edct.early.slice(0, 5).map(r => `${r.cs} (EDCT ${fmtZ(r.t)})`).join(", ") + ". They'll arrive ahead of their slot; absorb it with speed or vectors." });
  if (s.edct.late.length) add({ id: "edct-late", sev: "watch", title: `${plural(s.edct.late.length, "flight")} still on the ground past EDCT`,
    why: s.edct.late.slice(0, 5).map(r => `${r.cs} (EDCT ${fmtZ(r.t)})`).join(", ") + ". Re-issue a time or release the slot to the next departure.", link: LINK.idst });

  /* weather watch */
  if (s.wx && s.wx.thunderPct >= THUNDER_POSSIBLE) add({ id: "wx-ts", sev: s.wx.thunderPct >= THUNDER_LIKELY ? "action" : "watch",
    title: `Thunderstorms ${s.wx.thunderPct}% at ${apt} in the next 3 hours`,
    why: "Plan for a lower rate and possible gate closures; brief the reroutes before cells reach the arrival corridors." });
  /* departure taxi-out */
  const tx = s.taxi;
  if (tx && (tx.avgMin >= TAXI_SLOW_MIN || (tx.longestMin || 0) >= TAXI_LONG_MIN)) {
    const slow = tx.avgMin >= TAXI_SLOW_MIN;
    add({ id: "taxi", sev: tx.avgMin >= TAXI_SLOW_MIN + 10 ? "action" : "watch",
      title: slow ? `Taxi-out averaging ${tx.avgMin} min at ${apt}` : `${tx.longestCs} taxiing ${tx.longestMin} min at ${apt}`,
      why: `${plural(tx.groundQueue, "departure")} on the ground, ${tx.taxiing.length} taxiing now` +
        (tx.longestMin ? `, longest ${tx.longestCs} at ${tx.longestMin} min` : "") +
        (tx.trend === "increasing" ? "; taxi times are going up" : "") +
        ". Hold departures at the gate (ramp metering) or space them with departure MIT so the queue waits with engines off.",
      link: { href: "ramp.html", label: "Ramp" } });
  }

  /* the next event, from a past one like it */
  if (s.upcoming && s.upcoming.startMs > s.now) {
    const ref = s.reference;
    const exp = ref ? ref.peak.value : null;
    add({ id: "event", sev: exp && exp > cap ? "watch" : "info", title: `${s.upcoming.name} starts ${fmtZ(s.upcoming.startMs)}`,
      why: ref
        ? `${ref.ev.name} (${new Date(ref.ev.startMs).toISOString().slice(0, 10)}, ${ref.reasons.join(", ")}) peaked at ${ref.ev.peakArr} landings an hour, so plan for about ${exp}/hr against ${cap}/hr.` +
          (exp > cap ? " Run the Event planner on Airport TMU to set expected demand per gate before the push." : "")
        : "There's no past event at this field to compare with. Run the Event planner on Airport TMU for a forecast.",
      at: s.upcoming.startMs, link: LINK.tmu });
  }

  /* data quality */
  if (pw.total >= 8 && pw.prefiled / pw.total >= 0.25) add({ id: "prefiles", sev: "info", title: `${pw.prefiled} of the peak's ${pw.total} are prefiles`,
    why: "Prefiled flights haven't connected yet; some won't show, others will file late. Treat the peak as a range." });
  if (pw.total >= 8 && pw.unassigned / pw.total >= 0.2) add({ id: "no-gate", sev: "info", title: `${pw.unassigned} peak arrivals have no gate`,
    why: "Their routes end without a STAR or fix VATFLOW recognizes, so no gate MIT covers them. Check their routes or add the fix as a gate rule." });
  if (s.tier && s.tier.id === "none" && !out.some(r => r.sev === "action")) add({ id: "ok", sev: "info", title: "No TMI needed",
    why: `Demand stays at or under ${cap}/hr through ${fmtZ(s.now + HORIZON_MIN * MIN)}${s.next60 ? ` (next hour ${s.next60.total})` : ""}. Keep watching.` });

  return out.map((r, i) => ({ ...r, _i: i }))
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || (a.at || s.now) - (b.at || s.now) || a._i - b._i)
    .map(({ _i, ...r }) => r);
}

export { NO_GATE };
