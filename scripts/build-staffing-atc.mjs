#!/usr/bin/env node
/**
 * Precompute StatSim ATC combined-time hours into JSON (+ optional Supabase).
 *
 * Usage:
 *   node scripts/build-staffing-atc.mjs
 *   node scripts/build-staffing-atc.mjs thisyear
 *
 * Env:
 *   SUPABASE_URL                 (default: VATFLOW project)
 *   SUPABASE_SERVICE_ROLE_KEY    upsert into staffing_atc
 *   STAFFING_ATC_SKIP_DB=1       write JSON only
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atcElapsedHours } from "../shared/staffing-atc-hours.js";
import { PERIODS, fetchAtcPeriod } from "./lib/staffing-atc-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "staffing-atc");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://qoaipsfcidpymboojfwa.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SKIP_DB = process.env.STAFFING_ATC_SKIP_DB === "1";

function parseArgs(argv) {
  const wanted = argv.filter(a => PERIODS.includes(a));
  return wanted.length ? wanted : PERIODS.slice();
}

async function upsertSupabase(row) {
  if (SKIP_DB) {
    console.log("skip db upsert (STAFFING_ATC_SKIP_DB=1)");
    return;
  }
  if (!SERVICE_KEY) {
    console.warn("SUPABASE_SERVICE_ROLE_KEY not set — wrote local JSON only");
    return;
  }
  const url = SUPABASE_URL + "/rest/v1/staffing_atc?on_conflict=period";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error("Supabase upsert failed HTTP " + r.status + ": " + body.slice(0, 300));
  }
  console.log("upserted", row.period, "to Supabase staffing_atc");
}

async function buildPeriod(period) {
  console.log("===", period);
  const nowMs = Date.now();
  const { positions, range, chunks, failedChunks } = await fetchAtcPeriod(period, (i, n, label) => {
    console.log("  chunk", i + "/" + n, label);
  }, nowMs);
  const computedAt = new Date().toISOString();
  const totalSeconds = positions.reduce((s, p) => s + (p.seconds || 0), 0);
  const payload = {
    period,
    computed_at: computedAt,
    source_label: "statsim:html" + (chunks > 1 ? ("/" + chunks + "chunks") : "") +
      (failedChunks ? (" fail" + failedChunks) : ""),
    position_groups: positions.length,
    total_seconds: Math.round(totalSeconds),
    range,
    positions
  };
  const outPath = path.join(OUT_DIR, period + ".json");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.log("wrote", outPath, "groups", positions.length, "hours", (totalSeconds / 3600).toFixed(1),
    "elapsed", atcElapsedHours(range, nowMs).toFixed(1));

  await upsertSupabase({
    period,
    computed_at: computedAt,
    source_label: payload.source_label,
    position_groups: payload.position_groups,
    total_seconds: payload.total_seconds,
    range,
    data: { positions, range }
  });
  return payload;
}

async function main() {
  const periods = parseArgs(process.argv.slice(2));
  const index = {
    updated_at: new Date().toISOString(),
    periods: []
  };
  for (const period of periods) {
    const row = await buildPeriod(period);
    index.periods.push({
      period,
      computed_at: row.computed_at,
      source_label: row.source_label,
      position_groups: row.position_groups,
      total_seconds: row.total_seconds
    });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log("done", periods.join(", "));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
