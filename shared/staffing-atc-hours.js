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

/** Movement volume with little or no controller time is what we want to surface. */
function coverageVerdict(movements, hours, coveragePct) {
  if (!movements) return hours > 0 ? "quiet · staffed" : "quiet";
  if (hours <= 0) return "unstaffed";
  if (coveragePct < 5 && movements >= 200) return "needs coverage";
  if (coveragePct < 15 && movements >= 500) return "needs coverage";
  if (coveragePct >= 25) return "well covered";
  return "partly covered";
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
  extraFacilities
} = {}) {
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
    const opsPerHour = r.hours > 0 ? roundTo(movements / r.hours, 1) : null;
    return {
      id: r.id,
      type: r.type,
      prefixes: r.prefixes.slice(),
      callsigns: r.callsigns.slice(),
      movements,
      hours,
      uptimePct: r.uptimePct ? roundTo(r.uptimePct, 2) : null,
      coveragePct,
      opsPerHour,
      verdict: coverageVerdict(movements, r.hours, coveragePct == null ? 0 : coveragePct)
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
  totals.opsPerHour = totals.hours > 0 ? roundTo(totals.movements / totals.hours, 1) : null;

  return { rows, totals, matchedPositions, skippedPositions, elapsedHours: elapsed };
}
