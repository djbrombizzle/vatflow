/**
 * Event planner — forecast arrival demand for a scheduled event and turn it into
 * TMI recommendations (gate MIT, FCA ground delays, ground delay program).
 *
 * Pure functions; the Airport TMU page feeds them data it already loads:
 *  - historical traffic (precomputed StatSim aggregate, staffing_hist "thisyear"):
 *      byAirport[icao].days[dow][hour].arr, plus .peaks / .origins / .peakOrigins
 *      when the weekly job has computed them
 *  - FAA STARs with transition coordinates (data/nav/procedures.json)
 *  - NWS gridpoint forecasts (api.weather.gov) at the field and on a ring around it
 *  - VATSIM events API (competing events)
 *
 * Every number the model invents is a labeled assumption the controller can see
 * and override (the peak, each modifier, the AAR).
 */
import { calcGateMit, gateKey, MIT_NOMINAL_KT } from "./mit-monitor.js";

const HOUR = 3600000;
const toRad = d => d * Math.PI / 180;

export function gcNm(a, b, c, d) {
  const dLat = toRad(c - a), dLon = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearingDeg(a, b, c, d) {
  const y = Math.sin(toRad(d - b)) * Math.cos(toRad(c));
  const x = Math.cos(toRad(a)) * Math.sin(toRad(c)) - Math.sin(toRad(a)) * Math.cos(toRad(c)) * Math.cos(toRad(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b) + 540) % 360 - 180);

/* ---------------- event types and the peak ---------------- */

/** Peak arrival demand per hour when there's no history for the field (estimates). */
export const EVENT_TYPES = {
  fno:       { label: "FNO / big event, this field only", defaultPeak: 70, histFactor: 1.0 },
  fnoMulti:  { label: "FNO, one of 2-3 featured fields", defaultPeak: 45, histFactor: 0.75 },
  event:     { label: "Regular or weekday event", defaultPeak: 30, histFactor: 0.55 },
  none:      { label: "No event (normal traffic)", defaultPeak: 0, histFactor: 0 },
};

/**
 * Expected peak arrivals/hr for the event part of the demand.
 * peaks: [{ t, arr }] busiest single clock hours at this field (history), or none.
 * Landed counts cap at what ATC achieved, so history is lifted 15% toward demand.
 */
export function expectedPeak(type, peaks) {
  const et = EVENT_TYPES[type] || EVENT_TYPES.fno;
  if (type === "none") return { value: 0, source: "No event: historical traffic only." };
  const top = (peaks || []).map(p => +p.arr).filter(n => n > 0).sort((a, b) => b - a).slice(0, 3);
  if (top.length >= 2) {
    const med = top[Math.floor(top.length / 2)];
    const value = Math.round(med * 1.15 * et.histFactor);
    return {
      value, fromHistory: true,
      source: "From this field’s busiest past hours (" + top.join(", ") + " landed/hr; middle " + med +
        ", +15% because landings cap at what ATC achieved" + (et.histFactor !== 1 ? ", ×" + et.histFactor + " for this event type" : "") + ").",
    };
  }
  return { value: et.defaultPeak, source: "Default estimate for this event type; no event history for this field yet." };
}

/* ---------------- past events (StatSim, data/event-history.json) ---------------- */

/** A past event is usable as a basis when it has real arrivals and few featured fields. */
export const usableEvent = ev => ev && ev.peakArr >= 5 && (ev.fields || []).length <= 5;

/** Event length within half to double the planned one (an 11-hour marathon isn't a 4-hour FNO). */
const similarLength = (ev, durMs) => !durMs || ((ev.endMs - ev.startMs) <= durMs * 2 && (ev.endMs - ev.startMs) >= durMs / 2);

/**
 * The past event to base the forecast on: the one the controller picked, else the
 * field's most recent usable event (busy enough, 5 or fewer featured fields) of a
 * similar length, else its most recent usable event of any length.
 */
export function pickBasisEvent(events, pickedId, durationMs) {
  const list = (events || []).slice().sort((a, b) => b.startMs - a.startMs);
  if (pickedId) {
    const ev = list.find(e => String(e.id) === String(pickedId));
    if (ev) return ev;
  }
  return list.find(e => usableEvent(e) && similarLength(e, durationMs)) || list.find(usableEvent) || null;
}
/* words that say nothing about which event series a name belongs to */
const NAME_STOP = new Set(("the a an and of at in on to for with from vs x fno sno mno wno tno fly flyin fly-in night event " +
  "events edition annual live part ii iii iv vatsim vatusa artcc center centre tracon approach").split(" "));
const nameWords = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
  .filter(w => w.length > 1 && !NAME_STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));

