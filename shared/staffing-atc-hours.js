/**
 * StatSim ATC "time online per position (combined)" parsing and pilot/ATC coverage math.
 *
 * Source pages: https://statsim.net/atc/combinedtime/{thisweek,thismonth,thisyear}
 * Columns are grouped callsigns, Time online (HH:MM), Uptime (% of the period).
 * StatSim serves no CORS header, so the page arrives either as HTML (proxy that
 * relays the body) or as plain text lines (r.jina.ai markdown rendering).
 */

/** Position types worth staffing recommendations — GND / DEL / DEP / FSS are ignored. */
export const ATC_POSITION_TYPES = ["CTR", "APP", "TWR"];

export const STAFFING_ATC_PERIODS = ["thisweek", "thismonth", "thisyear"];

export const STATSIM_ATC_COMBINED = "https://statsim.net/atc/combinedtime/";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** StatSim custom-range timestamps for /atc/combinedtime/custom/{from}/{to}. */
export function fmtStatsimAtcDateTime(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
    "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

export function statsimAtcCombinedUrl(period) {
  const p = STAFFING_ATC_PERIODS.includes(period) ? period : "thisweek";
  return STATSIM_ATC_COMBINED + p;
}

export function statsimAtcCustomUrl(fromMs, toMs) {
  return STATSIM_ATC_COMBINED + "custom/" +
    encodeURIComponent(fmtStatsimAtcDateTime(fromMs)) + "/" +
    encodeURIComponent(fmtStatsimAtcDateTime(toMs));
}

/** StatSim calendar-year custom range (matches statsim.net UI: Jan 1 00:01 – Dec 31 23:59 UTC). */
export function statsimAtcCalendarYearUrl(year) {
  const y = Math.floor(+year);
  return STATSIM_ATC_COMBINED + "custom/" +
    encodeURIComponent(y + "-01-01T00:01") + "/" +
    encodeURIComponent(y + "-12-31T23:59");
}

export const ATC_TREND_FIRST_YEAR = 2020;
export const ATC_TREND_LAST_YEAR = 2026;

/** Calendar years that are not full Jan–Dec ranges in the trend table. */
export const ATC_TREND_PARTIAL_YEARS = {
  2026: { through: "2026-08-31T23:59", label: "through Aug 31, 2026" }
};

/** StatSim URL for a trend-table year (full calendar year, or partial when configured). */
export function statsimAtcTrendYearUrl(year) {
  const y = Math.floor(+year);
  const partial = ATC_TREND_PARTIAL_YEARS[y];
  if (partial) {
    return STATSIM_ATC_COMBINED + "custom/" +
      encodeURIComponent(y + "-01-01T00:01") + "/" +
      encodeURIComponent(partial.through);
  }
  return statsimAtcCalendarYearUrl(y);
}

export function atcTrendPartialLabel(year) {
  const p = ATC_TREND_PARTIAL_YEARS[Math.floor(+year)];
  return p ? p.label : null;
}

/** Last calendar year included in the multi-year ATC trend table. */
export function atcTrendLastYear(nowMs) {
  return ATC_TREND_LAST_YEAR;
}

export function atcTrendYears(firstYear, lastYear) {
  const first = firstYear != null ? +firstYear : ATC_TREND_FIRST_YEAR;
  const last = lastYear != null ? +lastYear : ATC_TREND_LAST_YEAR;
  const out = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

function roundHours(h) {
  return Math.round(h * 10) / 10;
}

/**
 * Join per-year position groups into facility rows with hours per calendar year.
 * Positions may be compact { p, t, s } or full grouped rows from groupAtcPositions().
 */
export function buildAtcTrendRows(positionsByYear, years, mapFacility, partialYears) {
  const map = typeof mapFacility === "function" ? mapFacility : () => null;
  const yearList = years && years.length ? years : Object.keys(positionsByYear || {}).map(Number).sort();
  const isPartial = y => !!(partialYears && (partialYears[y] || partialYears[String(y)]));
  const byFac = {};

  function addYear(year, positions) {
    for (const pos of positions || []) {
      const prefix = pos.prefix != null ? pos.prefix : pos.p;
      const type = pos.type != null ? pos.type : pos.t;
      if (!prefix || !ATC_POSITION_TYPES.includes(type)) continue;
      const fac = map(prefix, type);
      if (!fac || !fac.id) continue;
      const key = (fac.type || type) + "|" + fac.id;
      if (!byFac[key]) {
        byFac[key] = { id: fac.id, type: fac.type || type, hoursByYear: {} };
      }
      const sec = pos.seconds != null ? pos.seconds : pos.s;
      if (!(sec > 0)) continue;
      byFac[key].hoursByYear[year] = roundHours((byFac[key].hoursByYear[year] || 0) + sec / 3600);
    }
  }

  for (const year of yearList) {
    const list = positionsByYear[year] != null
      ? positionsByYear[year]
      : (positionsByYear[String(year)] || []);
    addYear(year, list);
  }

  const rows = Object.values(byFac).map(r => {
    let total = 0;
    let firstY = null;
    let firstH = 0;
    let lastY = null;
    let lastH = 0;
    for (const y of yearList) {
      const h = r.hoursByYear[y] || 0;
      total += h;
      if (h > 0 && !isPartial(y)) {
        if (firstY == null) { firstY = y; firstH = h; }
        lastY = y; lastH = h;
      }
    }
    let trendPct = null;
    if (firstY != null && lastY != null && firstY !== lastY && firstH > 0) {
      trendPct = Math.round(((lastH - firstH) / firstH) * 1000) / 10;
    }
    return {
      id: r.id,
      type: r.type,
      hoursByYear: r.hoursByYear,
      totalHours: roundHours(total),
      firstYear: firstY,
      lastYear: lastY,
      trendPct
    };
  });

  const latestYear = yearList.length ? yearList[yearList.length - 1] : 0;
  rows.sort((a, b) =>
    ((b.hoursByYear[latestYear] || 0) - (a.hoursByYear[latestYear] || 0)) ||
    (b.totalHours - a.totalHours) ||
    String(a.id).localeCompare(String(b.id)));

  return rows;
}

/** Network-wide USA controller hours per calendar year from trend rows. */
export function summarizeAtcTrend(rows, years, partialYears) {
  const yearList = years && years.length ? years : [];
  const isPartial = y => !!(partialYears && (partialYears[y] || partialYears[String(y)]));
  const totalsByYear = {};
  for (const y of yearList) totalsByYear[y] = 0;
  for (const r of rows || []) {
    for (const y of yearList) {
      totalsByYear[y] = roundHours(totalsByYear[y] + (r.hoursByYear[y] || 0));
    }
  }
  const ys = yearList.filter(y => totalsByYear[y] > 0 && !isPartial(y));
  let trendPct = null;
  if (ys.length >= 2) {
    const first = totalsByYear[ys[0]];
    const last = totalsByYear[ys[ys.length - 1]];
    if (first > 0) trendPct = Math.round(((last - first) / first) * 1000) / 10;
  }
  return {
    totalsByYear,
    trendPct,
    firstYear: ys[0] || null,
    lastYear: ys[ys.length - 1] || null,
    partialYears: partialYears || null
  };
}

/** Compact position rows for JSON storage. */
export function compactAtcPositions(positions) {
  return (positions || [])
    .filter(p => p && (p.seconds > 0 || p.s > 0))
    .map(p => ({
      p: p.prefix != null ? p.prefix : p.p,
      t: p.type != null ? p.type : p.t,
      s: Math.round(p.seconds != null ? p.seconds : p.s)
    }));
}

/** Expand compact rows back to grouped shape for buildAtcTrendRows. */
export function expandCompactAtcPositions(compact) {
  return (compact || []).map(p => ({ prefix: p.p, type: p.t, seconds: p.s }));
}

/**
 * StatSim's thisyear page is ~900 KB and breaks browser CORS proxies. Fetch it as
 * monthly custom chunks (server build) or load precomputed JSON instead.
 */
export function statsimAtcFetchJobs(period, nowMs) {
  const p = STAFFING_ATC_PERIODS.includes(period) ? period : "thisweek";
  if (p === "thisweek" || p === "thismonth") {
    return [{ label: p === "thisweek" ? "this week" : "this month", url: statsimAtcCombinedUrl(p) }];
  }
  const now = nowMs != null ? nowMs : Date.now();
  const d = new Date(now);
  const y = d.getUTCFullYear();
  let mo = 0;
  const jobs = [];
  while (mo < 12) {
    const fromMs = Date.UTC(y, mo, 1, 0, 0, 0);
    if (fromMs >= now) break;
    const toMs = Math.min(Date.UTC(y, mo + 1, 1, 0, 0, 0) - 60000, now);
    jobs.push({
      label: y + "-" + pad2(mo + 1),
      url: statsimAtcCustomUrl(fromMs, toMs)
    });
    mo++;
  }
  if (!jobs.length) {
    return [{ label: "this week", url: statsimAtcCombinedUrl("thisweek") }];
  }
  return jobs;
}

/** Sum grouped position rows from multiple StatSim pages or monthly chunks. */
export function mergeAtcPositionGroups(groupLists) {
  const byKey = {};
  for (const groups of groupLists || []) {
    for (const g of groups || []) {
      if (!g || !ATC_POSITION_TYPES.includes(g.type)) continue;
      const key = g.prefix + "|" + g.type;
      if (!byKey[key]) {
        byKey[key] = {
          prefix: g.prefix,
          type: g.type,
          seconds: 0,
          uptimePct: 0,
          callsigns: [],
          groups: 0
        };
      }
      const row = byKey[key];
      row.seconds += g.seconds || 0;
      row.uptimePct += g.uptimePct || 0;
      row.groups += g.groups || 1;
      for (const cs of g.callsigns || []) {
        if (!row.callsigns.includes(cs)) row.callsigns.push(cs);
      }
    }
  }
  return Object.values(byKey)
    .map(g => ({ ...g, hours: g.seconds / 3600 }))
    .sort((a, b) => b.seconds - a.seconds ||
      a.prefix.localeCompare(b.prefix) || a.type.localeCompare(b.type));
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function parseHhMm(s) {
  const m = String(s || "").trim().match(/^(\d+):([0-5]\d)$/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60;
}

function splitCallsigns(cell) {
  return String(cell || "").toUpperCase().split(",")
    .map(s => s.trim().replace(/[^A-Z0-9_]/g, ""))
    .filter(Boolean);
}

/**
 * A group's identity comes from its first callsign only: StatSim lists every
 * similar callsign in one cell (EDWW_ALR_CTR, EDWW_BOR_CTR, EDWW_CTR, …), so the
 * leading prefix plus the trailing position type is the facility we care about.
 */
function positionFromCallsigns(callsigns) {
  const first = callsigns[0];
  if (!first) return null;
  const parts = first.split("_").filter(Boolean);
  if (parts.length < 2) return null;
  const type = parts[parts.length - 1];
  const prefix = parts[0];
  if (!prefix || !ATC_POSITION_TYPES.includes(type)) return null;
  return { prefix, type };
}

function pushPosition(out, callsignCell, timeCell, uptimeCell, secondsHint) {
  const callsigns = splitCallsigns(callsignCell);
  const ident = positionFromCallsigns(callsigns);
  if (!ident) return;
  const seconds = secondsHint != null && isFinite(secondsHint)
    ? secondsHint
    : parseHhMm(timeCell);
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return;
  const up = String(uptimeCell || "").match(/(\d+(?:\.\d+)?)\s*%/);
  out.push({
    callsigns,
    prefix: ident.prefix,
    type: ident.type,
    seconds,
    uptimePct: up ? +up[1] : null
  });
}

/** Parse the `#positionTable` rows out of the StatSim ATC HTML. */
export function parseStatsimAtcHtml(html) {
  const text = String(html || "");
  const out = [];
  const rowRe = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td([^>]*)>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(text))) {
    const callsignCell = stripTags(m[1]);
    if (/^callsign$/i.test(callsignCell)) continue;
    /* sorttable_customkey carries exact seconds; HH:MM is the display value. */
    const keyMatch = String(m[2] || "").match(/sorttable_customkey="(\d+)"/i);
    pushPosition(out, callsignCell, stripTags(m[3]), stripTags(m[4]),
      keyMatch ? +keyMatch[1] : null);
  }
  return out;
}

/**
 * Parse the text rendering (r.jina.ai), where each row collapses to
 * `CALLSIGN, CALLSIGN … HH:MM NN.NN%` — optionally as a markdown table row.
 */
export function parseStatsimAtcText(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.includes("|")) {
      const cells = line.split("|").map(s => s.trim()).filter(Boolean);
      if (cells.length >= 3) {
        pushPosition(out, cells[0], cells[1], cells[2], null);
        continue;
      }
      line = cells.join(" ");
    }
    const m = line.match(/^(.+?)\s+(\d+:[0-5]\d)\s+(\d+(?:\.\d+)?)\s*%$/);
    if (!m) continue;
    pushPosition(out, m[1], m[2], m[3] + "%", null);
  }
  return out;
}

