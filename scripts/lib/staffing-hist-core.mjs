/**
 * Shared StatSim USA historical aggregation for ATC Staffing.
 * Prefers the official StatSim REST API (STATSIM_API_KEY) — HTML country pages
 * often return empty tables to datacenter / CI IPs after StatSim's Blazor rewrite.
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const PERIODS = ["thisweek", "thismonth", "thisyear"];
export const STATSIM_COUNTRY_US = "https://statsim.net/flights/countries/country/US/";
export const STATSIM_API_BASE = "https://api.statsim.net";
export const STATSIM_CHUNK_DAYS = 7;
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const __staffingHistDir = path.dirname(fileURLToPath(import.meta.url));

const STAFFING_AIRPORT_ARTCC = {
  KPHX: "ZAB", KABQ: "ZAB", KTUS: "ZAB",
  KORD: "ZAU", KMDW: "ZAU", KMKE: "ZAU", KMSN: "ZAU",
  KBOS: "ZBW", KBDL: "ZBW", KPVD: "ZBW", KMHT: "ZBW", KBGR: "ZBW",
  KDCA: "ZDC", KIAD: "ZDC", KBWI: "ZDC", KRIC: "ZDC", KORF: "ZDC", KRDU: "ZDC",
  KDEN: "ZDV", KCOS: "ZDV", KSLC: "ZLC",
  KDFW: "ZFW", KDAL: "ZFW", KAUS: "ZHU", KIAH: "ZHU", KHOU: "ZHU", KMSY: "ZHU", KSAT: "ZHU", KCRP: "ZHU",
  KIND: "ZID", KCVG: "ZID", KCMH: "ZID", KDAY: "ZID",
  KMCO: "ZJX", KJAX: "ZJX", KTLH: "ZJX", KCHS: "ZJX", KSAV: "ZJX",
  KMCI: "ZKC", KSTL: "ZKC", KICT: "ZKC", KOMA: "ZMP",
  KLAX: "ZLA", KSAN: "ZLA", KSNA: "ZLA", KBUR: "ZLA", KLGB: "ZLA", KPSP: "ZLA", KLAS: "ZLA", KRNO: "ZOA",
  KMIA: "ZMA", KFLL: "ZMA", KTPA: "ZMA", KPBI: "ZMA", KRSW: "ZMA", KEYW: "ZMA",
  KMEM: "ZME", KBNA: "ZME", KLIT: "ZME",
  KMSP: "ZMP", KDSM: "ZMP",
  KEWR: "ZNY", KLGA: "ZNY", KJFK: "ZNY", KPHL: "ZNY", KALB: "ZNY", KBUF: "ZNY",
  KSFO: "ZOA", KOAK: "ZOA", KSJC: "ZOA", KSMF: "ZOA",
  KCLE: "ZOB", KDTW: "ZOB", KPIT: "ZOB",
  KSEA: "ZSE", KPDX: "ZSE", KGEG: "ZSE",
  KATL: "ZTL", KCLT: "ZTL", KBHM: "ZTL", KTRI: "ZTL",
  PANC: "ZAN", PAFA: "ZAN", PAPG: "ZAN",
  PHNL: "ZHN", PHOG: "ZHN"
};

export function isUsStaffingAirport(icao) {
  const c = (icao || "").toUpperCase();
  return /^K[A-Z]{3}$/.test(c) || /^PA[A-Z]{2}$/.test(c) || /^PH[A-Z]{2}$/.test(c);
}

export function airportStaffingArtcc(icao) {
  const code = String(icao || "").toUpperCase();
  return STAFFING_AIRPORT_ARTCC[code] || null;
}

function pad2(n) { return String(n).padStart(2, "0"); }

export function fmtStatsimDateTime(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
    "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

export function statsimCountryUrl(period) {
  return STATSIM_COUNTRY_US + period;
}

export function statsimCustomRangeUrl(fromMs, toMs) {
  return STATSIM_COUNTRY_US + "custom/" +
    encodeURIComponent(fmtStatsimDateTime(fromMs)) + "/" +
    encodeURIComponent(fmtStatsimDateTime(toMs));
}

export function statsimFetchJobs(period) {
  if (period === "thisweek") {
    return [{ label: "this week", url: statsimCountryUrl("thisweek") }];
  }
  const now = Date.now();
  const d = new Date(now);
  const startMs = period === "thismonth"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0)
    : Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0);
  const jobs = [];
  const span = STATSIM_CHUNK_DAYS * 86400000;
  for (let t = startMs; t < now; t += span) {
    const fromMs = t;
    const toMs = Math.min(t + span - 60000, now);
    jobs.push({
      label: fmtStatsimDateTime(fromMs).slice(0, 10) + "\u2013" + fmtStatsimDateTime(toMs).slice(0, 10),
      url: statsimCustomRangeUrl(fromMs, toMs)
    });
  }
  return jobs.length ? jobs : [{ label: "this week", url: statsimCountryUrl("thisweek") }];
}

function parseStatsimTime(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

function stripHtmlText(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function pushFlight(out, callsign, origin, dest, timeMs, kind, aircraft) {
  if (!timeMs || !isFinite(timeMs)) return;
  const o = String(origin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const d = String(dest || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!o && !d) return;
  out.push({
    callsign: String(callsign || "").trim(),
    origin: o,
    dest: d,
    timeMs,
    kind,
    aircraft: String(aircraft || "").trim()
  });
}

export function parseStatsimCountryHtml(html) {
  const out = [];
  const text = String(html || "");
  function parseSection(kind, startRe, endRe) {
    const sm = text.match(startRe);
    if (!sm) return;
    const start = sm.index + sm[0].length;
    const rest = text.slice(start);
    const em = endRe ? rest.search(endRe) : -1;
    const chunk = em >= 0 ? rest.slice(0, em) : rest;
    const rowRe = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(chunk))) {
      const cells = m.slice(1).map(stripHtmlText);
      if (/^callsign$/i.test(cells[0])) continue;
      pushFlight(out, cells[0], cells[1], cells[2], parseStatsimTime(cells[3]), kind, cells[4]);
    }
  }
  parseSection("dep", /<h4[^>]*>\s*Departed\b[\s\S]*?<tbody/i, /<h4[^>]*>\s*Arrived\b/i);
  parseSection("arr", /<h4[^>]*>\s*Arrived\b[\s\S]*?<tbody/i, /<\/main>|<\/body>/i);
  return out;
}

export function parseStatsimCountryMarkdown(md) {
  const out = [];
  const lines = String(md || "").split(/\r?\n/);
  let mode = null;
  function cell(s) {
    const t = String(s || "").trim();
    const link = t.match(/^\[([^\]]+)\]/);
    return link ? link[1].trim() : t;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{0,6}\s*Departed\b/i.test(line) || /^Departed\b/i.test(line)) { mode = "dep"; continue; }
    if (/^#{0,6}\s*Arrived\b/i.test(line) || /^Arrived\b/i.test(line)) { mode = "arr"; continue; }
    if (!mode) continue;
    if (/^Callsign\b/i.test(line) || /^\|?\s*Callsign\b/i.test(line)) continue;
    if (/^#{1,6}\s/.test(line) || /^United States$/i.test(line)) { mode = null; continue; }
    const parts = line.includes("\t") ? line.split(/\t+/) : line.split(/\|/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 5) continue;
    if (/^-{2,}$/.test(parts[0])) continue;
    const callsign = cell(parts[0]);
    const origin = cell(parts[1]);
    const dest = cell(parts[2]);
    const t = parseStatsimTime(cell(parts[3]));
    if (t == null) continue;
    pushFlight(out, callsign, origin, dest, t, mode, cell(parts[4]));
  }
  return out;
}

export function parseStatsimCountryText(text) {
  const s = String(text || "");
  if (/<table[\s>]/i.test(s) && /Departed/i.test(s)) {
    const rows = parseStatsimCountryHtml(s);
    if (rows.length) return rows;
  }
  return parseStatsimCountryMarkdown(s);
}

/** True when StatSim returned the Blazor shell with empty Departed/Arrived tables. */
export function statsimResponseIsEmptyShell(text) {
  const s = String(text || "");
  const dep = s.match(/Departed\s*\((\d+)\)/i);
  const arr = s.match(/Arrived\s*\((\d+)\)/i);
  if (dep && arr && Number(dep[1]) === 0 && Number(arr[1]) === 0) return true;
  if (/Departed/i.test(s) && /<table/i.test(s) && !/<tbody[^>]*>\s*<tr/i.test(s)) {
    /* thead-only tables */
    if (!/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return true;
  }
  return false;
}

export function periodFetchWindows(period) {
  const now = Date.now();
  const d = new Date(now);
  let startMs;
  if (period === "thismonth") {
    startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0);
  } else if (period === "thisyear") {
    startMs = Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0);
  } else {
    /* thisweek ≈ last 7 days */
    startMs = now - 7 * 86400000;
  }
  /*
   * Keep windows short: busy ICAOs (KATL/KORD/…) truncate on multi-day
   * /api/Flights/Icao responses (~48KB cutoffs observed from CI networks).
   */
  const spanDays = period === "thisyear" ? 3 : 1;
  const windows = [];
  const span = spanDays * 86400000;
  for (let t = startMs; t < now; t += span) {
    const fromMs = t;
    const toMs = Math.min(t + span, now);
    windows.push({
      fromMs,
      toMs,
      label: fmtStatsimDateTime(fromMs).slice(0, 10) + "\u2013" + fmtStatsimDateTime(toMs).slice(0, 10)
    });
  }
  return windows.length ? windows : [{ fromMs: startMs, toMs: now, label: "range" }];
}