/**
 * How much a past event looks like the one being planned, for a controller picking
 * the reference: { score, reasons }. Counts a shared name (same series, e.g. last
 * year's Boston Tea Party), a similar length, the same weekday and start hour, the
 * same season, and a similar set of featured fields.
 * plan: { name, startMs, endMs, fields }.
 */
export function eventLikeness(ev, plan) {
  const reasons = [];
  let score = 0;
  if (!ev || !plan) return { score, reasons };
  const a = new Set(nameWords(plan.name)), b = nameWords(ev.name);
  const shared = [...new Set(b.filter(w => a.has(w)))];
  if (a.size && shared.length && shared.length >= Math.min(2, a.size)) { score += 3; reasons.push("same name"); }
  const dur = plan.endMs - plan.startMs, evDur = ev.endMs - ev.startMs;
  if (dur > 0 && Math.abs(evDur - dur) <= HOUR) { score += 1; reasons.push("same length"); }
  if (plan.startMs) {
    const p = new Date(plan.startMs), e = new Date(ev.startMs);
    if (p.getUTCDay() === e.getUTCDay() && Math.abs(p.getUTCHours() - e.getUTCHours()) <= 1) { score += 1; reasons.push("same day and time"); }
    const months = Math.abs(p.getUTCMonth() - e.getUTCMonth());
    if (Math.min(months, 12 - months) <= 1) { score += 1; reasons.push("same time of year"); }
  }
  const n = (plan.fields || []).length;
  if (n && Math.abs((ev.fields || []).length - n) <= 1) { score += 1; reasons.push(n === 1 ? "single field" : "similar field count"); }
  return { score, reasons };
}
/** The past events that best resemble the plan (a shared name, or 3+ points), best first. */
export function likelyEvents(events, plan, max = 3) {
  return (events || []).filter(usableEvent)
    .map(ev => ({ ev, ...eventLikeness(ev, plan) }))
    .filter(x => x.reasons.includes("same name") || x.score >= 3)
    .sort((x, y) => y.score - x.score || y.ev.startMs - x.ev.startMs)
    .slice(0, max);
}
/** Peak from a past event: its busiest hour of landings, +15% (landings cap at what ATC achieved). */
export function peakFromEvent(ev) {
  const value = Math.round(ev.peakArr * 1.15);
  return {
    value, fromEvent: true,
    source: "From " + ev.name + " (" + new Date(ev.startMs).toISOString().slice(0, 10) + "): busiest hour " + ev.peakArr +
      " landings, +15% because landings cap at what ATC achieved.",
  };
}

/* ---------------- calendar modifiers ---------------- */

function nthWeekday(y, m, dow, n) {           // n >= 1, or -1 for last
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m, lastDay)).getUTCDay();
  return lastDay - ((last - dow + 7) % 7);
}
/** US holiday period name for a date, or "" (weekends and weeks pilots fly more). */
export function holidayPeriod(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const near = (mm, dd, before, after) => m === mm && day >= dd - before && day <= dd + after;
  if ((m === 11 && day >= 20) || (m === 0 && day <= 3)) return "Winter holidays";
  if (near(10, nthWeekday(y, 10, 4, 4), 3, 3)) return "Thanksgiving";
  if (near(6, 4, 2, 2)) return "Fourth of July";
  if (near(4, nthWeekday(y, 4, 1, -1), 3, 0)) return "Memorial Day weekend";
  if (near(8, nthWeekday(y, 8, 1, 1), 3, 0)) return "Labor Day weekend";
  return "";
}
/** Season effect: VATSIM is busier in the northern winter and quieter in summer. */
export function seasonPct(ms) {
  const m = new Date(ms).getUTCMonth();
  if (m === 10 || m === 11 || m === 0 || m === 1) return 10;
  if (m >= 5 && m <= 7) return -5;
  return 0;
}

export const INCENTIVES = [
  { id: "realops", label: "Real-world schedule / airline ops event", pct: 10 },
  { id: "scenery", label: "Popular or newly released scenery for the field", pct: 10 },
  { id: "tour", label: "Award, tour leg or badge for flying in", pct: 10 },
  { id: "featured", label: "Promoted by VATSIM / big streamers", pct: 10 },
];

