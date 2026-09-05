/**
 * Client loader for the unattended FCA crossing archive (anon SELECT).
 */
export const SUPABASE_URL = "https://qoaipsfcidpymboojfwa.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79";

const RANGES = {
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
  "90d": 90 * 24 * 3600 * 1000,
};

export const CROSSING_RANGES = ["24h", "7d", "30d", "90d"];

function rest(path) {
  return fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      Accept: "application/json",
    },
  }).then(r => {
    if (!r.ok) throw new Error("Supabase HTTP " + r.status);
    return r.json();
  });
}

export function rangeStartMs(range, nowMs = Date.now()) {
  const span = RANGES[range] || RANGES["7d"];
  return nowMs - span;
}

export async function loadFcaCrossings(opts = {}) {
  const limit = opts.limit != null ? opts.limit : 2000;
  let q = "fca_crossings?select=*&order=actual_at.desc&limit=" + limit;
  if (opts.fcaId) q += "&fca_id=eq." + encodeURIComponent(opts.fcaId);
  if (opts.sinceMs) q += "&actual_at=gte." + encodeURIComponent(new Date(opts.sinceMs).toISOString());
  if (opts.untilMs) q += "&actual_at=lte." + encodeURIComponent(new Date(opts.untilMs).toISOString());
  return rest(q);
}

export async function loadCrossingFcaIds() {
  const rows = await rest("fca_crossings?select=fca_id,fca_name,artcc&order=actual_at.desc&limit=2000");
  const seen = new Map();
  for (const r of rows || []) {
    if (!r.fca_id || seen.has(r.fca_id)) continue;
    seen.set(r.fca_id, { id: r.fca_id, name: r.fca_name || r.fca_id, artcc: r.artcc || "" });
  }
  return [...seen.values()];
}

export async function loadOpenTrackCount(fcaId) {
  let q = "fca_crossing_tracks?select=id&status=eq.open";
  if (fcaId) q += "&fca_id=eq." + encodeURIComponent(fcaId);
  const rows = await rest(q);
  return Array.isArray(rows) ? rows.length : 0;
}

function median(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function summarizeCrossings(rows) {
  const deltas = (rows || []).map(r => r.delta_sec).filter(n => n != null && isFinite(n));
  const n = deltas.length;
  if (!n) {
    return { n: 0, mean: null, median: null, mae: null, pctWithin2: null, pctEarly: null, pctLate: null, pctOn: null };
  }
  const mean = deltas.reduce((s, v) => s + v, 0) / n;
  const mae = deltas.reduce((s, v) => s + Math.abs(v), 0) / n;
  const early = deltas.filter(v => v < 0).length;
  const late = deltas.filter(v => v > 0).length;
  const on = deltas.filter(v => v === 0).length;
  const within = deltas.filter(v => Math.abs(v) <= 120).length;
  return {
    n,
    mean,
    median: median(deltas),
    mae,
    pctWithin2: 100 * within / n,
    pctEarly: 100 * early / n,
    pctLate: 100 * late / n,
    pctOn: 100 * on / n,
  };
}

/** 1-minute bins from -20 to +20, with overflow ends. */
export function histogramBins(rows) {
  const bins = [];
  for (let m = -20; m <= 20; m++) bins.push({ min: m, label: String(m), count: 0 });
  for (const r of rows || []) {
    if (r.delta_sec == null || !isFinite(r.delta_sec)) continue;
    let m = Math.round(r.delta_sec / 60);
    if (m < -20) m = -20;
    if (m > 20) m = 20;
    bins[m + 20].count++;
  }
  return bins;
}

export function fmtDelta(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  const sign = sec < 0 ? "−" : sec > 0 ? "+" : "";
  const abs = Math.abs(Math.round(sec));
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  return sign + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}

export function fmtZuluFull(isoOrMs) {
  const d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${mo}/${day} ${hh}${mm}:${ss}Z`;
}

export function crossingsToCsv(rows) {
  const cols = [
    "callsign", "cid", "dep", "arr", "planned_from", "planned_at", "actual_at",
    "delta_sec", "fca_id", "fca_name", "artcc", "dist_nm_at_plan",
  ];
  const lines = [cols.join(",")];
  for (const r of rows || []) {
    lines.push(cols.map(c => {
      const v = r[c];
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  }
  return lines.join("\n");
}
