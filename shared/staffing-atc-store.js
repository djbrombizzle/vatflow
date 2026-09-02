/**
 * Client loader for precomputed StatSim ATC combined-time hours (Supabase + static JSON).
 */
import { STAFFING_ATC_PERIODS, atcElapsedHours } from "./staffing-atc-hours.js";

export const SUPABASE_URL = "https://qoaipsfcidpymboojfwa.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79";

function normalizeRow(row, period) {
  if (!row) return null;
  const data = row.data && typeof row.data === "object" ? row.data : row;
  const positions = data.positions || row.positions;
  if (!Array.isArray(positions) || !positions.length) return null;
  const range = data.range || row.range || null;
  const computedAt = row.computed_at || data.computed_at || null;
  const computedAtMs = computedAt ? Date.parse(computedAt) : Date.now();
  return {
    period: row.period || period,
    computedAt,
    sourceLabel: row.source_label || null,
    positionGroups: row.position_groups != null ? row.position_groups : positions.length,
    totalSeconds: row.total_seconds != null ? row.total_seconds : null,
    positions,
    range,
    elapsedHours: atcElapsedHours(range, computedAtMs)
  };
}

async function fetchFromSupabase(period) {
  const url = SUPABASE_URL + "/rest/v1/staffing_atc?period=eq." + encodeURIComponent(period) + "&select=*";
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      Accept: "application/json"
    }
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error("Supabase HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return normalizeRow(rows[0], period);
}

async function fetchFromStatic(period) {
  const r = await fetch("data/staffing-atc/" + period + ".json", { cache: "no-store" });
  if (!r.ok) throw new Error("Static ATC HTTP " + r.status);
  const json = await r.json();
  return normalizeRow(json, period);
}

/**
 * Load precomputed ATC hours for a period.
 * Prefers Supabase staffing_atc; falls back to data/staffing-atc/*.json.
 */
export async function loadStaffingAtc(period) {
  const p = STAFFING_ATC_PERIODS.includes(period) ? period : "thisweek";
  let lastErr = null;
  try {
    const fromDb = await fetchFromSupabase(p);
    if (fromDb) return { ...fromDb, source: "supabase" };
  } catch (e) {
    lastErr = e && e.message ? e.message : String(e);
  }
  try {
    const fromFile = await fetchFromStatic(p);
    if (fromFile) return { ...fromFile, source: "static" };
  } catch (e) {
    lastErr = (lastErr ? lastErr + "; " : "") + ((e && e.message) || String(e));
  }
  throw new Error(lastErr || "No precomputed ATC hours for " + p);
}

/** Multi-year calendar ATC hours (2020–2025) for the trend tab. */
export async function loadStaffingAtcTrends() {
  const r = await fetch("data/staffing-atc/trends.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Static ATC trends HTTP " + r.status);
  const json = await r.json();
  if (!json || !json.years || !json.positions_by_year) {
    throw new Error("Invalid ATC trends data");
  }
  return {
    computedAt: json.computed_at || null,
    sourceLabel: json.source_label || null,
    years: json.years,
    firstYear: json.first_year,
    lastYear: json.last_year,
    networkSecondsByYear: json.network_seconds_by_year || {},
    positionsByYear: json.positions_by_year,
    source: "static"
  };
}