/* ---------------- weather (NWS gridpoint forecast) ---------------- */

export function flightCategory(ceilFt, visSm) {
  if (ceilFt < 500 || visSm < 1) return "LIFR";
  if (ceilFt < 1000 || visSm < 3) return "IFR";
  if (ceilFt <= 3000 || visSm <= 5) return "MVFR";
  return "VFR";
}

/** "2026-10-07T17:00:00+00:00/PT7H" or ".../P1DT6H" → [startMs, endMs]. */
export function parseValidTime(v) {
  const [iso, dur] = String(v || "").split("/");
  const t = Date.parse(iso);
  const m = String(dur || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!isFinite(t) || !m) return null;
  const ms = ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600000 + (+m[3] || 0) * 60000;
  return [t, t + ms];
}
function overlapping(layer, startMs, endMs) {
  const out = [];
  for (const x of (layer && layer.values) || []) {
    const r = parseValidTime(x.validTime);
    if (r && r[1] > startMs && r[0] < endMs && x.value != null) out.push(x.value);
  }
  return out;
}

/**
 * Worst forecast conditions during [startMs, endMs] from an api.weather.gov
 * gridpoint ("forecastGridData") properties object. Null when the forecast
 * doesn't reach the window (it runs about 7 days).
 */
export function gridWindow(props, startMs, endMs) {
  if (!props) return null;
  const thunder = overlapping(props.probabilityOfThunder, startMs, endMs);
  const ceil = overlapping(props.ceilingHeight, startMs, endMs);
  const vis = overlapping(props.visibility, startMs, endMs);
  const gust = overlapping(props.windGust, startMs, endMs);
  const wind = overlapping(props.windSpeed, startMs, endMs);
  if (!thunder.length && !ceil.length && !vis.length && !wind.length) return null;
  const ceilFt = ceil.length ? Math.min(...ceil) * 3.28084 : 99999;
  const visSm = vis.length ? Math.min(...vis) / 1609.34 : 99;
  return {
    cat: flightCategory(ceilFt, visSm),
    ceilFt: ceil.length ? Math.round(ceilFt / 100) * 100 : null,
    visSm: vis.length ? Math.round(visSm * 10) / 10 : null,
    thunderPct: thunder.length ? Math.max(...thunder) : 0,
    gust: gust.length ? Math.round(Math.max(...gust) / 1.852) : 0,       // km/h → kt
    wspd: wind.length ? Math.round(Math.max(...wind) / 1.852) : 0,
  };
}
export const THUNDER_LIKELY = 50, THUNDER_POSSIBLE = 25;

/** AAR factor for the field's own forecast (assumption, shown with its reasons). */
export function weatherAarFactor(w) {
  if (!w) return { factor: 1, reasons: [] };
  let f = 1; const reasons = [];
  if (w.cat === "LIFR") { f *= 0.75; reasons.push("LIFR \u00D70.75"); }
  else if (w.cat === "IFR") { f *= 0.85; reasons.push("IFR \u00D70.85"); }
  if (w.thunderPct >= THUNDER_LIKELY) { f *= 0.65; reasons.push("thunderstorms " + w.thunderPct + "% \u00D70.65"); }
  else if (w.thunderPct >= THUNDER_POSSIBLE) { f *= 0.85; reasons.push("thunderstorms " + w.thunderPct + "% \u00D70.85"); }
  if (w.gust >= 30) { f *= 0.85; reasons.push("gusts " + w.gust + " kt \u00D70.85"); }
  return { factor: f, reasons };
}