function flightDtoToRows(f) {
  const out = [];
  if (!f || typeof f !== "object") return out;
  const cs = f.callsign;
  const origin = f.departure;
  const dest = f.destination;
  const ac = f.aircraft;
  if (f.departed) {
    const t = Date.parse(f.departed);
    if (isFinite(t)) pushFlight(out, cs, origin, dest, t, "dep", ac);
  }
  if (f.arrived) {
    const t = Date.parse(f.arrived);
    if (isFinite(t)) pushFlight(out, cs, origin, dest, t, "arr", ac);
  }
  return out;
}

function loadUsStaffingIcaos() {
  const fp = path.join(__staffingHistDir, "us-staffing-icaos.json");
  const fromFile = JSON.parse(fs.readFileSync(fp, "utf8"));
  const set = new Set(fromFile);
  for (const icao of Object.keys(STAFFING_AIRPORT_ARTCC)) set.add(icao);
  return [...set].sort();
}

/** Reliable JSON GET — Node fetch/undici often truncates StatSim API bodies. */
export function httpsGetJson(url, headers, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error("StatSim API unauthorized (check STATSIM_API_KEY)"));
          return;
        }
        /* No flights for this ICAO/range — StatSim returns 404. */
        if (res.statusCode === 404) {
          resolve([]);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("StatSim API HTTP " + res.statusCode + ": " + text.slice(0, 200)));
          return;
        }
        try {
          const textTrim = text.trim();
          if (!textTrim.startsWith("[") || !textTrim.endsWith("]")) {
            reject(new Error(
              "StatSim API truncated body (" + buf.length + " bytes, missing array bounds)"
            ));
            return;
          }
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(
            "StatSim API truncated/invalid JSON (" + buf.length + " bytes): " + (e && e.message)
          ));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("StatSim API timeout"));
    });
  });
}

