/**
 * Client loader for precomputed ATC Staffing Historical Data (Supabase + static JSON fallback).
 */
export const SUPABASE_URL = "https://qoaipsfcidpymboojfwa.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79";
export const STAFFING_HIST_PERIODS = ["thisweek", "thismonth", "thisyear"];

function normalizeRow(row, period) {
  if (!row) return null;
  const data = row.data && typeof row.data === "object" ? row.data : row;
  if (!data || !Array.isArray(data.towers)) return null;
  return {
    period: row.period || period,
    computedAt: row.computed_at || (data.meta && data.meta.computedAt) || null,
    sourceLabel: row.source_label || null,
    flightRows: row.flight_rows != null ? row.flight_rows : data.flightRows,
    usEvents: row.us_events != null ? row.us_events : data.usEvents,
    result: {
      flightRows: data.flightRows || 0,
      usEvents: data.usEvents || 0,
      byAirport: data.byAirport || {},
      topAirports: data.topAirports || [],
      towers: data.towers || [],
      approaches: data.approaches || [],
      centers: data.centers || [],
      meta: data.meta || null
    }
  };
}

async function fetchFromSupabase(period) {
  const url = SUPABASE_URL + "/rest/v1/staffing_hist?period=eq." + encodeURIComponent(period) + "&select=*";
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      Accept: "application/json"
    }
  });
  if (!r.ok) throw new Error("Supabase HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return normalizeRow(rows[0], period);
}

async function fetchFromStatic(period) {
  const r = await fetch("data/staffing-hist/" + period + ".json", { cache: "no-store" });
  if (!r.ok) throw new Error("Static hist HTTP " + r.status);
  const json = await r.json();
  return normalizeRow(json, period);
}

/**
 * Load precomputed historical aggregate for a period.
 * Prefers Supabase; falls back to committed data/staffing-hist/*.json.
 */
export async function loadStaffingHist(period) {
  const p = STAFFING_HIST_PERIODS.includes(period) ? period : "thisweek";
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
  throw new Error(lastErr || "No precomputed historical data for " + p);
}
