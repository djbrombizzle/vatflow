#!/usr/bin/env node
/**
 * Record the VATSIM pilot feed to NDJSON for offline climb analysis.
 *
 * Usage:
 *   node scripts/record-vatsim-feed.mjs --out feed.ndjson --minutes 90
 *
 * Climbs to cruise take roughly 20 minutes, so a useful recording is at least
 * 45 minutes and preferably a few hours. One line per poll, holding only the
 * fields the analysis needs -- a raw dump of the whole feed is ~40x larger.
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const OUT = args.get("out") || "feed.ndjson";
const MINUTES = parseFloat(args.get("minutes") || "90");
const POLL_MS = Math.max(15000, parseInt(args.get("poll") || "15000", 10));
const URL = "https://data.vatsim.net/v3/vatsim-data.json";

import { createWriteStream } from "node:fs";
import { pilotAircraftType } from "../shared/climb-profile.js";

const out = createWriteStream(OUT, { flags: "a" });
const endAt = Date.now() + MINUTES * 60000;
let polls = 0, written = 0, lastStamp = null;

function log(...a) { console.log(new Date().toISOString(), ...a); }

/**
 * Only airborne pilots with a flight plan matter, and only their moving parts.
 * Ground traffic and controllers are dropped at the source.
 */
function slim(p) {
  if (!p || !p.flight_plan) return null;
  if (typeof p.latitude !== "number" || typeof p.longitude !== "number") return null;
  const gs = p.groundspeed || 0;
  if (gs < 50) return null;
  return {
    cs: p.callsign,
    cid: p.cid,
    lt: p.logon_time,
    la: p.latitude,
    lo: p.longitude,
    al: p.altitude || 0,
    gs,
    hd: p.heading || 0,
    ty: pilotAircraftType(p),
    tyr: (p.flight_plan.aircraft_short || p.flight_plan.aircraft_faa || ""),
    dep: p.flight_plan.departure || "",
    arr: p.flight_plan.arrival || "",
    fa: p.flight_plan.altitude || "",
    ts: p.last_updated || null,
  };
}

async function poll() {
  const r = await fetch(URL, { headers: { "User-Agent": "vatflow-climb-study" } });
  if (!r.ok) throw new Error("feed " + r.status);
  const data = await r.json();
  // The file only refreshes every ~15 s; re-recording an unchanged snapshot
  // would fabricate zero-time steps the analyser then has to discard.
  if (data.general && data.general.update_timestamp === lastStamp) return 0;
  lastStamp = data.general && data.general.update_timestamp;
  const t = Date.parse((data.general && data.general.update) || "") || Date.now();
  let n = 0;
  for (const p of data.pilots || []) {
    const s = slim(p);
    if (!s) continue;
    s.t = t;
    out.write(JSON.stringify(s) + "\n");
    n++;
  }
  return n;
}

log(`recording to ${OUT} for ${MINUTES} min, every ${POLL_MS / 1000}s`);
while (Date.now() < endAt) {
  const started = Date.now();
  try {
    const n = await poll();
    polls++; written += n;
    if (polls % 10 === 0) log(`${polls} polls, ${written} rows`);
  } catch (e) {
    log("poll failed:", e.message);
  }
  const wait = POLL_MS - (Date.now() - started);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
out.end();
log(`done — ${polls} polls, ${written} rows -> ${OUT}`);
