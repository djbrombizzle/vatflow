#!/usr/bin/env node
/**
 * Precompute ATC Staffing Historical Data (StatSim USA) into Supabase + local JSON.
 *
 * Usage:
 *   node scripts/build-staffing-hist.mjs              # all periods
 *   node scripts/build-staffing-hist.mjs thisweek
 *   node scripts/build-staffing-hist.mjs thisweek thismonth
 *
 * Env:
 *   STATSIM_API_KEY              required in CI (https://statsim.net/api-keys)
 *   SUPABASE_URL                 (default: VATFLOW project)
 *   SUPABASE_SERVICE_ROLE_KEY    required to upsert into staffing_hist
 *   STAFFING_HIST_SKIP_DB=1      write JSON only
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  PERIODS,
  fetchPeriodFlights,
  aggregateStatsimHistorical,
  destroyStatsimAgent
} from "./lib/staffing-hist-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "staffing-hist");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://qoaipsfcidpymboojfwa.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SKIP_DB = process.env.STAFFING_HIST_SKIP_DB === "1";

function parseArgs(argv) {
  const wanted = argv.filter(a => PERIODS.includes(a));
  return wanted.length ? wanted : PERIODS.slice();
}

async function upsertSupabase(row) {
  if (SKIP_DB) {
    console.log("skip db upsert (STAFFING_HIST_SKIP_DB=1)");
    return;
  }
  if (!SERVICE_KEY) {
    console.warn("SUPABASE_SERVICE_ROLE_KEY not set — wrote local JSON only");
    return;
  }
  const url = SUPABASE_URL + "/rest/v1/staffing_hist?on_conflict=period";
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
  console.log("upserted", row.period, "to Supabase");
}

async function buildPeriod(period) {
  console.log("===", period);
  const { flights, chunks, failedChunks, source } = await fetchPeriodFlights(period, (i, n, label) => {
    console.log("  chunk", i + "/" + n, label);
  });
  const agg = aggregateStatsimHistorical(flights);
  const computedAt = new Date().toISOString();
  const src = source || "statsim";
  const payload = {
    period,
    computed_at: computedAt,
    source_label: src + ":" + period + (chunks > 1 ? ("/" + chunks + "chunks") : ""),
    flight_rows: agg.flightRows,
    us_events: agg.usEvents,
    data: {
      ...agg,
      approaches: agg.approaches || [],
      meta: { chunks, failedChunks, computedAt, source: src }
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, period + ".json");
  /* Compact JSON — year payloads are large once all facilities are retained. */
  fs.writeFileSync(outFile, JSON.stringify(payload));
  console.log("wrote", outFile, "flights", agg.flightRows, "us", agg.usEvents, "towers", agg.towers.length);

  await upsertSupabase({
    period: payload.period,
    computed_at: payload.computed_at,
    source_label: payload.source_label,
    flight_rows: payload.flight_rows,
    us_events: payload.us_events,
    data: payload.data
  });
  return payload;
}

let buildFinished = false;

process.on("beforeExit", () => {
  if (buildFinished) return;
  console.error(
    "Build aborted before completion — event loop drained while work was still pending " +
    "(likely an unsettled StatSim HTTP promise). Failing the job."
  );
  process.exitCode = 1;
});

async function main() {
  const periods = parseArgs(process.argv.slice(2));
  console.log("Building staffing hist for:", periods.join(", "));
  const results = [];
  for (const p of periods) {
    results.push(await buildPeriod(p));
  }
  /* Merge with any existing period files so partial runs keep prior periods. */
  const byPeriod = new Map();
  for (const id of PERIODS) {
    const fp = path.join(OUT_DIR, id + ".json");
    if (!fs.existsSync(fp)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(fp, "utf8"));
      byPeriod.set(id, {
        period: existing.period || id,
        computed_at: existing.computed_at || null,
        flight_rows: existing.flight_rows || 0,
        us_events: existing.us_events || 0,
        towers: ((existing.data && existing.data.towers) || []).length
      });
    } catch (_) {}
  }
  for (const r of results) {
    byPeriod.set(r.period, {
      period: r.period,
      computed_at: r.computed_at,
      flight_rows: r.flight_rows,
      us_events: r.us_events,
      towers: (r.data.towers || []).length
    });
  }
  const index = {
    updated_at: new Date().toISOString(),
    periods: PERIODS.map(id => byPeriod.get(id)).filter(Boolean)
  };
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));

  const marker = (process.env.STAFFING_HIST_DONE_MARKER || "").trim();
  if (marker) {
    fs.writeFileSync(marker, new Date().toISOString() + "\n");
  }
  console.log("done");
  buildFinished = true;
  try { destroyStatsimAgent(); } catch (_) {}
}


main().catch(err => {
  console.error(err);
  process.exit(1);
});