/** Parse either response shape into position rows. */
export function parseStatsimAtc(text) {
  const s = String(text || "");
  if (/<t[dr][\s>]/i.test(s)) {
    const rows = parseStatsimAtcHtml(s);
    if (rows.length) return rows;
  }
  return parseStatsimAtcText(s);
}

/**
 * The period the page covers, from its `2026-08-31 00:00 - 2026-09-06 23:59` line.
 * StatSim reports calendar ranges, so "this week" ends in the future mid-week.
 */
export function parseStatsimAtcRange(text) {
  const m = String(text || "").match(
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*[-\u2013]\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/
  );
  if (!m) return null;
  const fromMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const toMs = Date.UTC(+m[6], +m[7] - 1, +m[8], +m[9], +m[10]);
  if (!isFinite(fromMs) || !isFinite(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs };
}

/**
 * StatSim's calendar range for a period id, used when the page's date line is
 * missing (the r.jina.ai text rendering drops it). Weeks run Monday–Sunday UTC.
 */
export function atcPeriodRange(period, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  if (period === "thismonth") {
    return { fromMs: Date.UTC(y, mo, 1), toMs: Date.UTC(y, mo + 1, 1) - 60000 };
  }
  if (period === "thisyear") {
    return { fromMs: Date.UTC(y, 0, 1), toMs: Date.UTC(y + 1, 0, 1) - 60000 };
  }
  const monday = Date.UTC(y, mo, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return { fromMs: monday, toMs: monday + 7 * 86400000 - 60000 };
}

/** Range from the page when it carries one, else the calendar range for the period. */
export function resolveAtcRange(text, period, nowMs) {
  return parseStatsimAtcRange(text) || atcPeriodRange(period, nowMs);
}

/** Hours of the range that have actually elapsed (a calendar week ends in the future). */
export function atcElapsedHours(range, nowMs) {
  if (!range) return 0;
  const now = nowMs != null ? nowMs : Date.now();
  const end = Math.min(range.toMs, now);
  if (!(end > range.fromMs)) return 0;
  return (end - range.fromMs) / 3600000;
}

/** Sum seconds per prefix + type: StatSim can emit SLC_C_TWR and SLC_TWR separately. */
export function groupAtcPositions(rows) {
  const byKey = {};
  for (const r of rows || []) {
    if (!r || !ATC_POSITION_TYPES.includes(r.type)) continue;
    const key = r.prefix + "|" + r.type;
    if (!byKey[key]) {
      byKey[key] = {
        prefix: r.prefix,
        type: r.type,
        seconds: 0,
        uptimePct: 0,
        callsigns: [],
        groups: 0
      };
    }
    const g = byKey[key];
    g.seconds += r.seconds || 0;
    g.uptimePct += r.uptimePct || 0;
    g.groups++;
    for (const cs of r.callsigns || []) {
      if (!g.callsigns.includes(cs)) g.callsigns.push(cs);
    }
  }
  return Object.values(byKey)
    .map(g => ({ ...g, hours: g.seconds / 3600 }))
    .sort((a, b) => b.seconds - a.seconds ||
      a.prefix.localeCompare(b.prefix) || a.type.localeCompare(b.type));
}

function roundTo(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function median(nums) {
  const a = (nums || []).filter(n => n != null && isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Rank correlation between staffing hours and pilot movements (association, not causation). */
function spearmanRank(xs, ys) {
  if (!xs || xs.length < 4 || xs.length !== ys.length) return null;
  function ranks(vals) {
    const indexed = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array(vals.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
      const rank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[indexed[k].i] = rank;
      i = j + 1;
    }
    return out;
  }
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }
  return roundTo(1 - (6 * sumD2) / (n * (n * n - 1)), 2);
}

function staffTierFromHours(hours) {
  if (!(hours > 0)) return "none";
  if (hours < 5) return "light";
  if (hours < 15) return "moderate";
  return "heavy";
}

/** Per-facility label for the staff-it view — no ops/hour rate. */
function staffSignal(movements, hours, minMovements) {
  const busy = (movements || 0) >= minMovements;
  if (hours > 0) return busy ? "staffed" : "quiet · staffed";
  return busy ? "busy · no ATC" : "quiet";
}

/**
 * Does staffing line up with more pilots? Compares staffed vs unstaffed facilities
 * with meaningful traffic, plus staffing-hour bands and rank correlation.
 */
export function analyzeStaffItEffect(rows, { minMovements = 50 } = {}) {
  const busy = (rows || []).filter(r => (r.movements || 0) >= minMovements);
  const staffed = busy.filter(r => (r.hours || 0) > 0);
  const unstaffed = busy.filter(r => !(r.hours > 0));
  const staffedMedian = median(staffed.map(r => r.movements));
  const unstaffedMedian = median(unstaffed.map(r => r.movements));

  const byType = {};
  for (const typ of ATC_POSITION_TYPES) {
    const s = staffed.filter(r => r.type === typ);
    const u = unstaffed.filter(r => r.type === typ);
    const sm = median(s.map(r => r.movements));
    const um = median(u.map(r => r.movements));
    byType[typ] = {
      staffedCount: s.length,
      unstaffedCount: u.length,
      staffedMedian: sm,
      unstaffedMedian: um,
      ratio: um > 0 ? roundTo(sm / um, 1) : null
    };
  }

  const bands = [
    { id: "none", label: "No ATC", test: r => !(r.hours > 0) },
    { id: "light", label: "Light (<5h)", test: r => r.hours > 0 && r.hours < 5 },
    { id: "moderate", label: "Moderate (5\u201315h)", test: r => r.hours >= 5 && r.hours < 15 },
    { id: "heavy", label: "Heavy (15h+)", test: r => r.hours >= 15 }
  ].map(b => {
    const group = busy.filter(b.test);
    return {
      id: b.id,
      label: b.label,
      count: group.length,
      medianMovements: median(group.map(r => r.movements)),
      avgMovements: group.length
        ? roundTo(group.reduce((sum, r) => sum + r.movements, 0) / group.length, 0)
        : 0
    };
  });

  const counterexamples = unstaffed.slice().sort((a, b) => b.movements - a.movements).slice(0, 6);
  const ratio = unstaffedMedian > 0 ? roundTo(staffedMedian / unstaffedMedian, 1) : null;
  const correlation = spearmanRank(busy.map(r => r.hours), busy.map(r => r.movements));

  return {
    minMovements,
    busyCount: busy.length,
    staffedCount: staffed.length,
    unstaffedCount: unstaffed.length,
    staffedMedian: roundTo(staffedMedian, 0),
    unstaffedMedian: roundTo(unstaffedMedian, 0),
    staffedAvg: staffed.length
      ? roundTo(staffed.reduce((s, r) => s + r.movements, 0) / staffed.length, 0) : 0,
    unstaffedAvg: unstaffed.length
      ? roundTo(unstaffed.reduce((s, r) => s + r.movements, 0) / unstaffed.length, 0) : 0,
    ratio,
    correlation,
    byType,
    bands,
    counterexamples,
    /* True when staffed sites clearly see more traffic — still not proof of causation. */
    leansYes: ratio != null && ratio >= 1.5 && staffed.length >= 8 && unstaffed.length >= 3
  };
}

/**
 * Join grouped ATC hours to pilot movements per facility.
 *
 * @param positions   groupAtcPositions() output
 * @param mapFacility (prefix, type) => { id, type } | null — US facilities only
 * @param movementsFor (id, type) => number
 * @param elapsedHours hours elapsed in the ATC period (denominator for coverage)
 * @param extraFacilities [{ id, type }] facilities with traffic but no ATC time
 */
export function buildAtcCoverage({
  positions,
  mapFacility,
  movementsFor,
  elapsedHours,
  extraFacilities,
  minMovements
} = {}) {
  const minMov = minMovements != null ? minMovements : 50;
  const map = typeof mapFacility === "function" ? mapFacility : () => null;
  const movesOf = typeof movementsFor === "function" ? movementsFor : () => 0;
  const elapsed = elapsedHours > 0 ? elapsedHours : 0;
  const byId = {};
  let matchedPositions = 0;
  let skippedPositions = 0;

  function slot(id, type) {
    const key = type + "|" + id;
    if (!byId[key]) {
      byId[key] = {
        id,
        type,
        hours: 0,
        uptimePct: 0,
        prefixes: [],
        callsigns: [],
        movements: 0
      };
    }
    return byId[key];
  }

  for (const p of positions || []) {
    const fac = map(p.prefix, p.type);
    if (!fac || !fac.id) { skippedPositions++; continue; }
    matchedPositions++;
    const row = slot(fac.id, fac.type || p.type);
    row.hours += p.hours != null ? p.hours : (p.seconds || 0) / 3600;
    row.uptimePct += p.uptimePct || 0;
    if (!row.prefixes.includes(p.prefix)) row.prefixes.push(p.prefix);
    for (const cs of p.callsigns || []) {
      if (!row.callsigns.includes(cs)) row.callsigns.push(cs);
    }
  }
  for (const fac of extraFacilities || []) {
    if (fac && fac.id) slot(fac.id, fac.type);
  }

  const rows = Object.values(byId).map(r => {
    const movements = Math.max(0, Math.round(movesOf(r.id, r.type) || 0));
    const hours = roundTo(r.hours, 1);
    const coveragePct = elapsed > 0 ? roundTo((r.hours / elapsed) * 100, 1) : null;
    return {
      id: r.id,
      type: r.type,
      prefixes: r.prefixes.slice(),
      callsigns: r.callsigns.slice(),
      movements,
      hours,
      staffed: r.hours > 0,
      staffTier: staffTierFromHours(r.hours),
      staffSignal: staffSignal(movements, r.hours, minMov),
      uptimePct: r.uptimePct ? roundTo(r.uptimePct, 2) : null,
      coveragePct
    };
  });

  rows.sort((a, b) =>
    (b.movements - a.movements) || (b.hours - a.hours) ||
    String(a.id).localeCompare(String(b.id)) || String(a.type).localeCompare(String(b.type)));

  const totals = { CTR: 0, APP: 0, TWR: 0, hours: 0, movements: 0, facilities: rows.length };
  for (const r of rows) {
    if (totals[r.type] != null) totals[r.type] = roundTo(totals[r.type] + r.hours, 1);
    totals.hours = roundTo(totals.hours + r.hours, 1);
    totals.movements += r.movements;
  }
  const staffIt = analyzeStaffItEffect(rows, { minMovements: minMov });

  return { rows, totals, staffIt, matchedPositions, skippedPositions, elapsedHours: elapsed };
}