/** Points on a ring around the field (for the regional forecast), one per 45 degrees. */
export function ringPoints(fieldLL, nm, count = 8) {
  const out = [], R = 3440.065, d = nm / R, la1 = toRad(fieldLL[0]), lo1 = toRad(fieldLL[1]);
  for (let i = 0; i < count; i++) {
    const brg = toRad(i * 360 / count);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
    const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    out.push({ brg: i * 360 / count, ll: [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180] });
  }
  return out;
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassName = brg => COMPASS[Math.round(brg / 45) % 8];

/* ---------------- gates from origins ---------------- */

/** STAR gates at a field with the bearing of each entry point (transitions + common route). */
export function starEntries(procs, icao, fieldLL) {
  const out = [];
  for (const [name, p] of Object.entries(procs || {})) {
    if (!p || p.type !== "STAR" || !/\d[A-Z]?$/.test(name)) continue;
    if (!(p.apt || []).includes(icao)) continue;
    const pts = [];
    for (const t of Object.values(p.transitions || {})) if (t && t[0]) pts.push(t[0]);
    if (p.common && p.common[0]) pts.push(p.common[0]);
    for (const pt of pts) {
      const dist = gcNm(fieldLL[0], fieldLL[1], pt[1], pt[2]);
      if (dist < 15) continue;
      out.push({ gate: gateKey(name), fix: pt[0], brg: bearingDeg(fieldLL[0], fieldLL[1], pt[1], pt[2]), dist });
    }
  }
  return out;
}
/** Gate an origin most likely files: the STAR entry closest in bearing (null without STARs). */
export function gateForOrigin(entries, fieldLL, originLL) {
  if (!entries.length || !originLL) return null;
  const brg = bearingDeg(fieldLL[0], fieldLL[1], originLL[0], originLL[1]);
  let best = null;
  for (const e of entries) {
    const d = angDiff(brg, e.brg);
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && e.gate < best.gate)) best = { gate: e.gate, d };
  }
  return best.gate;
}

/**
 * Where arrivals come from. History (origins during this field's busy hours, else
 * all its origins) when the weekly job has computed it; otherwise a gravity model:
 * each US airport's departures weighted by distance (events draw mostly 1-3 hr flights).
 */
export function originMix({ hist, event, fieldIcao, fieldLL, airportLL, byAirport }) {
  const pick = list => (list || []).filter(([o, n]) => o !== fieldIcao && n > 0);
  const peak = pick(hist && hist.peakOrigins), all = pick(hist && hist.origins), ev = pick(event && event.origins);
  const sum = l => l.reduce((a, [, n]) => a + n, 0);
  if (sum(ev) >= 15) return { list: ev, source: "origins of arrivals during " + event.name };
  if (sum(peak) >= 20) return { list: peak, source: "origins of past arrivals in this field’s busiest hours" };
  if (sum(all) >= 20) return { list: all, source: "origins of past arrivals to this field" };
  const out = [];
  for (const [icao, a] of Object.entries(byAirport || {})) {
    if (icao === fieldIcao || !(a.totalDep > 0)) continue;
    const ll = airportLL(icao);
    if (!ll) continue;
    const d = gcNm(fieldLL[0], fieldLL[1], ll[0], ll[1]);
    const w = d < 100 ? 0.1 : d <= 1000 ? 1 : d <= 1500 ? 1 - 0.8 * (d - 1000) / 500 : 0.05;
    out.push([icao, a.totalDep * w]);
  }
  out.sort((x, y) => y[1] - x[1]);
  return { list: out.slice(0, 60), source: "estimate from each airport’s overall departures and its distance (no arrival history yet)" };
}

/** Share of arrivals per gate from an origin mix; also the top origins with their gate. */
export function gateSharesFromOrigins(mix, entries, fieldLL, airportLL) {
  const gates = {}, origins = [];
  let total = 0;
  for (const [icao, n] of mix) {
    const ll = airportLL(icao);
    const gate = ll ? gateForOrigin(entries, fieldLL, ll) : null;
    if (!gate) continue;
    gates[gate] = (gates[gate] || 0) + n;
    total += n;
    origins.push({ icao, weight: n, gate, nm: Math.round(gcNm(fieldLL[0], fieldLL[1], ll[0], ll[1])) });
  }
  const shares = {};
  for (const g in gates) shares[g] = total ? gates[g] / total : 0;
  for (const o of origins) o.share = total ? o.weight / total : 0;
  return { shares, origins };
}

/* ---------------- demand curve ---------------- */

/** Fraction of the event peak by hour from the event start (i < 0 before, i >= n after). */
export function eventShape(i, n) {
  if (i === -1) return 0.25;
  if (i < -1) return 0;
  if (i >= n) return i === n ? 0.45 : i === n + 1 ? 0.2 : 0;
  return [0.6, 0.95, 1.0][i] ?? 0.85;
}

/**
 * Hourly arrival demand from one hour before the start to two after the end.
 * baselineFn(ms) → normal arrivals/hr for that clock hour (history, may be 0).
 */
