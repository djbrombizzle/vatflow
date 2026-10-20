#!/usr/bin/env node
/**
 * Build data/first-landing/fields.json for First to Land: open US fields (the FAA's airport
 * data, NASR: airports and seaplane bases, US and territories) where StatSim has never logged
 * a VATSIM arrival since its records begin (January 2020). vatflow-hub watches the live feed
 * for the first landing at each of them (first-landing.js there).
 *
 * Daily (default):
 *   1. Re-read the FAA's current 28-day cycle: drop fields that are closed, no longer an
 *      airport or seaplane base, or whose identifier is gone; refresh ICAO code and public /
 *      private use. Re-read the X-Plane Scenery Gateway for which fields X-Plane ships.
 *   2. Read StatSim's US flight list since the last run and drop any field that saw an arrival.
 *   3. Re-read the own StatSim page of the fields checked longest ago (FIRST_VERIFY_PER_RUN,
 *      default 1000, so every field is re-checked about once a week). The country list misses
 *      fields StatSim does not file under the US, which is what this pass is for.
 *
 * --full: rebuild from nothing. Every open FAA field, every week of the US flight list since
 * January 2020 (about 350 pages), then each candidate's own page. A couple of hours.
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
  COLS, C, STATSIM_START_MS, fmtStatsim, weekWindows, parseFlightsPage, fieldCodes, applyFlights,
  nearestDistances, parseCsv, faaCycle, faaAptCsvUrl, unzipEntry, faaFields, faaCodes, xplaneCodes,
} from "./lib/first-landing-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "first-landing", "fields.json");
const STATSIM = "https://statsim.net";
const XPLANE_GATEWAY = "https://gateway.x-plane.com/apiv1/airports";
const UA = "VATFLOW-first-landing/1.0 (+https://vatflow.io)";
const VERIFY_PER_RUN = Math.max(0, parseInt(process.env.FIRST_VERIFY_PER_RUN || "1000", 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.FIRST_CONCURRENCY || "3", 10));
const FULL = process.argv.includes("--full");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await sleep(3000 * (i + 1)); }
  }
  throw new Error(url + ": " + (last && last.message));
}
const getText = async (url) => (await get(url)).toString("utf8");

async function mapPool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  }));
}

/** The FAA's fields for the cycle in force (the previous cycle if the new one isn't up yet). */
async function loadFaa(nowMs) {
  let cycle = faaCycle(nowMs), zip;
  try { zip = await get(faaAptCsvUrl(cycle), 2); }
  catch (e) { cycle -= 28 * 86400000; zip = await get(faaAptCsvUrl(cycle)); }
  const base = parseCsv(unzipEntry(zip, "APT_BASE.csv").toString("latin1"));
  const rwy = parseCsv(unzipEntry(zip, "APT_RWY.csv").toString("latin1"));
  const fields = faaFields(base, rwy);
  console.log(`FAA cycle ${new Date(cycle).toISOString().slice(0, 10)}: ${fields.size} facilities, ${[...fields.values()].filter((f) => f.open).length} open airports and seaplane bases`);
  return { cycle: new Date(cycle).toISOString().slice(0, 10), fields };
}

async function loadXplane() {
  const codes = xplaneCodes(JSON.parse(await getText(XPLANE_GATEWAY)));
  console.log(`X-Plane Scenery Gateway: ${codes.size} airports with scenery`);
  return codes;
}
const inXplane = (xp, f) => (faaCodes(f).some((c) => xp.has(c)) ? 1 : 0);

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

const rnd = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
/** fields.json row for an FAA field. */
function rowFor(f, deps, guard, xp) {
  return [f.icao || f.id, f.name, f.city, f.state, f.type, rnd(f.lat, 4), rnd(f.lon, 4), f.elev, f.rwy.len, f.rwy.paved, f.rwy.lit,
    deps ? 1 : 0, deps, f.id, "", guard, today(), f.use, xp];
}

/* ---------- daily ---------- */

