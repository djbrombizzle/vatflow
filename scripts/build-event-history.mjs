#!/usr/bin/env node
/**
 * Build data/event-history.json for the Airport TMU Event planner: each US
 * field's VATSIM events from StatSim (https://statsim.net/events/past), with
 * arrivals per hour from each event's page and, when STATSIM_API_KEY is set,
 * where those arrivals came from (for the planner's gate split).
 *
 * StatSim's past-events page only lists the last 12 months, so events already in
 * the file that have dropped off it are kept: the history grows past a year.
 *
 * Usage:
 *   node scripts/build-event-history.mjs
 *
 * Env:
 *   STATSIM_API_KEY            optional; adds arrival origins per event (/api/Flights/Icao)
 *   EVENT_HISTORY_PER_FIELD    events kept per field, newest first (default 40)
 *   EVENT_HISTORY_ORIGINS_PER_FIELD  newest events per field that get origins (default 10)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUsStaffingAirport, fetchStatsimIcaoWindow } from "./lib/staffing-hist-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "event-history.json");
const BASE = "https://statsim.net";
const PER_FIELD = Math.max(1, parseInt(process.env.EVENT_HISTORY_PER_FIELD || "40", 10));
const ORIGINS_PER_FIELD = Math.max(0, parseInt(process.env.EVENT_HISTORY_ORIGINS_PER_FIELD || "10", 10));
const API_KEY = process.env.STATSIM_API_KEY || "";
const UA = "VATFLOW-event-history/1.0 (+https://vatflow.io)";
const HOUR = 3600000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { last = e; await sleep(2000 * (i + 1)); }
  }
  throw new Error(url + ": " + (last && last.message));
}

/** StatSim times are UTC "YYYY-MM-DD HH:MM". */
function parseUtc(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
const unescapeHtml = s => String(s || "").replace(/&amp;/g, "&").replace(/&#39;|&#039;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** Rows of the past-events table: { id, name, startMs, endMs, airports, type }. */
export function parsePastEvents(html) {
  const out = [];
  const re = /<a href="\/events\/(\d+)">([^<]*)<\/a><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const startMs = parseUtc(m[3]), endMs = parseUtc(m[4]);
    if (startMs == null || endMs == null) continue;
    out.push({
      id: +m[1], name: unescapeHtml(m[2]), startMs, endMs,
      airports: m[5].split(",").map(a => a.trim().toUpperCase()).filter(Boolean),
      type: unescapeHtml(m[6]),
    });
  }
  return out;
}

/** Hourly arrivals/departures per field from an event page's `airportCharts`. */
export function parseEventCharts(html) {
  const m = String(html).match(/airportCharts\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!m) return {};
  let data;
  try { data = JSON.parse(m[1]); } catch { return {}; }
  const out = {};
  for (const a of data || []) {
    if (!a || !a.icao) continue;
    const arr = (a.arrivals || []).map(p => ({ t: +p.x, n: +p.y || 0 }));
    const dep = (a.departures || []).map(p => ({ t: +p.x, n: +p.y || 0 }));
    out[String(a.icao).toUpperCase()] = {
      arrByHour: arr,
      arr: arr.reduce((s, p) => s + p.n, 0),
      dep: dep.reduce((s, p) => s + p.n, 0),
      peakArr: arr.reduce((s, p) => Math.max(s, p.n), 0),
    };
  }
  return out;
}

/** Each US field's most recent events (traffic events only, not controller exams). */
export function pickRecentByField(events, perField) {
  const byField = {};
  for (const ev of events) {
    if (/examination/i.test(ev.type)) continue;
    for (const a of ev.airports) if (isUsStaffingAirport(a)) (byField[a] || (byField[a] = [])).push(ev);
  }
  for (const a in byField) byField[a] = byField[a].sort((x, y) => y.startMs - x.startMs).slice(0, perField);
  return byField;
}

/**
 * Merge freshly built per-field event lists with the previous file's: new records
 * win, older events that StatSim no longer lists are kept, origins already fetched
 * for an event carry over, and each field keeps its newest `perField` events.
 */
export function mergeHistory(fresh, previous, perField) {
  const out = {};
  for (const icao of new Set([...Object.keys(previous || {}), ...Object.keys(fresh || {})])) {
    const byId = new Map();
    for (const ev of (previous && previous[icao]) || []) byId.set(ev.id, ev);
    for (const ev of (fresh && fresh[icao]) || []) {
      const old = byId.get(ev.id);
      byId.set(ev.id, !ev.origins && old && old.origins ? { ...ev, origins: old.origins } : ev);
    }
    const list = [...byId.values()].sort((a, b) => b.startMs - a.startMs).slice(0, perField);
    if (list.length) out[icao] = list;
  }
  return out;
}

function readPrevious() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")).airports || {}; } catch { return {}; }
}

async function main() {
  const previous = readPrevious();
  console.log("fetching past events");
  const events = parsePastEvents(await getText(BASE + "/events/past"));
  console.log("past events:", events.length);
  const byField = pickRecentByField(events, PER_FIELD);
  const ids = [...new Set(Object.values(byField).flat().map(e => e.id))];
  console.log("fields:", Object.keys(byField).length, "event pages:", ids.length);

  const charts = {};
  let i = 0;
  for (const id of ids) {
    i++;
    try {
      charts[id] = parseEventCharts(await getText(BASE + "/events/" + id));
    } catch (e) {
      console.warn("  event", id, "failed:", e.message);
    }
    if (i % 20 === 0) console.log("  pages", i + "/" + ids.length);
    await sleep(400);                       // be gentle with statsim.net
  }

  const airports = {};
  for (const [icao, evs] of Object.entries(byField)) {
    const list = [];
    const had = new Map((previous[icao] || []).map(e => [e.id, e]));
    for (const [n, ev] of evs.entries()) {
      const c = charts[ev.id] && charts[ev.id][icao];
      if (!c) continue;
      const rec = {
        id: ev.id, name: ev.name, startMs: ev.startMs, endMs: ev.endMs,
        fields: ev.airports, arr: c.arr, dep: c.dep, peakArr: c.peakArr, arrByHour: c.arrByHour,
      };
      const old = had.get(ev.id);
      if (old && old.origins) rec.origins = old.origins;
      else if (API_KEY && n < ORIGINS_PER_FIELD) {
        try {
          const rows = await fetchStatsimIcaoWindow(icao, ev.startMs - HOUR, ev.endMs + 2 * HOUR, API_KEY, { timeoutMs: 120000 });
          const origins = {};
          for (const f of rows) if (f.kind === "arr" && f.dest === icao && f.origin && f.origin !== icao) origins[f.origin] = (origins[f.origin] || 0) + 1;
          rec.origins = Object.entries(origins).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30);
        } catch (e) {
          console.warn("  origins", icao, ev.id, "failed:", e.message);
        }
      }
      list.push(rec);
    }
    if (list.length) airports[icao] = list;
  }
  const merged = mergeHistory(airports, previous, PER_FIELD);
  const out = {
    computed_at: new Date().toISOString(),
    source: BASE + "/events/past",
    per_field: PER_FIELD,
    with_origins: !!API_KEY,
    airports: merged,
  };
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log("wrote", OUT, Object.keys(merged).length, "fields,", Object.values(merged).flat().length, "field events");
  console.log("done");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
