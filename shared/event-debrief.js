/**
 * Event debrief from an event-recorder log (scripts/record-event.mjs →
 * data/event-logs/*.json): what the TMIs were and when, what the runways landed
 * against the AAR in force, and per gate how the flow, the in-trail spacing at the
 * gate fix, airborne delay and holding compared with the MIT in force.
 *
 * Pure functions; event-debrief.html draws them.
 */
import { normRate, programGateMitNm, gateKey, NO_GATE } from "./mit-monitor.js";

const MIN = 60000;
export const BIN_MIN = 15;
export const PAIR_MAX_MIN = 8;          // crossings further apart than this aren't an in-trail pair
export const SPACING_SLACK_NM = 2;      // a pair this far inside the MIT counts as short
export const DELAY_RING_NM = 150;       // airborne delay: time from this ring to touchdown, less the unimpeded time

function gcNm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const quantile = (arr, q) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
const median = arr => quantile(arr, 0.5);
export const fmtZ = ms => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "z"; };

/** The program in force at each moment: [{ t, prog (normRate) | null }] in time order. */
export function programTimeline(tmi) {
  return (tmi || []).filter(e => e.kind === "program").sort((a, b) => a.t - b.t).map(e => ({ t: e.t, prog: e.value ? normRate(e.value) : null }));
}
export function programAt(timeline, t) {
  let p = null;
  for (const e of timeline) { if (e.t <= t) p = e.prog; else break; }
  return p;
}

/** What changed between two programs, in words. */
export function describeProgramChange(a, b) {
  if (!a && !b) return [];
  if (!b) return ["Program removed"];
  const out = [];
  if (!a) out.push(`Program set: AAR ${b.aar}` + (b.mit ? `, ${b.mit} MIT` : b.trail ? `, ${b.trail} min trail` : ""));
  else {
    if (a.aar !== b.aar) out.push(`AAR ${a.aar} → ${b.aar}`);
    if (a.mit !== b.mit) out.push(b.mit ? `Airport MIT ${a.mit || "none"} → ${b.mit}` : `Airport MIT ${a.mit} removed`);
    if (a.trail !== b.trail) out.push(b.trail ? `Trail ${a.trail || "none"} → ${b.trail} min` : `Trail ${a.trail} min removed`);
  }
  const rule = g => g.mit ? g.mit + " MIT" : g.trail ? g.trail + " MINIT" : "no MIT";
  const ga = new Map(((a && a.gates) || []).map(g => [gateKey(g.name), g])), gb = new Map(((b && b.gates) || []).map(g => [gateKey(g.name), g]));
  for (const [k, g] of gb) { const o = ga.get(k); if (!o) out.push(`${k} ${rule(g)}`); else if (rule(o) !== rule(g)) out.push(`${k} ${rule(o)} → ${rule(g)}`); }
  for (const [k] of ga) if (!gb.has(k)) out.push(`${k} gate rule removed`);
  const ea = new Map(((a && a.expect) || []).map(x => [x.gate, x.rate])), eb = new Map(((b && b.expect) || []).map(x => [x.gate, x.rate]));
  for (const [k, r] of eb) if (ea.get(k) !== r) out.push(`Expected ${k} ${r}/hr`);
  for (const [k] of ea) if (!eb.has(k)) out.push(`Expected ${k} removed`);
  return out;
}

