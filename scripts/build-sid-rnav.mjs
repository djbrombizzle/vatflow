#!/usr/bin/env node
/**
 * Build the list of RNAV SIDs per airport for the Taxi Sequencer.
 *
 * FAA JO 7110.65 5-8-3b lets successive departures off the same runway go
 * 1 mile apart when courses diverge by 10 degrees or more, instead of 15, but
 * only when both aircraft are flying an RNAV SID. procedures.json does not keep
 * the ARINC 424 route type, so this reads it straight from the same-cycle CIFP:
 * a SID is RNAV when any of its legs has route type 4, 5 or 6 (RNAV runway
 * transition / common route / enroute transition) or F, M or S (FMS).
 *
 * Output data/nav/sid-rnav.json: ICAO -> [SID, ...] (revision-numbered names, as
 * filed). Only SIDs already in procedures.json are kept.
 *
 * Usage: node scripts/build-sid-rnav.mjs                  (cycle from data/nav/meta.json)
 *        node scripts/build-sid-rnav.mjs --cifp /path/to/FAACIFP18
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCifpLines } from "./lib/cifp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAV = join(ROOT, "data", "nav");
const OUT = join(NAV, "sid-rnav.json");
const RNAV_ROUTE_TYPES = new Set(["4", "5", "6", "F", "M", "S"]);

const col = (line, from, to) => line.slice(from - 1, to).trim();

async function cifpLines() {
  const i = process.argv.indexOf("--cifp");
  if (i > 0 && process.argv[i + 1]) return readCifpLines(process.argv[i + 1]);
  const meta = JSON.parse(readFileSync(join(NAV, "meta.json"), "utf8"));
  const [y, m, d] = String(meta.cifpCycleDate || "").split("-");
  if (!d) throw new Error("meta.json has no cifpCycleDate; pass --cifp");
  const url = `https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_${y.slice(2)}${m}${d}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), "vatflow-cifp-"));
  try {
    const zipPath = join(dir, "cifp.zip");
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    execFileSync("unzip", ["-o", zipPath, "FAACIFP18", "-d", dir], { stdio: "pipe" });
    console.log(`  CIFP: ${url}`);
    return readCifpLines(join(dir, "FAACIFP18"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const procedures = JSON.parse(readFileSync(join(NAV, "procedures.json"), "utf8"));
const lines = await cifpLines();
const rnav = new Map();   // apt -> Set(SID)
let legs = 0;
for (const l of lines) {
  if (!l.startsWith("SUSA") || l[4] !== "P" || l[12] !== "D") continue;
  legs++;
  if (!RNAV_ROUTE_TYPES.has(l[19])) continue;
  const apt = col(l, 7, 10);
  const proc = col(l, 14, 19).replace(/[^A-Z0-9]/g, "");
  const known = procedures[proc];
  if (!known || known.type !== "SID" || !(known.apt || []).includes(apt)) continue;
  if (!rnav.has(apt)) rnav.set(apt, new Set());
  rnav.get(apt).add(proc);
}

const out = {};
for (const apt of [...rnav.keys()].sort()) out[apt] = [...rnav.get(apt)].sort();
writeFileSync(OUT, JSON.stringify(out) + "\n");
const count = Object.values(out).reduce((s, a) => s + a.length, 0);
console.log(`sid-rnav.json: ${count} RNAV SIDs at ${Object.keys(out).length} airports (${legs} SID legs read)`);
