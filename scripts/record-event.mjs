#!/usr/bin/env node
/**
 * Event recorder: logs what happened at an event field so it can be debriefed
 * afterwards (event-debrief.html) without asking anyone what TMIs were in force.
 *
 * Runs in GitHub Actions (.github/workflows/event-recorder.yml). Each run looks
 * for VATSIM events at US fields that are on now or start within LEAD_MIN, plus
 * fields with an Airport TMU program and real traffic, then polls until the
 * events end (+ TAIL_MIN) or RUN_SECONDS runs out. Writes, per field:
 *
 *   data/event-logs/<YYYY-MM-DD>-<ICAO>.json
 *     tmi:      every change to the field's Airport TMU program (AAR, MIT, gate rules,
 *               expected demand), ground stops, restrictions and EDCTs, from the hub
 *     flights:  each arrival: origin, type, route, gate, gate fix, when it crossed the
 *               gate fix (and its groundspeed), when it landed, a position every minute
 *               inside POS_RANGE_NM
 *     landings / holds: from shared/arrival-track.js (same rules as VATSMART)
 *     taxi:     departure taxi-out times (same rules as the Taxi Monitor)
 *   data/event-logs/index.json   one row per log
 *
 * Env:
 *   FIELDS        comma list to record regardless of events (e.g. "KMCO,KATL")
 *   RUN_SECONDS   longest a run polls (default 20700 = 5 h 45 min, inside the job limit)
 *   POLL_MS       feed poll interval (default 30000)
 *   OUT_DIR       default data/event-logs
 *   HUB_URL       default the production VATFLOW hub
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedNavData, buildRouteAnchors } from "../shared/route-engine.js";
import { seedAirports, getAirport } from "../shared/fca-metering.js";
import { arrivalGate, normRate, gateKey } from "../shared/mit-monitor.js";
import { gateFixFor } from "../shared/gate-eta.js";
import { createArrivalState, updateArrivals } from "../shared/arrival-track.js";
import { trackTaxi } from "../shared/vatsmart.js";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "data/event-logs");
const RUN_SECONDS = +(process.env.RUN_SECONDS || 20700);
const POLL_MS = Math.max(15000, +(process.env.POLL_MS || 30000));
const HUB_URL = (process.env.HUB_URL || "https://vatflow-hub-production.up.railway.app").replace(/^http/, "ws");
const FEED_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const EVENTS_URL = "https://my.vatsim.net/api/v2/events/latest";
const LEAD_MIN = 45, TAIL_MIN = 45;
const MAX_FIELDS = 8;
const POS_RANGE_NM = 300, POS_EVERY_MS = 60000;
const CROSS_NM = 8;                     // a flight "crosses" its gate fix at its closest pass inside this
const BUSY_INBOUND = 15;                // a program-only field is recorded when this many arrivals are inbound
const SAVE_EVERY_MS = 5 * 60000;
const US = /^(K[A-Z0-9]{3}|P[AHG][A-Z0-9]{2}|TJ[A-Z0-9]{2})$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function gcNm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* ---------------- nav data and airports from the checkout ---------------- */
function loadNav() {
  const nav = n => JSON.parse(fs.readFileSync(path.join(ROOT, "data/nav", n + ".json")));
  seedNavData({ meta: nav("meta"), fixes: nav("fixes"), navaids: nav("navaids"), airways: nav("airways"), procedures: nav("procedures"), preferred: nav("preferred") });
  const apts = {};
  for (const [k, rws] of Object.entries(nav("runways"))) {
    if (!Array.isArray(rws) || !rws.length) continue;
    apts[k] = [rws.reduce((a, r) => a + r[1], 0) / rws.length, rws.reduce((a, r) => a + r[2], 0) / rws.length];
  }
  seedAirports(apts);
}