async function daily() {
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const landedPts = doc.landed || [];
  const nowMs = Date.now();
  const start = doc.fields.length;
  const toLanded = (r) => landedPts.push([rnd(r[C.lat], 2), rnd(r[C.lon], 2)]);

  // 1. FAA status and X-Plane.
  const faa = await loadFaa(nowMs);
  const xp = await loadXplane();
  let rows = [];
  for (const r of doc.fields) {
    const f = faa.fields.get(r[C.local]);
    if (!f || !f.open) {
      console.log(`  dropped ${r[C.ident]} ${r[C.name]}: ${!f ? "no longer in the FAA's data" : "FAA status " + f.status + ", type " + f.siteType}`);
      continue;
    }
    r[C.ident] = f.icao || f.id;
    r[C.use] = f.use;
    r[C.xplane] = inXplane(xp, f);
    rows.push(r);
  }

  // 2. StatSim's US list since the last run (an hour of overlap; flight ids stop double counts).
  const fromMs = Math.max(STATSIM_START_MS, (Date.parse(doc.crawledTo + "Z") || nowMs - 86400000) - 3600000);
  const seen = new Set();
  for (const [a, b] of weekWindows(fromMs, nowMs)) {
    const page = await countryWindow(a, b);
    const res = applyFlights(rows, page, seen);
    for (const r of rows) if (res.landed.has(r[C.ident])) { toLanded(r); console.log(`  landed: ${r[C.ident]} by ${res.landed.get(r[C.ident]).callsign}`); }
    rows = res.rows;
    console.log(`country ${fmtStatsim(a)} .. ${fmtStatsim(b)}: ${page.dep.length} dep, ${page.arr.length} arr, ${res.landed.size} fields landed`);
  }

  // 3. Each field's own page, oldest check first.
  const queue = rows.slice().sort((x, y) => String(x[C.checked]).localeCompare(String(y[C.checked]))).slice(0, VERIFY_PER_RUN);
  const landed = new Set();
  let done = 0;
  await mapPool(queue, CONCURRENCY, async (r) => {
    const h = await fieldHistory(fieldCodes(r[C.ident], r[C.local]), nowMs);
    r[C.checked] = today();
    if (h.arr > 0) { landed.add(r); toLanded(r); console.log(`  landed: ${r[C.ident]}${h.first ? " by " + h.first.callsign : ""}`); }
    else if (h.dep > (r[C.deps] || 0)) { r[C.deps] = h.dep; r[C.status] = 1; }
    if (++done % 100 === 0) console.log(`  fields ${done}/${queue.length}`);
  });
  rows = rows.filter((r) => !landed.has(r));
  console.log(`field pages: ${queue.length} checked, ${landed.size} landed`);

  write({ asOf: today(), crawledTo: fmtStatsim(nowMs), faaCycle: faa.cycle, fields: rows, landed: landedPts });
  console.log(`fields: ${start} -> ${rows.length}`);
}

/* ---------- full rebuild ---------- */

async function full() {
  const nowMs = Date.now();
  const faa = await loadFaa(nowMs);
  const xp = await loadXplane();
  const open = [...faa.fields.values()].filter((f) => f.open);
  const codeOf = new Map();         // filed code -> FAA id
  for (const f of open) for (const c of faaCodes(f)) if (!codeOf.has(c)) codeOf.set(c, f.id);

  // Arrivals per field from every week of the US list.
  const arr = new Map();
  const windows = weekWindows(Date.UTC(2020, 0, 6), nowMs);
  let n = 0;
  await mapPool(windows, 2, async ([a, b]) => {
    const page = await countryWindow(a, b);
    for (const fl of page.arr) { const id = codeOf.get(fl.dest); if (id) arr.set(id, (arr.get(id) || 0) + 1); }
    if (++n % 20 === 0) console.log(`  weeks ${n}/${windows.length}`);
  });

  // Anything with no arrival in the US list gets its own page read.
  const cands = open.filter((f) => !arr.get(f.id));
  console.log(`candidates: ${cands.length} of ${open.length}`);
  const hist = new Map();
  n = 0;
  await mapPool(cands, CONCURRENCY, async (f) => {
    hist.set(f.id, await fieldHistory(faaCodes(f), nowMs));
    if (++n % 200 === 0) console.log(`  fields ${n}/${cands.length}`);
  });

  const untouched = cands.filter((f) => hist.get(f.id).arr === 0);
  const ids = new Set(untouched.map((f) => f.id));
  // The airport next door: any operational landing facility but a heliport.
  const others = [...faa.fields.values()].filter((f) => f.status === "O" && "ACGUB".includes(f.siteType)).map((f) => [f.lat, f.lon, f.id]);
  const guards = nearestDistances(untouched.map((f) => [f.lat, f.lon, f.id]), others);
  const rows = untouched.map((f, i) => rowFor(f, hist.get(f.id).dep, guards[i], inXplane(xp, f)));
  const landed = open.filter((f) => !ids.has(f.id)).map((f) => [rnd(f.lat, 2), rnd(f.lon, 2)]);
  write({ asOf: today(), crawledTo: fmtStatsim(nowMs), faaCycle: faa.cycle, fields: rows, landed });
  console.log(`fields: ${rows.length} untouched (${rows.filter((r) => r[C.status] === 0).length} with no traffic at all)`);
}

function write(doc) {
  doc.fields.sort((a, b) => a[C.ident].localeCompare(b[C.ident]));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const body = JSON.stringify({ asOf: doc.asOf, crawledTo: doc.crawledTo, faaCycle: doc.faaCycle, cols: COLS, fields: doc.fields, landed: doc.landed })
    .replace(/\],\[/g, "],\n[");     // a row a line, so the daily diff is readable
  fs.writeFileSync(OUT, body + "\n");
  console.log("wrote", OUT);
}

(FULL ? full() : daily()).then(() => console.log("done"), (e) => { console.error(e); process.exit(1); });
