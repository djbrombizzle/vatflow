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
 * ground stops, the NWS forecast, SIGMETs and the event calendar.
 *
 * Recommendations are advice only. Programs are still set on Airport TMU, ground
 * delays are still issued from an FCA (FCA Builder / IDST).
 */
import {
  buildMitMonitor, rollingGateDemand, gateMitTimeline, gateMitSchedule, programGateMitNm,
  calcGateMit, normRate, NO_GATE, MIT_NOMINAL_KT,
} from "./mit-monitor.js";
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
 * The rate VATSMART plans against: the hub program's AAR (else the AAR typed on
 * this page), cut for the field's forecast weather the same way the Event planner
 * does. Returns { aar, capacity, source: "program"|"local"|"none", factor, reasons }.
 */
export function capacityFor({ prog, localAar = 0, wx = null }) {
  const aar = prog && prog.aar > 0 ? prog.aar : localAar > 0 ? localAar : 0;
  const source = prog && prog.aar > 0 ? "program" : localAar > 0 ? "local" : "none";
  const w = weatherAarFactor(wx);
  return { aar, capacity: aar ? Math.max(1, Math.round(aar * w.factor)) : 0, source, factor: w.factor, reasons: w.reasons };
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

/* ---------------- the situation ---------------- */

/**
 * Everything VATSMART shows for one field.
 *   airport, aptLL, prog (hub program or null), localAar (AAR typed on the page)
 *   pilots, prefiles, airportLL   same as buildMitMonitor
 *   wx        worst NWS conditions over the lookahead (event-planner gridWindow) or null
 *   hub       { edcts, groundStops, restrictions } wire maps (may be empty)
 *   sigmets   [{ sequence, hazard, text }] for the field's ARTCC
 *   events    upcoming VATSIM events [{ name, startMs, endMs, airports: [icao], link }]
 *   pastEvents data/event-history.json entries for the field
 */
export function buildSituation({
  airport, aptLL, prog = null, localAar = 0, pilots = [], prefiles = [], airportLL = () => null,
  now = Date.now(), wx = null, hub = {}, sigmets = [], events = [], pastEvents = [],
}) {
  const cap = capacityFor({ prog, localAar, wx });
  const program = prog || normRate({ aar: cap.aar });
  const mon = buildMitMonitor({ airport, aptLL, prog: { ...program, aar: cap.capacity || 9999 }, pilots, prefiles, airportLL, now });

  const live = mon.flights.filter(f => !f.excluded && f.status !== "ARRIVED" && f.eta != null)
    .map(f => ({ ...f, prefiled: f.status === "PREFILE" }));
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
    airport, now, cap, prog, program, mon, flights: mon.flights, live, roll, peakWin, next60, queue, ratio, tier,
    gates, counts, edct, gs, restrictions, wx, sigmets: sigmets || [], upcoming, reference,
  };
  sit.recs = recommend(sit);
  return sit;
}

/* ---------------- recommendations ---------------- */

const SEV_RANK = { action: 0, watch: 1, info: 2 };
const LINK = {
  tmu: { href: "vatflow-tbfm%20v2.html", label: "Airport TMU" },
  fca: { href: "FCA-builderv02.html", label: "FCA Builder" },
  idst: { href: "idst.html", label: "IDST" },
  dash: { href: "vatflow-tbfm%20v2.html", label: "Apt Dashboard" },
};

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
    add({ id: "wx-aar", sev: "action", title: `Lower the AAR to ${cap} for weather`,
      why: `The forecast over the next 3 hours cuts ${apt}'s rate (${s.cap.reasons.join(", ")}), so the ${s.cap.aar}/hr ${s.cap.source === "program" ? "program" : "AAR"} is optimistic. VATSMART already plans against ${cap}/hr.`,
      link: s.cap.source === "program" ? LINK.tmu : null });
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

  /* gate MIT plan: the next change on each gate */
  for (const g of s.gates) {
    const next = g.schedule[0];
    if (!next) continue;
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

  /* rebalance across gates */
  const rb = rebalanceSuggestion(pw, cap);
  if (rb) add({ id: "rebalance", sev: "info", title: `Shift ~${rb.move}/hr from ${rb.from} to ${rb.to}`,
    why: `At the peak the whole excess queues on ${rb.from} (${rb.queueBefore} more an hour than its share of the rate). Rerouting about ${rb.move} an hour to ${rb.to}, where a reroute is practical, spreads the delay so no gate queues more than ${rb.queueAfter} an hour.` });

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
  const conv = (s.sigmets || []).filter(x => /convect|\bts\b/i.test(x.hazard || ""));
  if (conv.length) add({ id: "sigmet", sev: "watch", title: `${plural(conv.length, "convective SIGMET")} near ${apt}'s center`,
    why: conv.slice(0, 3).map(x => (x.sequence ? x.sequence + ": " : "") + String(x.text || "").slice(0, 140)).join(" · ") });

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