export async function fetchStatsimIcaoWindow(icao, fromMs, toMs, apiKey, { timeoutMs = 180000 } = {}) {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const url = STATSIM_API_BASE + "/api/Flights/Icao?icao=" + encodeURIComponent(icao) +
    "&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
  const data = await httpsGetJson(url, {
    "X-API-Key": apiKey,
    Accept: "application/json",
    "User-Agent": "VATFLOW-staffing-hist/1.0 (+https://vatflow.io)"
  }, { timeoutMs });
  if (!Array.isArray(data)) throw new Error("StatSim API returned non-array for " + icao);
  const rows = [];
  for (const f of data) rows.push(...flightDtoToRows(f));
  return rows;
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

/**
 * StatSim /api/Flights/Dates payloads are huge and often truncate mid-transfer.
 * Query /api/Flights/Icao per US airport instead (smaller responses, reliable).
 */
export async function fetchPeriodFlightsFromApi(period, apiKey, onProgress) {
  const windows = periodFetchWindows(period);
  const icaos = loadUsStaffingIcaos();
  const jobs = [];
  for (const w of windows) {
    for (const icao of icaos) {
      jobs.push({ icao, fromMs: w.fromMs, toMs: w.toMs, label: w.label + " " + icao });
    }
  }

  console.log("StatSim API: %d airports × %d window(s) = %d requests",
    icaos.length, windows.length, jobs.length);

  const all = [];
  const seen = Object.create(null);
  let failed = 0;
  let lastErr = null;
  const concurrency = Math.max(1, Math.min(6, Number(process.env.STATSIM_API_CONCURRENCY || 4)));

  await mapPool(jobs, concurrency, async (job, idx) => {
    let rows = null;
    let err = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rows = await fetchStatsimIcaoWindow(job.icao, job.fromMs, job.toMs, apiKey, { timeoutMs: 90000 });
        err = null;
        break;
      } catch (e) {
        err = e && e.message ? e.message : String(e);
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    if (typeof onProgress === "function" && ((idx + 1) % 25 === 0 || idx + 1 === jobs.length)) {
      onProgress(idx + 1, jobs.length, job.label);
    }
    if (err) {
      failed++;
      lastErr = err;
      if (failed <= 8) console.warn("API icao failed", job.label, err);
      return;
    }
    for (const f of rows) {
      const k = f.kind + "|" + f.callsign + "|" + f.origin + "|" + f.dest + "|" + f.timeMs;
      if (seen[k]) continue;
      seen[k] = 1;
      all.push(f);
    }
  });

  if (!all.length) {
    throw new Error(lastErr || "No StatSim API flights returned");
  }
  console.log("API flights", all.length, "from", icaos.length, "airports ·",
    windows.length, "window(s) · failed", failed + "/" + jobs.length);
  return { flights: all, chunks: jobs.length, failedChunks: failed, source: "api-icao" };
}

function histEmptyBucket() { return { dep: 0, arr: 0 }; }
function histScore(b) { return (b.dep || 0) + (b.arr || 0); }

/** Recommended staff-up length: 2hr minimum, 4hr maximum around the busiest block. */
const STAFF_HIST_MIN_HOURS = 2;
const STAFF_HIST_MAX_HOURS = 4;

function histBucketAt(hourMap, h) {
  if (!hourMap) return histEmptyBucket();
  return hourMap[h] || hourMap[String(h)] || histEmptyBucket();
}

/** Best contiguous 2–4 hour staff-up window (higher score wins; shorter on ties). */
function histHourWindow(hourMap) {
  let best = null;
  for (let span = STAFF_HIST_MIN_HOURS; span <= STAFF_HIST_MAX_HOURS; span++) {
    for (let start = 0; start <= 24 - span; start++) {
      const end = start + span - 1;
      let dep = 0, arr = 0;
      for (let h = start; h <= end; h++) {
        const b = histBucketAt(hourMap, h);
        dep += b.dep || 0;
        arr += b.arr || 0;
      }
      const score = dep + arr;
      if (score <= 0) continue;
      if (!best || score > best.score ||
          (score === best.score && span < (best.endHour - best.startHour + 1))) {
        best = { startHour: start, endHour: end, dep, arr, score };
      }
    }
  }
  return best;
}

function histFmtHourRange(startHour, endHour) {
  const a = String(startHour).padStart(2, "0") + "00";
  const b = String((endHour + 1) % 24).padStart(2, "0") + "00";
  return a + "\u2013" + b + "Z";
}

function histReason(dep, arr) {
  if (dep && arr) return "arrivals and departures";
  if (arr) return "arrivals";
  if (dep) return "departures";
  return "traffic";
}

export function aggregateStatsimHistorical(flights) {
  const byAirport = {};
  let used = 0;
  for (const f of flights) {
    const targets = [];
    if (f.kind === "dep" && isUsStaffingAirport(f.origin)) targets.push({ icao: f.origin, type: "dep" });
    if (f.kind === "arr" && isUsStaffingAirport(f.dest)) targets.push({ icao: f.dest, type: "arr" });
    if (!targets.length) continue;
    const d = new Date(f.timeMs);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    for (const t of targets) {
      used++;
      if (!byAirport[t.icao]) byAirport[t.icao] = { totalDep: 0, totalArr: 0, days: {} };
      const apt = byAirport[t.icao];
      if (!apt.days[dow]) apt.days[dow] = {};
      if (!apt.days[dow][hour]) apt.days[dow][hour] = histEmptyBucket();
      apt.days[dow][hour][t.type]++;
      if (t.type === "dep") apt.totalDep++; else apt.totalArr++;
    }
  }

  const towerSlots = [];
  const centerMap = {};
  for (const icao of Object.keys(byAirport)) {
    const apt = byAirport[icao];
    const artcc = airportStaffingArtcc(icao);
    for (let dow = 0; dow < 7; dow++) {
      const hourMap = apt.days[dow];
      if (!hourMap) continue;
      const win = histHourWindow(hourMap);
      if (!win || win.score < 3) continue;
      towerSlots.push({
        id: icao,
        type: "TWR",
        dow,
        dowLabel: DOW[dow],
        startHour: win.startHour,
        endHour: win.endHour,
        dep: win.dep,
        arr: win.arr,
        score: win.score,
        windowLabel: histFmtHourRange(win.startHour, win.endHour),
        reason: histReason(win.dep, win.arr)
      });
      if (artcc) {
        const k = artcc + "|" + dow + "|" + win.startHour + "|" + win.endHour;
        if (!centerMap[k]) {
          centerMap[k] = {
            id: artcc, type: "CTR", dow, dowLabel: DOW[dow],
            startHour: win.startHour, endHour: win.endHour, dep: 0, arr: 0, score: 0,
            windowLabel: histFmtHourRange(win.startHour, win.endHour), airports: {}
          };
        }
        centerMap[k].dep += win.dep;
        centerMap[k].arr += win.arr;
        centerMap[k].score += win.score;
        centerMap[k].airports[icao] = (centerMap[k].airports[icao] || 0) + win.score;
      }
    }
  }

  towerSlots.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.dow - b.dow);
  const centers = Object.values(centerMap).map(r => {
    r.reason = histReason(r.dep, r.arr);
    return r;
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.dow - b.dow);

  const topAirports = Object.keys(byAirport).map(icao => ({
    icao,
    total: byAirport[icao].totalDep + byAirport[icao].totalArr,
    dep: byAirport[icao].totalDep,
    arr: byAirport[icao].totalArr
  })).sort((a, b) => b.total - a.total || a.icao.localeCompare(b.icao));

  /*
   * Keep byAirport for every airport that produced a staffing window so the
   * Historical table can filter any facility (e.g. KMCO / ZJX), not only the
   * global top-N peaks. Heatmap cells stay compact because days/hours are sparse.
   */
  const keepIcaos = new Set(towerSlots.map(t => t.id));
  for (const a of topAirports.slice(0, 100)) keepIcaos.add(a.icao);
  const byAirportOut = {};
  for (const icao of keepIcaos) {
    if (byAirport[icao]) byAirportOut[icao] = byAirport[icao];
  }

  return {
    flightRows: flights.length,
    usEvents: used,
    byAirport: byAirportOut,
    topAirports: topAirports.slice(0, 100),
    /* Full slot lists — table filtering needs more than the top 40 hubs. */
    towers: towerSlots,
    approaches: [],
    centers
  };
}

export async function fetchStatsimUrlText(url, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "VATFLOW-staffing-hist/1.0 (+https://vatflow.io)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    if (!text || !/Departed/i.test(text)) throw new Error("Unexpected StatSim response");
    if (statsimResponseIsEmptyShell(text)) {
      throw new Error(
        "StatSim HTML returned empty Departed/Arrived tables (blocked or Blazor shell). " +
        "Set STATSIM_API_KEY (create at https://statsim.net/api-keys)."
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPeriodFlights(period, onProgress) {
  const apiKey = (process.env.STATSIM_API_KEY || "").trim();
  if (apiKey) {
    return fetchPeriodFlightsFromApi(period, apiKey, onProgress);
  }

  const jobs = statsimFetchJobs(period);
  const all = [];
  const seen = Object.create(null);
  let failed = 0;
  let lastErr = null;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (typeof onProgress === "function") onProgress(i + 1, jobs.length, job.label);
    try {
      const text = await fetchStatsimUrlText(job.url);
      const rows = parseStatsimCountryText(text);
      for (const f of rows) {
        const k = f.kind + "|" + f.callsign + "|" + f.origin + "|" + f.dest + "|" + f.timeMs;
        if (seen[k]) continue;
        seen[k] = 1;
        all.push(f);
      }
    } catch (e) {
      failed++;
      lastErr = e && e.message ? e.message : String(e);
      if (jobs.length === 1) throw e;
      console.warn("chunk failed", job.label, lastErr);
    }
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, 250));
  }
  if (!all.length) {
    throw new Error(
      (lastErr || "No StatSim flights returned") +
      " — HTML scrape is unreliable from CI; set repo secret STATSIM_API_KEY " +
      "(https://statsim.net/api-keys)."
    );
  }
  return { flights: all, chunks: jobs.length, failedChunks: failed, source: "html" };
}