/** TMI timeline in words: [{ t, kind, text }]; EDCTs are summarised per 15 minutes. */
export function tmiTimeline(tmi) {
  const out = [];
  let prog = null, gs = [], rs = [];
  const edctBins = new Map();
  for (const e of (tmi || []).slice().sort((a, b) => a.t - b.t)) {
    if (e.kind === "program") {
      const next = e.value ? normRate(e.value) : null;
      for (const text of describeProgramChange(prog, next)) out.push({ t: e.t, kind: "program", text });
      prog = next;
    } else if (e.kind === "gs") {
      const key = g => g.scope + "|" + g.until;
      const before = new Set(gs.map(key)), after = new Set((e.value || []).map(key));
      for (const g of e.value || []) if (!before.has(key(g))) out.push({ t: e.t, kind: "gs", text: `Ground stop${g.scope ? " " + g.scope : ""} until ${g.until || "?"}` });
      for (const g of gs) if (!after.has(key(g))) out.push({ t: e.t, kind: "gs", text: `Ground stop${g.scope ? " " + g.scope : ""} cancelled` });
      gs = e.value || [];
    } else if (e.kind === "restrictions") {
      const key = r => [r.requesting, r.providing, r.restriction].join("|");
      const before = new Set(rs.map(key)), after = new Set((e.value || []).map(key));
      for (const r of e.value || []) if (!before.has(key(r))) out.push({ t: e.t, kind: "restriction", text: `${r.restriction} (${r.requesting}→${r.providing}${r.start || r.stop ? " " + r.start + "–" + r.stop : ""})` });
      for (const r of rs) if (!after.has(key(r))) out.push({ t: e.t, kind: "restriction", text: `Removed: ${r.restriction} (${r.requesting}→${r.providing})` });
      rs = e.value || [];
    } else if (e.kind === "edct") {
      const b = Math.floor(e.t / (BIN_MIN * MIN)) * BIN_MIN * MIN;
      const x = edctBins.get(b) || { issued: 0, cleared: 0, cs: [] };
      if (e.value == null) x.cleared++; else { x.issued++; x.cs.push(e.cs); }
      edctBins.set(b, x);
    }
  }
  for (const [b, x] of edctBins) out.push({ t: b, kind: "edct", text: [x.issued ? `${x.issued} EDCT${x.issued === 1 ? "" : "s"} issued (${x.cs.slice(0, 6).join(" ")}${x.cs.length > 6 ? " …" : ""})` : "", x.cleared ? `${x.cleared} cleared` : ""].filter(Boolean).join(", ") });
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The whole debrief.
 * Returns { field, event, from, to, flights, bins, peak, gates, holds, timeline, totals }.
 */
export function buildDebrief(doc, aptLL = null) {
  const from = doc.recorded.length ? Math.min(...doc.recorded.map(r => r[0])) : 0;
  const to = doc.recorded.length ? Math.max(...doc.recorded.map(r => r[1])) : 0;
  const progs = programTimeline(doc.tmi);
  const flights = Object.values(doc.flights || {}).map(f => ({ ...f }));
  const landT = new Map((doc.landings || []).map(l => [l.cs, l.t]));
  for (const f of flights) if (!f.land && landT.has(f.cs)) f.land = landT.get(f.cs);

  /* airborne delay: time from the ring to touchdown, against the 10th percentile for the same gate */
  for (const f of flights) {
    f.t150 = null;
    if (!f.land || !aptLL || !f.pos || !f.pos.length) continue;
    const p = f.pos.find(q => gcNm(q[1], q[2], aptLL[0], aptLL[1]) <= DELAY_RING_NM);
    if (p && p[0] * 1000 < f.land) f.t150 = (f.land - p[0] * 1000) / MIN;
  }
  const byGate = {};
  for (const f of flights) if (f.gate) (byGate[f.gate] = byGate[f.gate] || []).push(f);
  for (const list of Object.values(byGate)) {
    const base = quantile(list.map(f => f.t150).filter(x => x != null && x > 10), 0.1);
    for (const f of list) f.delay = f.t150 != null && base != null ? Math.max(0, Math.round((f.t150 - base) * 10) / 10) : null;
  }

  /* landings per 15 minutes against the AAR in force */
  const bins = [];
  const b0 = Math.floor(from / (BIN_MIN * MIN)) * BIN_MIN * MIN;
  for (let t = b0; t < to; t += BIN_MIN * MIN) {
    const n = (doc.landings || []).filter(l => l.t >= t && l.t < t + BIN_MIN * MIN).length;
    const p = programAt(progs, t + BIN_MIN * MIN / 2);
    const d = flights.filter(f => f.land >= t && f.land < t + BIN_MIN * MIN && f.delay != null).map(f => f.delay);
    const held = (doc.holds || []).filter(h => h.start < t + BIN_MIN * MIN && h.end > t).length;
    bins.push({ start: t, n, aar: p ? p.aar : null, delay: d.length ? Math.round(median(d) * 10) / 10 : null, held });
  }
  let peak = { start: from, n: 0 };
  for (let i = 0; i + 4 <= bins.length; i++) { const n = bins.slice(i, i + 4).reduce((a, b) => a + b.n, 0); if (n > peak.n) peak = { start: bins[i].start, n, aar: bins[i + 2].aar }; }

  /* per gate: flow over the gate fix, in-trail spacing against the MIT in force, delay, holding */
  const gates = Object.entries(byGate).filter(([g]) => g && g !== NO_GATE).map(([gate, list]) => {
    const crossed = list.filter(f => f.cross).sort((a, b) => a.cross.t - b.cross.t);
    const pairs = [];
    for (let i = 1; i < crossed.length; i++) {
      const a = crossed[i - 1], b = crossed[i];
      const dt = (b.cross.t - a.cross.t) / MIN;
      if (dt > PAIR_MAX_MIN) continue;
      const gap = dt / 60 * (b.cross.gs || 300);
      const p = programAt(progs, b.cross.t);
      const mit = p ? programGateMitNm(p, gate).nm : 0;
      pairs.push({ lead: a.cs, trail: b.cs, t: b.cross.t, gap: Math.round(gap * 10) / 10, mit, short: !!(mit && gap < mit - SPACING_SLACK_NM) });
    }
    let peakHr = 0, peakAt = null;
    for (let i = 0; i < crossed.length; i++) {
      let j = i; while (j < crossed.length && crossed[j].cross.t - crossed[i].cross.t < 60 * MIN) j++;
      if (j - i > peakHr) { peakHr = j - i; peakAt = crossed[i].cross.t; }
    }
    const withMit = pairs.filter(p => p.mit);
    const holds = (doc.holds || []).filter(h => h.gate === gate);
    const delays = list.map(f => f.delay).filter(x => x != null);
    const mitsUsed = [...new Set(progs.map(e => e.prog ? programGateMitNm(e.prog, gate).nm : 0).filter(Boolean))];
    return {
      gate, fix: (crossed[0] && crossed[0].gateFix && crossed[0].gateFix.name) || gate,
      arrivals: list.filter(f => f.land).length, crossings: crossed.length, peakHr, peakAt,
      pairs, medianGap: median(pairs.map(p => p.gap)), mitPairs: withMit.length, short: withMit.filter(p => p.short).length,
      medianDelay: delays.length ? Math.round(median(delays) * 10) / 10 : null, p90Delay: delays.length ? Math.round(quantile(delays, 0.9) * 10) / 10 : null,
      holds: holds.length, holdMin: holds.reduce((a, h) => a + (h.min || 0), 0), mitsUsed,
      origins: Object.entries(list.reduce((o, f) => (o[f.dep] = (o[f.dep] || 0) + 1, o), {})).sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  }).sort((a, b) => b.arrivals - a.arrivals || b.crossings - a.crossings);

  const timeline = tmiTimeline(doc.tmi);
  const landed = (doc.landings || []).length;
  const delays = flights.map(f => f.delay).filter(x => x != null);
  const taxi = (doc.taxi || []).map(x => x.min);
  return {
    field: doc.field, event: doc.event, from, to, flights, bins, peak, gates, holds: (doc.holds || []).slice().sort((a, b) => a.start - b.start), timeline,
    totals: {
      landed, holds: (doc.holds || []).length, holdMin: (doc.holds || []).reduce((a, h) => a + (h.min || 0), 0),
      medianDelay: delays.length ? Math.round(median(delays) * 10) / 10 : null, p90Delay: delays.length ? Math.round(quantile(delays, 0.9) * 10) / 10 : null,
      tmiChanges: timeline.filter(e => e.kind !== "edct").length, edcts: (doc.tmi || []).filter(e => e.kind === "edct" && e.value != null).length,
      taxiMedian: taxi.length ? Math.round(median(taxi)) : null, departures: taxi.length,
      maxAar: Math.max(0, ...progs.map(e => (e.prog ? e.prog.aar : 0))),
    },
  };
}