export function demandCurve({ startMs, endMs, peak, multiplier = 1, baselineFn = () => 0 }) {
  const t0 = Math.floor(startMs / HOUR) * HOUR;
  const n = Math.max(1, Math.ceil((endMs - t0) / HOUR));
  const hours = [];
  for (let i = -1; i <= n + 1; i++) {
    const t = t0 + i * HOUR;
    const base = baselineFn(t) || 0;
    const ev = peak * multiplier * eventShape(i, n);
    hours.push({ t, base: Math.round(base * 10) / 10, event: Math.round(ev * 10) / 10, demand: Math.round(Math.max(base, ev) + Math.min(base, ev) * 0.5) });
  }
  return hours;
}

/** Normal arrivals for a clock hour from a DOW/hour histogram over `weeks` weeks. */
export function baselineFromHist(apt, weeks) {
  return ms => {
    if (!apt || !apt.days || !(weeks > 0)) return 0;
    const d = new Date(ms);
    const b = (apt.days[d.getUTCDay()] || {})[d.getUTCHours()];
    return b ? (b.arr || 0) / weeks : 0;
  };
}

/* ---------------- TMI recommendations ---------------- */

const METERED_STREAM_MIN = 4;     // arrivals/hr below which a gate needs no MIT under ground delays
const GATE_MIT_CAP_NM = 60;

export const TMI_TIERS = [
  { id: "none", label: "No TMI needed", what: "Demand stays at or under the AAR. Monitor with the Apt Dashboard gate timeline." },
  { id: "mit", label: "MIT per gate", what: "Run miles-in-trail on the loaded gates (table below). Delay is short enough to absorb in the air." },
  { id: "fca", label: "MIT + FCA ground delays", what: "MIT on the loaded gates plus an FCA with RDY / EDCT times for departures within about 2 hours, so the queue waits on the ground." },
  { id: "gdp", label: "Ground delay program", what: "Ground delays (FCA RDY / EDCT) for all origins inside about 2.5 hours, MIT on every loaded gate, and a short ground stop on the nearest origins if the queue keeps growing." },
];

/**
 * Hour-by-hour queue against capacity and the overall recommendation.
 * hours: demandCurve output; aar: arrivals/hr after weather.
 */
export function recommendTmis({ hours, aar, shares }) {
  let backlog = 0;
  const rows = hours.map(h => {
    backlog = Math.max(0, backlog + h.demand - aar);
    return { ...h, over: h.demand - aar, backlog: Math.round(backlog), delayMin: aar > 0 ? Math.round(backlog / aar * 60) : 0 };
  });
  const peakRow = rows.reduce((a, b) => (b.demand > a.demand ? b : a), rows[0]);
  const ratio = aar > 0 ? peakRow.demand / aar : Infinity;
  const maxDelay = Math.max(0, ...rows.map(r => r.delayMin));
  let tier = TMI_TIERS[0];
  if (ratio > 1.4 || maxDelay > 45) tier = TMI_TIERS[3];
  else if (ratio > 1.15 || maxDelay > 15) tier = TMI_TIERS[2];
  else if (ratio > 1) tier = TMI_TIERS[1];
  const overRows = rows.filter(r => r.over > 0 || r.backlog > 0);
  const window = overRows.length
    ? { startMs: overRows[0].t - (tier.id === "fca" || tier.id === "gdp" ? HOUR : 0), endMs: overRows[overRows.length - 1].t + HOUR }
    : null;
  const gateDemand = Object.entries(shares || {})
    .map(([g, s]) => [g, Math.round(peakRow.demand * s)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let gates = aar > 0 && gateDemand.length ? calcGateMit(aar, gateDemand, 0, MIT_NOMINAL_KT) : null;
  if (gates && (tier.id === "fca" || tier.id === "gdp")) {
    /* ground delays hold the airborne flow to the AAR, so each gate delivers its share of
       it; MIT spaces the gates that still run a stream (4+/hr), the rest need none */
    const total = gateDemand.reduce((a, [, n]) => a + n, 0);
    gates = {
      ...gates, metered: true,
      rows: gates.rows.map(r => {
        const slice = aar * r.demand / total;
        const stream = slice >= METERED_STREAM_MIN;
        const mit = stream ? Math.min(GATE_MIT_CAP_NM, Math.ceil(MIT_NOMINAL_KT / slice / 5) * 5) : 0;
        return { ...r, slice, limited: stream && mit > 0, mit };
      }),
    };
  }
  return { rows, peak: peakRow, ratio, maxDelay, tier, window, gates, gateDemand };
}
