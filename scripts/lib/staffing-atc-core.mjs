/**
 * Server-side StatSim ATC combined-time fetch for precomputed staffing_atc JSON.
 */
import {
  STAFFING_ATC_PERIODS,
  parseStatsimAtc,
  parseStatsimAtcRange,
  resolveAtcRange,
  groupAtcPositions,
  mergeAtcPositionGroups,
  statsimAtcFetchJobs,
  statsimAtcCalendarYearUrl,
  statsimAtcTrendYearUrl,
  compactAtcPositions,
  ATC_TREND_FIRST_YEAR,
  ATC_TREND_PARTIAL_YEARS,
  atcTrendYears
} from "../../shared/staffing-atc-hours.js";

export { STAFFING_ATC_PERIODS as PERIODS, ATC_TREND_FIRST_YEAR, atcTrendYears };

function looksLikeAtcPage(text) {
  return /Time online/i.test(text) && /_(TWR|APP|CTR)\b/.test(text);
}

export async function fetchStatsimAtcUrlText(url, { timeoutMs = 180000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "VATFLOW-staffing-atc/1.0 (+https://vatflow.io)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    if (!text || !looksLikeAtcPage(text)) throw new Error("Unexpected StatSim ATC response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAtcPeriod(period, onProgress, nowMs) {
  const p = STAFFING_ATC_PERIODS.includes(period) ? period : "thisweek";
  const jobs = statsimAtcFetchJobs(p, nowMs);
  const groupedChunks = [];
  let failed = 0;
  let lastErr = null;
  let range = null;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (typeof onProgress === "function") onProgress(i + 1, jobs.length, job.label);
    try {
      const text = await fetchStatsimAtcUrlText(job.url);
      const pageRange = parseStatsimAtcRange(text);
      if (pageRange) {
        if (!range) range = { ...pageRange };
        else {
          range.fromMs = Math.min(range.fromMs, pageRange.fromMs);
          range.toMs = Math.max(range.toMs, pageRange.toMs);
        }
      }
      groupedChunks.push(groupAtcPositions(parseStatsimAtc(text)));
    } catch (e) {
      failed++;
      lastErr = e && e.message ? e.message : String(e);
      if (jobs.length === 1) throw e;
      console.warn("ATC chunk failed", job.label, lastErr);
    }
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  const positions = mergeAtcPositionGroups(groupedChunks);
  if (!positions.length) {
    throw new Error(
      (lastErr || "No StatSim ATC rows returned") +
      (jobs.length > 1 ? " (" + failed + "/" + jobs.length + " chunks failed)" : "")
    );
  }
  if (!range) range = resolveAtcRange("", p, nowMs);
  return {
    period: p,
    positions,
    range,
    chunks: jobs.length,
    failedChunks: failed
  };
}

export async function fetchAtcCalendarYear(year, onProgress) {
  const y = Math.floor(+year);
  const url = statsimAtcCalendarYearUrl(y);
  if (typeof onProgress === "function") onProgress(1, 1, String(y));
  const text = await fetchStatsimAtcUrlText(url, { timeoutMs: 240000 });
  const positions = groupAtcPositions(parseStatsimAtc(text));
  if (!positions.length) throw new Error("No StatSim ATC rows for " + y);
  return {
    year: y,
    url,
    positions,
    positionGroups: positions.length,
    totalSeconds: Math.round(positions.reduce((s, p) => s + (p.seconds || 0), 0))
  };
}

/** Fetch one trend-table year (uses partial range when configured, e.g. 2026 through Aug 31). */
export async function fetchAtcTrendYear(year, onProgress) {
  const y = Math.floor(+year);
  const url = statsimAtcTrendYearUrl(y);
  if (typeof onProgress === "function") onProgress(1, 1, String(y));
  const text = await fetchStatsimAtcUrlText(url, { timeoutMs: 240000 });
  const positions = groupAtcPositions(parseStatsimAtc(text));
  if (!positions.length) throw new Error("No StatSim ATC rows for " + y);
  return {
    year: y,
    url,
    positions,
    positionGroups: positions.length,
    totalSeconds: Math.round(positions.reduce((s, p) => s + (p.seconds || 0), 0))
  };
}