/* ---------------- the hub (read only: never push) ---------------- */
const hub = { state: null, at: 0 };
function connectHub() {
  if (typeof WebSocket === "undefined") { log("no WebSocket in this Node; TMIs won't be logged"); return; }
  let ws;
  try { ws = new WebSocket(HUB_URL); } catch (e) { log("hub:", e.message); setTimeout(connectHub, 15000); return; }
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch (_) { return; }
    if (m.type !== "state") return;
    hub.state = { rates: m.rates || {}, edcts: m.edcts || {}, groundStops: m.groundStops || {}, restrictions: m.restrictions || {} };
    hub.at = Date.now();
  };
  ws.onclose = () => setTimeout(connectHub, 10000);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

/* the field's TMIs from one hub state, as plain comparable values */
function tmiSnapshot(state, field, arrivals) {
  if (!state) return null;
  const short = field.replace(/^K/, "");
  const norm = s => { s = String(s || "").toUpperCase().trim(); return s.length === 3 ? "K" + s : s; };
  const raw = state.rates[field];
  const p = raw ? normRate(raw) : null;
  const program = p && p.aar > 0 ? { aar: p.aar, mit: p.mit, trail: p.trail, gates: p.gates, expect: p.expect } : null;
  const gs = Object.values(state.groundStops || {}).filter(g => g && norm(g.airport) === field)
    .map(g => ({ scope: String(g.scope || "").trim(), until: g.until || "" })).sort((a, b) => (a.scope + a.until).localeCompare(b.scope + b.until));
  const re = new RegExp("\\b(" + field + "|" + short + ")\\b", "i");
  const restrictions = Object.values(state.restrictions || {}).filter(r => r && re.test([r.requesting, r.providing, r.restriction].join(" ")))
    .map(r => ({ requesting: r.requesting || "", providing: r.providing || "", restriction: r.restriction || "", start: r.start || "", stop: r.stop || "" }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const edcts = {};
  for (const e of Object.values(state.edcts || {})) if (e && e.cs && +e.t > 0 && arrivals.has(e.cs)) edcts[e.cs] = +e.t;
  return { program, gs, restrictions, edcts };
}

/* ---------------- which fields ---------------- */
async function pickFields(now) {
  const want = new Map();
  for (const f of String(process.env.FIELDS || "").split(/[,\s]+/).filter(Boolean)) want.set(f.toUpperCase(), { name: "Requested", startMs: now, endMs: now + RUN_SECONDS * 1000 });
  try {
    const j = await getJson(EVENTS_URL);
    for (const e of (Array.isArray(j) ? j : j.data || [])) {
      const startMs = Date.parse(e.start_time), endMs = Date.parse(e.end_time);
      if (!(startMs - LEAD_MIN * 60000 <= now && endMs + TAIL_MIN * 60000 > now)) continue;
      const icaos = new Set([...(e.airports || []).map(a => a && a.icao), ...(e.routes || []).map(r => r && r.arrival)].filter(Boolean).map(s => String(s).toUpperCase()));
      for (const icao of icaos) if (US.test(icao) && !want.has(icao)) want.set(icao, { name: e.name || "Event", startMs, endMs, id: e.id });
    }
  } catch (e) { log("events:", e.message); }
  return want;
}

/* ---------------- one field's log ---------------- */
function fileFor(field, startMs) { return path.join(OUT_DIR, new Date(startMs).toISOString().slice(0, 10) + "-" + field + ".json"); }
function openLog(field, ev, now) {
  const file = fileFor(field, ev.startMs);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  if (!doc || doc.field !== field) doc = { v: 1, field, event: { name: ev.name, startMs: ev.startMs, endMs: ev.endMs, id: ev.id || null }, recorded: [], tmi: [], flights: {}, landings: [], holds: [], taxi: [] };
  doc.recorded.push([now, now]);
  const arr = createArrivalState(now);
  return { field, file, doc, arr, taxiSessions: {}, last: { tmi: null }, ll: getAirport(field), lastPos: {} };
}

function stepFeed(L, pilots, now) {
  const { field, doc, ll } = L;
  if (!ll) return;
  const fl = doc.flights;
  const arrivals = pilots.filter(p => p.arr === field);
  for (const p of arrivals) {
    let f = fl[p.callsign];
    if (!f || f.route !== p.route) {
      const gate = arrivalGate(p.route, field);
      let gateFix = null;
      try { const a = buildRouteAnchors(p).anchors; const g = gateFixFor(a, gate); if (g) gateFix = { name: g.name, ll: g.ll.map(x => +x.toFixed(4)) }; } catch (_) {}
      f = fl[p.callsign] = { ...(f || {}), cs: p.callsign, dep: p.dep, type: p.type, route: p.route, gate, gateFix, first: (f && f.first) || now, pos: (f && f.pos) || [] };
    }
    if (p.lat == null) continue;
    const air = p.gs >= 60;
    if (air && !f.off && p.dep && getAirport(p.dep) && gcNm(p.lat, p.lon, ...getAirport(p.dep)) < 15) f.off = now;
    const dist = gcNm(p.lat, p.lon, ll[0], ll[1]);
    if (air && dist <= POS_RANGE_NM && now - (L.lastPos[p.callsign] || 0) >= POS_EVERY_MS - 2000) {
      L.lastPos[p.callsign] = now;
      f.pos.push([Math.round(now / 1000), +p.lat.toFixed(3), +p.lon.toFixed(3), Math.round((p.alt || 0) / 100), Math.round(p.gs || 0), Math.round(p.hdg || 0)]);
    }
    if (air && f.gateFix && !f.cross) {
      const d = gcNm(p.lat, p.lon, f.gateFix.ll[0], f.gateFix.ll[1]);
      if (d <= CROSS_NM && (!f.near || d < f.near.d)) f.near = { t: now, d: +d.toFixed(1), gs: Math.round(p.gs), alt: Math.round((p.alt || 0) / 100) };
      else if (f.near && d > f.near.d + 2) { f.cross = f.near; delete f.near; }
    }
  }
  const { landed, ended } = updateArrivals(L.arr, pilots, field, ll, now);
  for (const l of landed) {
    doc.landings.push(l);
    if (fl[l.cs]) { fl[l.cs].land = l.t; if (!fl[l.cs].cross && fl[l.cs].near) { fl[l.cs].cross = fl[l.cs].near; delete fl[l.cs].near; } }
  }
  for (const h of ended) doc.holds.push(h);
  for (const t of trackTaxi(L.taxiSessions, pilots, field, ll, now)) doc.taxi.push({ cs: t.callsign, start: t.startMs, end: t.endMs, min: +(t.durationMs / 60000).toFixed(1) });
  const rec = doc.recorded[doc.recorded.length - 1];
  rec[1] = now;
}

function stepHub(L, now) {
  if (!hub.state) return;
  const arrivals = new Set(Object.keys(L.doc.flights));
  const snap = tmiSnapshot(hub.state, L.field, arrivals);
  const prev = L.last.tmi || (() => {
    /* carry on from the log's last known state, so a rerun doesn't log everything as new */
    const s = { program: null, gs: [], restrictions: [], edcts: {} };
    for (const e of L.doc.tmi) {
      if (e.kind === "program") s.program = e.value;
      else if (e.kind === "gs") s.gs = e.value;
      else if (e.kind === "restrictions") s.restrictions = e.value;
      else if (e.kind === "edct") { if (e.value == null) delete s.edcts[e.cs]; else s.edcts[e.cs] = e.value; }
    }
    return s;
  })();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of ["program", "gs", "restrictions"]) if (!same(prev[k], snap[k])) L.doc.tmi.push({ t: now, kind: k, value: snap[k] });
  for (const cs of new Set([...Object.keys(prev.edcts), ...Object.keys(snap.edcts)])) {
    if (prev.edcts[cs] !== snap.edcts[cs]) L.doc.tmi.push({ t: now, kind: "edct", cs, value: snap.edcts[cs] == null ? null : snap.edcts[cs] });
  }
  L.last.tmi = snap;
}

function save(logs) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const idxFile = path.join(OUT_DIR, "index.json");
  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(idxFile, "utf8")); } catch (_) {}
  for (const L of logs) {
    const d = L.doc;
    for (const f of Object.values(d.flights)) if (f.near && !f.cross && f.land) { f.cross = f.near; delete f.near; }
    fs.writeFileSync(L.file, JSON.stringify(d));
    const row = { file: path.basename(L.file), field: d.field, name: d.event.name, startMs: d.event.startMs, endMs: d.event.endMs,
      from: d.recorded[0][0], to: d.recorded[d.recorded.length - 1][1], landings: d.landings.length, tmiChanges: d.tmi.length };
    idx = idx.filter(r => r.file !== row.file).concat(row);
  }
  idx.sort((a, b) => b.from - a.from);
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));
}

