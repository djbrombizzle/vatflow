#!/usr/bin/env node
/**
 * Turn a recorded feed into per-type IAS-vs-altitude climb curves.
 *
 * Usage:
 *   node scripts/analyze-climb-profiles.mjs --in feed.ndjson [--min-flights 5]
 *
 * Reports, in order: how the pilot-entered type strings actually look, how
 * many climbs survived the quality gates and what rejected the rest, and then
 * the IAS curve per aircraft type with n and IQR against every point.
 *
 * Winds: none by default. Ground speed is then read as true airspeed, which
 * biases IAS by roughly 0.7 kt per kt of real wind -- fine for checking the
 * shape and the type mix, useless as a measurement. Pass --winds <file.json>
 * (a map of "lat,lon,FL" -> {dirDeg, spdKt}) once a wind source is wired up.
 */
import { readFileSync } from "node:fs";
import {
  ALT_BANDS,
  aggregateCurve,
  buildSample,
  crossoverBand,
  normalizeAircraftType,
  reduceFlight,
} from "../shared/climb-profile.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const IN = args.get("in") || "feed.ndjson";
const MIN_FLIGHTS = parseInt(args.get("min-flights") || "5", 10);
const WINDS = args.get("winds") ? JSON.parse(readFileSync(args.get("winds"), "utf8")) : null;

function windAt(lat, lon, altFt) {
  if (!WINDS) return null;
  const key = `${Math.round(lat)},${Math.round(lon)},${Math.round(altFt / 1000)}`;
  return WINDS[key] || null;
}

/* ---- load and group into per-flight position tracks ---- */
const lines = readFileSync(IN, "utf8").split("\n").filter(Boolean);
const tracks = new Map();
const rawTypeCounts = new Map();

for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const key = `${r.cs}|${r.cid}|${r.lt}`;
  if (!tracks.has(key)) {
    tracks.set(key, { cs: r.cs, cid: r.cid, ty: r.ty, tyr: r.tyr, dep: r.dep, arr: r.arr, pts: [] });
  }
  tracks.get(key).pts.push({ t: r.t, lat: r.la, lon: r.lo, alt: r.al, gs: r.gs, hdg: r.hd });
  const raw = (r.tyr || "").trim();
  rawTypeCounts.set(raw, (rawTypeCounts.get(raw) || 0) + 1);
}

/* ---- type string hygiene ---- */
const seenRaw = [...rawTypeCounts.entries()].sort((a, b) => b[1] - a[1]);
let normOk = 0, normFail = 0;
const failExamples = [];
for (const [raw, n] of seenRaw) {
  if (normalizeAircraftType(raw)) normOk += n;
  else { normFail += n; if (failExamples.length < 12 && raw) failExamples.push(`${raw} (${n})`); }
}

console.log(`\n=== FEED ===`);
console.log(`${lines.length} rows, ${tracks.size} distinct flights`);
console.log(`\n=== AIRCRAFT TYPE STRINGS ===`);
console.log(`distinct raw strings: ${seenRaw.length}`);
console.log(`normalized ok: ${normOk} rows (${(100 * normOk / (normOk + normFail)).toFixed(1)}%)`);
console.log(`unparseable:   ${normFail} rows`);
if (failExamples.length) console.log(`  examples: ${failExamples.join(", ")}`);
console.log(`\ntop 15 raw strings:`);
for (const [raw, n] of seenRaw.slice(0, 15)) {
  const norm = normalizeAircraftType(raw);
  console.log(`  ${String(raw || "(blank)").padEnd(14)} ${String(n).padStart(6)}  -> ${norm || "REJECTED"}`);
}

/* ---- run the pipeline ---- */
const rejects = new Map();
const flightsByType = new Map();
let analysed = 0, tooFew = 0;

for (const tr of tracks.values()) {
  tr.pts.sort((a, b) => a.t - b.t);
  const samples = [];
  for (let i = 1; i < tr.pts.length; i++) {
    const mid = (tr.pts[i - 1].alt + tr.pts[i].alt) / 2;
    const w = windAt(tr.pts[i].lat, tr.pts[i].lon, mid);
    const s = buildSample(tr.pts[i - 1], tr.pts[i], w);
    if (!s.ok) rejects.set(s.reason, (rejects.get(s.reason) || 0) + 1);
    samples.push(s);
  }
  const accepted = samples.filter(s => s.ok);
  // A climb seen for under ~5 minutes cannot describe a profile; most of these
  // are flights already at cruise when the recording started.
  if (accepted.length < 20) { tooFew++; continue; }
  const flight = reduceFlight(samples, { callsign: tr.cs, type: tr.ty || "UNKNOWN", dep: tr.dep });
  flight.crossover = crossoverBand(flight);
  const t = flight.type;
  if (!flightsByType.has(t)) flightsByType.set(t, []);
  flightsByType.get(t).push(flight);
  analysed++;
}

console.log(`\n=== SAMPLE GATES ===`);
console.log(`climbs analysed: ${analysed}`);
console.log(`discarded (under 20 usable samples): ${tooFew}`);
for (const [reason, n] of [...rejects.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  rejected ${String(reason).padEnd(14)} ${n}`);
}

/* ---- curves ---- */
const ranked = [...flightsByType.entries()]
  .filter(([, f]) => f.length >= MIN_FLIGHTS)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`\n=== IAS CURVES BY TYPE (n >= ${MIN_FLIGHTS}) ===`);
if (!WINDS) console.log(`!! no wind data — IAS values are biased, shape only\n`);
const header = "type      n   " + ALT_BANDS.map(b => b.label.padStart(11)).join("");
console.log(header);
console.log("-".repeat(header.length));
for (const [type, flights] of ranked) {
  const c = aggregateCurve(flights);
  const cells = ALT_BANDS.map(b => {
    const v = c.bands[b.key];
    return (v ? `${v.iasMedian.toFixed(0)}` : "-").padStart(11);
  }).join("");
  console.log(`${type.padEnd(9)}${String(flights.length).padStart(4)}  ${cells}`);
  const iqr = ALT_BANDS.map(b => {
    const v = c.bands[b.key];
    return (v ? `${v.iasP25.toFixed(0)}-${v.iasP75.toFixed(0)}` : "").padStart(11);
  }).join("");
  console.log(`${" ".repeat(13)}${iqr}   IQR`);
}

const thin = [...flightsByType.entries()].filter(([, f]) => f.length < MIN_FLIGHTS);
console.log(`\n${ranked.length} types with n >= ${MIN_FLIGHTS}; ${thin.length} thinner types held back`);
console.log(`(the thin tail is expected — it is what the class-level fallback is for)`);
