/**
 * Shared StatSim USA historical aggregation for ATC Staffing.
 * Used by the Monday precompute job (Node) — no browser/CORS proxies.
 */
export const PERIODS = ["thisweek", "thismonth", "thisyear"];
export const STATSIM_COUNTRY_US = "https://statsim.net/flights/countries/country/US/";
export const STATSIM_CHUNK_DAYS = 7;
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Departed\b/i.test(line)) { mode = "dep"; continue; }
    if (/^Arrived\b/i.test(line)) { mode = "arr"; continue; }
    if (!mode) continue;
    if (/^Callsign\b/i.test(line)) continue;
    if (/^#{1,6}\s/.test(line) || /^United States$/i.test(line)) { mode = null; continue; }
    const parts = line.includes("\t") ? line.split(/\t+/) : line.split(/\|/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 5) continue;
    if (/^-{2,}$/.test(parts[0])) continue;
    const t = parseStatsimTime(parts[3]);
    if (t == null) continue;
    pushFlight(out, parts[0], parts[1], parts[2], t, mode, parts[4]);
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

function histEmptyBucket() { return { dep: 0, arr: 0 }; }
function histScore(b) { return (b.dep || 0) + (b.arr || 0); }

function histHourWindow(hourMap) {
  let bestH = -1, bestScore = 0;
  for (let h = 0; h < 24; h++) {
    const sc = histScore(hourMap[h] || histEmptyBucket());
    if (sc > bestScore) { bestScore = sc; bestH = h; }
  }
  if (bestH < 0 || bestScore <= 0) return null;
  const floor = Math.max(2, Math.ceil(bestScore * 0.35));
  let start = bestH, end = bestH;
  while (start > 0 && histScore(hourMap[start - 1] || histEmptyBucket()) >= floor) start--;
  while (end < 23 && histScore(hourMap[end + 1] || histEmptyBucket()) >= floor) end++;
  let dep = 0, arr = 0;
  for (let h = start; h <= end; h++) {
    const b = hourMap[h] || histEmptyBucket();
    dep += b.dep; arr += b.arr;
  }
  return { startHour: start, endHour: end, dep, arr, score: dep + arr };
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
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.dow - b.dow).slice(0, 20);

  const topAirports = Object.keys(byAirport).map(icao => ({
    icao,
    total: byAirport[icao].totalDep + byAirport[icao].totalArr,
    dep: byAirport[icao].totalDep,
    arr: byAirport[icao].totalArr
  })).sort((a, b) => b.total - a.total || a.icao.localeCompare(b.icao));

  /* Keep heatmap data for busiest airports only (keeps JSON size manageable). */
  const heatIcaos = new Set(topAirports.slice(0, 40).map(a => a.icao));
  for (const t of towerSlots.slice(0, 40)) heatIcaos.add(t.id);
  const byAirportSlim = {};
  for (const icao of heatIcaos) {
    if (byAirport[icao]) byAirportSlim[icao] = byAirport[icao];
  }

  return {
    flightRows: flights.length,
    usEvents: used,
    byAirport: byAirportSlim,
    topAirports: topAirports.slice(0, 25),
    towers: towerSlots.slice(0, 40),
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
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPeriodFlights(period, onProgress) {
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
  if (!all.length) throw new Error(lastErr || "No StatSim flights returned");
  return { flights: all, chunks: jobs.length, failedChunks: failed };
}
