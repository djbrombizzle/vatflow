#!/usr/bin/env node
/**
 * Rebuild an event log for a past event from StatSim, for events the recorder
 * (scripts/record-event.mjs) didn't run for. StatSim's airport window page lists
 * the arrivals; each flight's detail page has its filed route and a position every
 * ~15 s. Those positions are replayed through the recorder's own steps, so gate
 * crossings, landings and holding come out the same way. There are no TMIs in it:
 * StatSim doesn't know what TMU set, so the debrief shows them as unknown.
 *
 * Usage:
 *   node scripts/statsim-event-log.mjs --field KMCO --from 2026-10-09T22:00 --to 2026-10-10T04:00 [--name "Halloween Horror Ops FNO"]
 * Writes data/event-logs/<from date>-<FIELD>.json and updates the index. No API key needed.
 */
import fs from "node:fs";
import path from "node:path";
import { seedNavData } from "../shared/route-engine.js";
import { seedAirports } from "../shared/fca-metering.js";
import { openLog, stepFeed } from "./record-event.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const FIELD = String(args.get("field") || "").toUpperCase();
const FROM = args.get("from"), TO = args.get("to");
if (!/^[A-Z0-9]{4}$/.test(FIELD) || !FROM || !TO) { console.error("usage: --field KMCO --from 2026-10-09T22:00 --to 2026-10-10T04:00 [--name ...]"); process.exit(2); }
const ROOT = new URL("..", import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, "data/event-logs");
const BASE = "https://statsim.net";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { "User-Agent": "vatflow-event-log" } }); if (r.ok) return await r.text(); } catch (_) {}
    await sleep(2000 * (i + 1));
  }
  return "";
}
const text = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

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

/** One StatSim flight: { cs, dep, route, type, fpAlt, pts: [{ t, lat, lon, alt, gs, hdg }] }. Samples sharing a minute are spread across it. */
export function parseDetail(html, cs) {
  const t = text(html);
  const route = (t.match(/Route (.*?) Aircraft (\S+)/) || []);
  const dep = (t.match(/([A-Z0-9]{3,4})-[A-Z0-9]{3,4} Flight info/) || [])[1] || "";
  const fpAlt = +((t.match(/Altitude (\d+) Route/) || [])[1] || 0);
  const by = new Map();
  for (const m of t.matchAll(/(\d{4}-\d\d-\d\d \d\d:\d\d) (-?\d+\.\d+) (-?\d+\.\d+) (-?\d+) ft (\d+) kts (\d+)°/g)) {
    if (!by.has(m[1])) by.set(m[1], []);
    by.get(m[1]).push(m);
  }
  const pts = [];
  for (const [k, list] of by) {
    const t0 = Date.parse(k.replace(" ", "T") + ":00Z");
    list.forEach((m, i) => pts.push({ t: t0 + Math.round(i * 60000 / list.length), lat: +m[2], lon: +m[3], alt: +m[4], gs: +m[5], hdg: +m[6] }));
  }
  pts.sort((a, b) => a.t - b.t);
  return { cs, dep, route: route[1] || "", type: (route[2] || "").split("/")[0], fpAlt, pts };
}

async function main() {
  loadNav();
  const win = `${encodeURIComponent(FROM)}/${encodeURIComponent(TO)}`;
  const page = await get(`${BASE}/flights/airport/${FIELD}/custom/${win}`);
  const arrived = page.slice(page.indexOf("Arrived ("));
  const ids = [...arrived.matchAll(/\/flights\/detail\/(\d+)">([A-Z0-9]+)<\/a>/g)].map(m => [m[1], m[2]]);
  if (!ids.length) { console.error("no arrivals on " + `${BASE}/flights/airport/${FIELD}/custom/${win}`); process.exit(1); }
  console.log(ids.length, "arrivals; fetching flight pages");
  const flights = [];
  for (const [id, cs] of ids) {
    const f = parseDetail(await get(`${BASE}/flights/detail/${id}`), cs);
    if (f.pts.length) flights.push(f);
    await sleep(250);
  }
  const fromMs = Date.parse(FROM + "Z"), toMs = Date.parse(TO + "Z");
  const L = openLog(FIELD, { name: args.get("name") || `${FIELD} ${FROM}–${TO}`, startMs: fromMs, endMs: toMs }, fromMs);
  Object.assign(L.doc, { source: "statsim", tmi: [], flights: {}, landings: [], holds: [], taxi: [] });   // a rebuild starts clean
  L.doc.recorded = [[fromMs, fromMs]];
  /* replay: a feed snapshot every 15 s */
  const idx = flights.map(() => 0);
  for (let t = fromMs; t <= toMs; t += 15000) {
    const pilots = [];
    flights.forEach((f, i) => {
      while (idx[i] + 1 < f.pts.length && f.pts[idx[i] + 1].t <= t) idx[i]++;
      const p = f.pts[idx[i]];
      if (!p || p.t > t || t - p.t > 30000) return;
      pilots.push({ callsign: f.cs, lat: p.lat, lon: p.lon, alt: p.alt, gs: p.gs, hdg: p.hdg, dep: f.dep, arr: FIELD, route: f.route, type: f.type,
        tas: 0, fpAlt: f.fpAlt, phase: p.gs < 50 ? "gnd" : "air" });
    });
    stepFeed(L, pilots, t);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of Object.values(L.doc.flights)) if (f.near && !f.cross && f.land) { f.cross = f.near; delete f.near; }
  fs.writeFileSync(L.file, JSON.stringify(L.doc));
  const idxFile = path.join(OUT_DIR, "index.json");
  let index = [];
  try { index = JSON.parse(fs.readFileSync(idxFile, "utf8")); } catch (_) {}
  const d = L.doc;
  index = index.filter(r => r.file !== path.basename(L.file)).concat({ file: path.basename(L.file), field: FIELD, name: d.event.name, startMs: fromMs, endMs: toMs,
    from: fromMs, to: toMs, landings: d.landings.length, tmiChanges: 0, source: "statsim" });
  index.sort((a, b) => b.from - a.from);
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 1));
  console.log(`wrote ${path.relative(ROOT, L.file)}: ${Object.keys(d.flights).length} arrivals, ${d.landings.length} landings, ${d.holds.length} holds`);
}

main().catch(e => { console.error(e); process.exit(1); });
