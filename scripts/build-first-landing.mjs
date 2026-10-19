#!/usr/bin/env node
/**
 * Build data/first-landing/fields.json for First to Land: US fields (OurAirports: airports
 * and seaplane bases, US and territories) where StatSim has never logged a VATSIM arrival
 * since its records begin (January 2020). vatflow-hub watches the live feed for the first
 * landing at each of them (first-landing.js there).
 *
 * Daily (default): read StatSim's US flight list since the last run and drop any field that
 * saw an arrival; then re-read the own StatSim page of the fields checked longest ago
 * (FIRST_VERIFY_PER_RUN, default 1000, so every field is re-checked about once a week).
 * The country list misses fields StatSim does not file under the US, which is what the
 * per-field pass is for.
 *
 * --full: rebuild from nothing. Every week of the US flight list since January 2020 (about
 * 350 pages), then each candidate's own page. Takes a couple of hours.
 *
 * Usage:
 *   node scripts/build-first-landing.mjs           # daily update
 *   node scripts/build-first-landing.mjs --full    # rebuild
 *
 * Env:
 *   FIRST_VERIFY_PER_RUN   fields re-checked on their own page per daily run (default 1000)
 *   FIRST_CONCURRENCY      parallel StatSim requests (default 3)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLS, C, US_COUNTRIES, FIELD_TYPES, STATSIM_START_MS, fmtStatsim, weekWindows, parseFlightsPage,
  fieldCodes, applyFlights, nearestDistances, isPaved, parseCsv, stateOf,
} from "./lib/first-landing-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "first-landing", "fields.json");
const STATSIM = "https://statsim.net";
const OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/";
const UA = "VATFLOW-first-landing/1.0 (+https://vatflow.io)";
const VERIFY_PER_RUN = Math.max(0, parseInt(process.env.FIRST_VERIFY_PER_RUN || "1000", 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.FIRST_CONCURRENCY || "3", 10));
const FULL = process.argv.includes("--full");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

async function getText(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { last = e; await sleep(3000 * (i + 1)); }
  }
  throw new Error(url + ": " + (last && last.message));
}

async function mapPool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  }));
}

const countryUrl = (fromMs, toMs) =>
  `${STATSIM}/flights/countries/country/US/custom/${encodeURIComponent(fmtStatsim(fromMs))}/${encodeURIComponent(fmtStatsim(toMs))}`;
const airportUrl = (code, toMs) =>
  `${STATSIM}/flights/airport/${encodeURIComponent(code)}/custom/${encodeURIComponent(fmtStatsim(STATSIM_START_MS))}/${encodeURIComponent(fmtStatsim(toMs))}`;

/** One country-list window, checked against its own heading counts. */
async function countryWindow(fromMs, toMs) {
  const page = parseFlightsPage(await getText(countryUrl(fromMs, toMs)));
  if (page.dep.length !== page.counts.dep || page.arr.length !== page.counts.arr) {
    throw new Error(`${fmtStatsim(fromMs)}: parsed ${page.dep.length}/${page.arr.length} of ${page.counts.dep}/${page.counts.arr} flights`);
  }
  return page;
}

/** A field's own StatSim page since 2020, over all its codes: { dep, arr, first } */
async function fieldHistory(codes, toMs) {
  const out = { dep: 0, arr: 0, first: null };
  for (const code of codes) {
    const page = parseFlightsPage(await getText(airportUrl(code, toMs)));
    out.dep += page.counts.dep;
    out.arr += page.counts.arr;
    for (const f of page.arr) if (!out.first || f.time < out.first.time) out.first = { callsign: f.callsign, time: f.time };
  }
  return out;
}

/* ---------- daily ---------- */

async function daily() {
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  let rows = doc.fields;
  const landedPts = doc.landed || [];
  const nowMs = Date.now();
  const start = rows.length;
  const dropped = [];
  const drop = (landed) => {
    for (const r of doc.fields) if (landed.has(r[C.ident]) && !dropped.some((d) => d.ident === r[C.ident])) {
      const l = landed.get(r[C.ident]);
      dropped.push({ ident: r[C.ident], callsign: l.callsign, time: l.time });
      landedPts.push([Math.round(r[C.lat] * 100) / 100, Math.round(r[C.lon] * 100) / 100]);
    }
  };

  // 1. StatSim's US list since the last run (an hour of overlap; flight ids stop double counts).
  const fromMs = Math.max(STATSIM_START_MS, (Date.parse(doc.crawledTo + "Z") || nowMs - 86400000) - 3600000);
  const seen = new Set();
  for (const [a, b] of weekWindows(fromMs, nowMs)) {
    const page = await countryWindow(a, b);
    const res = applyFlights(rows, page, seen);
    drop(res.landed);
    rows = res.rows;
    console.log(`country ${fmtStatsim(a)} .. ${fmtStatsim(b)}: ${page.dep.length} dep, ${page.arr.length} arr, ${res.landed.size} fields landed`);
  }

  // 2. Each field's own page, oldest check first.
  const queue = rows.slice().sort((x, y) => String(x[C.checked]).localeCompare(String(y[C.checked]))).slice(0, VERIFY_PER_RUN);
  const landed = new Map();
  let done = 0;
  await mapPool(queue, CONCURRENCY, async (r) => {
    const h = await fieldHistory(fieldCodes(r[C.ident], r[C.local]), nowMs);
    r[C.checked] = today();
    if (h.arr > 0) landed.set(r[C.ident], h.first || { callsign: "", time: null });
    else if (h.dep > (r[C.deps] || 0)) { r[C.deps] = h.dep; r[C.status] = 1; }
    if (++done % 100 === 0) console.log(`  fields ${done}/${queue.length}`);
  });
  drop(landed);
  rows = rows.filter((r) => !landed.has(r[C.ident]));
  console.log(`field pages: ${queue.length} checked, ${landed.size} landed`);

  for (const d of dropped) console.log(`  landed: ${d.ident}${d.callsign ? " by " + d.callsign : ""}${d.time ? " " + fmtStatsim(d.time) : ""}`);
  write({ ...doc, asOf: today(), crawledTo: fmtStatsim(nowMs), fields: rows, landed: landedPts });
  console.log(`fields: ${start} -> ${rows.length}`);
}

