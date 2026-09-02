#!/usr/bin/env node
/**
 * Precompute StatSim ATC calendar-year hours (2020–present) for the trend tab.
 *
 * Usage:
 *   node scripts/build-staffing-atc-trends.mjs
 *   node scripts/build-staffing-atc-trends.mjs 2023 2024 2025
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  compactAtcPositions,
  ATC_TREND_FIRST_YEAR,
  atcTrendYears
} from "../shared/staffing-atc-hours.js";
import { fetchAtcCalendarYear } from "./lib/staffing-atc-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "staffing-atc", "trends.json");

function parseArgs(argv) {
  const nums = argv.map(a => +a).filter(y => y >= 2000 && y <= 2100);
  return nums.length ? nums : atcTrendYears(ATC_TREND_FIRST_YEAR);
}

async function main() {
  const years = parseArgs(process.argv.slice(2));
  const positionsByYear = {};
  const networkSecondsByYear = {};
  const computedAt = new Date().toISOString();

  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    console.log("===", year, "(" + (i + 1) + "/" + years.length + ")");
    const { positions, totalSeconds, url } = await fetchAtcCalendarYear(year, () => {});
    positionsByYear[String(year)] = compactAtcPositions(positions);
    networkSecondsByYear[String(year)] = totalSeconds;
    console.log("  groups", positions.length, "hours", (totalSeconds / 3600).toFixed(1), url);
    if (i < years.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  const payload = {
    computed_at: computedAt,
    first_year: years[0],
    last_year: years[years.length - 1],
    years,
    network_seconds_by_year: networkSecondsByYear,
    positions_by_year: positionsByYear,
    source_label: "statsim:calendar-year/" + years.length + "y"
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  console.log("wrote", OUT_PATH);
  console.log("done");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