async function main() {
  loadNav();
  connectHub();
  const t0 = Date.now();
  const deadline = t0 + RUN_SECONDS * 1000;
  await sleep(5000);                         // let the hub state arrive
  let fields = await pickFields(Date.now());
  /* fields with a program and real traffic count too */
  let feed = null;
  try { feed = await getJson(FEED_URL); } catch (e) { log("feed:", e.message); }
  if (hub.state && feed) {
    for (const icao of Object.keys(hub.state.rates || {}).map(s => s.toUpperCase())) {
      if (fields.has(icao) || !US.test(icao) || !(normRate(hub.state.rates[icao]).aar > 0)) continue;
      const n = (feed.pilots || []).filter(p => p.flight_plan && String(p.flight_plan.arrival).toUpperCase() === icao).length;
      if (n >= BUSY_INBOUND) fields.set(icao, { name: "Airport TMU program", startMs: Date.now(), endMs: Date.now() + 2 * 3600000 });
    }
  }
  fields = new Map([...fields].slice(0, MAX_FIELDS));
  if (!fields.size) { log("nothing to record"); console.log("done"); return; }
  const endAt = Math.min(deadline, Math.max(...[...fields.values()].map(e => e.endMs + TAIL_MIN * 60000)));
  log("recording", [...fields.keys()].join(", "), "until", new Date(endAt).toISOString());
  const logs = [...fields].map(([f, ev]) => openLog(f, ev, Date.now()));
  let savedAt = Date.now();
  while (Date.now() < endAt) {
    const now = Date.now();
    try {
      feed = await getJson(FEED_URL);
      const pilots = (feed.pilots || []).filter(p => typeof p.latitude === "number").map(p => {
        const fp = p.flight_plan || {};
        return { callsign: p.callsign, lat: p.latitude, lon: p.longitude, alt: p.altitude || 0, gs: p.groundspeed || 0, hdg: p.heading || 0,
          dep: String(fp.departure || "").toUpperCase(), arr: String(fp.arrival || "").toUpperCase(), route: fp.route || "", type: String(fp.aircraft_short || "").split("/")[0],
          tas: +fp.cruise_tas || 0, fpAlt: parseInt(fp.altitude, 10) || 0, phase: (p.groundspeed || 0) < 50 ? "gnd" : "air" };
      });
      for (const L of logs) stepFeed(L, pilots, now);
    } catch (e) { log("feed:", e.message); }
    for (const L of logs) stepHub(L, Date.now());
    if (Date.now() - savedAt >= SAVE_EVERY_MS) { save(logs); savedAt = Date.now(); log("saved", logs.map(L => `${L.field} ${L.doc.landings.length} landed`).join(", ")); }
    await sleep(Math.max(1000, POLL_MS - (Date.now() - now)));
  }
  save(logs);
  log("finished", logs.map(L => `${L.field}: ${L.doc.landings.length} landings, ${L.doc.tmi.length} TMI changes, ${L.doc.holds.length} holds`).join("; "));
  console.log("done");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });

export { tmiSnapshot, stepFeed, stepHub, openLog };