/* ---------- full rebuild ---------- */

async function full() {
  const nowMs = Date.now();
  console.log("OurAirports");
  const allFields = parseCsv(await getText(OURAIRPORTS + "airports.csv"))
    .filter((a) => US_COUNTRIES.includes(a.iso_country) && FIELD_TYPES[a.type]);
  // Fields OurAirports only has a placeholder id for (US-1234) cannot be filed to, so they
  // are not in the challenge; they still count as the airport next door.
  const airports = allFields.filter((a) => !a.ident.includes("-"));
  const runways = parseCsv(await getText(OURAIRPORTS + "runways.csv"));
  const rwy = new Map();
  for (const r of runways) {
    if (r.closed === "1") continue;
    const cur = rwy.get(r.airport_ident) || { len: 0, paved: 0, lit: 0 };
    cur.len = Math.max(cur.len, parseInt(r.length_ft, 10) || 0);
    if (isPaved(r.surface)) cur.paved = 1;
    if (r.lighted === "1") cur.lit = 1;
    rwy.set(r.airport_ident, cur);
  }
  const codeOf = new Map();         // code -> airport ident
  for (const a of airports) for (const c of fieldCodes(a.ident, a.local_code, a.icao_code, a.gps_code)) if (!codeOf.has(c)) codeOf.set(c, a.ident);

  // Arrivals per airport from every week of the US list.
  const arr = new Map();
  const bump = (code) => { const id = codeOf.get(code); if (id) arr.set(id, (arr.get(id) || 0) + 1); };
  const windows = weekWindows(Date.UTC(2020, 0, 6), nowMs);
  let n = 0;
  await mapPool(windows, 2, async ([a, b]) => {
    const page = await countryWindow(a, b);
    for (const f of page.arr) bump(f.dest);
    if (++n % 20 === 0) console.log(`  weeks ${n}/${windows.length}`);
  });

  // Anything with no arrival in the US list gets its own page read.
  const cands = airports.filter((a) => !arr.get(a.ident));
  console.log(`candidates: ${cands.length} of ${airports.length}`);
  const hist = new Map();
  n = 0;
  await mapPool(cands, CONCURRENCY, async (a) => {
    hist.set(a.ident, await fieldHistory(fieldCodes(a.ident, a.local_code, a.icao_code, a.gps_code), nowMs));
    if (++n % 200 === 0) console.log(`  fields ${n}/${cands.length}`);
  });

  const untouched = cands.filter((a) => hist.get(a.ident).arr === 0);
  const untouchedIds = new Set(untouched.map((a) => a.ident));
  const pts = allFields.map((a) => [+a.latitude_deg, +a.longitude_deg, a.ident]);
  const guards = nearestDistances(untouched.map((a) => [+a.latitude_deg, +a.longitude_deg, a.ident]), pts);
  const rows = untouched.map((a, i) => {
    const r = rwy.get(a.ident) || { len: 0, paved: 0, lit: 0 };
    const deps = hist.get(a.ident).dep;
    return [a.ident, a.name, a.municipality || "", stateOf(a.iso_region, a.iso_country), FIELD_TYPES[a.type],
      Math.round(+a.latitude_deg * 1e4) / 1e4, Math.round(+a.longitude_deg * 1e4) / 1e4,
      a.elevation_ft === "" ? null : Math.round(+a.elevation_ft), r.len, r.paved, r.lit,
      deps ? 1 : 0, deps, a.local_code || "", a.iata_code || "", guards[i], today()];
  });
  const landed = airports.filter((a) => !untouchedIds.has(a.ident))
    .map((a) => [Math.round(+a.latitude_deg * 100) / 100, Math.round(+a.longitude_deg * 100) / 100]);
  write({ asOf: today(), crawledTo: fmtStatsim(nowMs), fields: rows, landed });
  console.log(`fields: ${rows.length} untouched (${rows.filter((r) => r[C.status] === 0).length} with no traffic at all)`);
}

function write(doc) {
  doc.fields.sort((a, b) => a[C.ident].localeCompare(b[C.ident]));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const body = JSON.stringify({ asOf: doc.asOf, crawledTo: doc.crawledTo, cols: COLS, fields: doc.fields, landed: doc.landed })
    .replace(/\],\[/g, "],\n[");     // a row a line, so the daily diff is readable
  fs.writeFileSync(OUT, body + "\n");
  console.log("wrote", OUT);
}

(FULL ? full() : daily()).then(() => console.log("done"), (e) => { console.error(e); process.exit(1); });
