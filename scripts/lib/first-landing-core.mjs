/**
 * First to Land: the list of US fields with no VATSIM landing on Statsim since January 2020,
 * and the pieces scripts/build-first-landing.mjs keeps it current with. Pure functions, no
 * network, so scripts/test-first-landing.mjs can check them.
 *
 * The fields are the FAA's (NASR airport data, the 28-day cycle): open airports and seaplane
 * bases in the US and its territories. OurAirports was the first source, but it keeps closed
 * fields and codes the FAA has since given to another facility.
 *
 * data/first-landing/fields.json:
 *   { asOf, crawledTo, faaCycle, cols, fields: [row...], landed: [[lat, lon]...] }
 *   row = [ident, name, city, state, type, lat, lon, elev, longestRwy, paved, lit,
 *          status, deps, local, iata, guardNm, checked, use, xplane]
 *   ident: the FAA's ICAO code where it has one, else the FAA identifier (LID): F31, not KF31
 *   local: the FAA identifier (LID)
 *   type: s airport, w seaplane base
 *   status: 0 no traffic at all, 1 departures but no landing
 *   guardNm: distance to the nearest other airport (the hub's landing radius is at most half)
 *   checked: last date the field's own Statsim page was read (YYYY-MM-DD)
 *   use: PU public use, PR private use (the FAA's facility use)
 *   xplane: 1 when X-Plane ships the field (Scenery Gateway, recommended scenery), else 0
 *   landed: positions of the fields that have seen a landing, for the map's background
 */
import zlib from "node:zlib";

export const COLS = ["ident", "name", "city", "state", "type", "lat", "lon", "elev", "longestRwy", "paved", "lit",
  "status", "deps", "local", "iata", "guardNm", "checked", "use", "xplane"];
export const C = Object.fromEntries(COLS.map((k, i) => [k, i]));
export const STATSIM_START_MS = Date.UTC(2020, 0, 1);

const pad = (n) => String(n).padStart(2, "0");
/** StatSim's URL time format, UTC: "2026-10-19 14:05". */
export function fmtStatsim(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function parseStatsimTime(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/** Windows of at most `days` days from fromMs to toMs (StatSim pages get huge past a week). */
export function weekWindows(fromMs, toMs, days = 7) {
  const out = [];
  for (let t = fromMs; t < toMs; t += days * 86400000) out.push([t, Math.min(t + days * 86400000 - 60000, toMs)]);
  return out;
}

const ROW_RE = /<tr><td><a href="\/flights\/detail\/(\d+)">([^<]*)<\/a><\/td>\s*<td>(?:<a[^>]*>)?([^<]*)(?:<\/a>)?<\/td>\s*<td>(?:<a[^>]*>)?([^<]*)(?:<\/a>)?<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td><\/tr>/g;
// Copy out of the page: a regex match keeps the whole multi-megabyte page alive otherwise.
const own = (s) => Buffer.from(String(s).trim()).toString();

/**
 * A StatSim flights page (country or airport): its Departed and Arrived tables.
 * Each flight: { id, callsign, origin, dest, time (ms), aircraft }. `counts` are the
 * totals in the section headings, to check nothing was missed.
 */
export function parseFlightsPage(html) {
  html = String(html || "");
  const ai = html.search(/<h4>\s*Arrived/);
  const sections = { dep: ai >= 0 ? html.slice(0, ai) : html, arr: ai >= 0 ? html.slice(ai) : "" };
  const out = { dep: [], arr: [], counts: { dep: 0, arr: 0 } };
  for (const k of ["dep", "arr"]) {
    ROW_RE.lastIndex = 0;
    let m;
    while ((m = ROW_RE.exec(sections[k]))) {
      out[k].push({ id: +m[1], callsign: own(m[2]), origin: own(m[3]).toUpperCase(), dest: own(m[4]).toUpperCase(),
        time: parseStatsimTime(m[5]), aircraft: own(m[6]) });
    }
  }
  out.counts.dep = +((html.match(/Departed \((\d+)\)/) || [])[1] || 0);
  out.counts.arr = +((html.match(/Arrived \((\d+)\)/) || [])[1] || 0);
  return out;
}

/**
 * Every code a field may be filed as. Pilots file small US fields both ways: 1N7 and K1N7.
 * `extra` are further codes known for it.
 */
export function fieldCodes(ident, local, ...extra) {
  const out = [];
  const add = (c) => { c = String(c || "").trim().toUpperCase(); if (c && /^[A-Z0-9]+$/.test(c) && !out.includes(c)) out.push(c); };
  add(ident); extra.forEach(add); add(local);
  if (/^[A-Z0-9]{3}$/.test(String(local || "").toUpperCase())) add("K" + local);
  return out;
}

/** code -> row, for every code of every field. */
export function codeIndex(rows) {
  const m = new Map();
  for (const r of rows) for (const c of fieldCodes(r[C.ident], r[C.local])) if (!m.has(c)) m.set(c, r);
  return m;
}

/**
 * Apply one batch of StatSim flights to the field list. A field someone arrived at is
 * removed (returned in `landed` with the earliest arrival seen); a departure makes an
 * untouched field "departed, never landed". Departures come from the Departed table only:
 * the origin in the Arrived table is just what was filed, and a field's own StatSim page
 * often shows no departure for it. `seen` (flight ids) stops a flight in two overlapping
 * windows counting twice.
 */
export function applyFlights(rows, flights, seen = new Set()) {
  const byCode = codeIndex(rows);
  const landed = new Map();
  for (const f of flights.arr) {
    const r = byCode.get(f.dest);
    if (!r) continue;
    const prev = landed.get(r[C.ident]);
    if (!prev || (f.time != null && f.time < prev.time)) landed.set(r[C.ident], { callsign: f.callsign, time: f.time, aircraft: f.aircraft });
  }
  for (const f of flights.dep) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const r = byCode.get(f.origin);
    if (!r) continue;
    r[C.deps] = (r[C.deps] || 0) + 1;
    r[C.status] = 1;
  }
  return { rows: rows.filter((r) => !landed.has(r[C.ident])), landed };
}

/** Nautical miles between two points. */
export function distNm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * For each [lat, lon, id] in `points`, the distance to the nearest of `others` ([lat, lon, id],
 * skipping the one with the same id), capped at `cap` nm. Grid search, so the whole US list
 * takes a second.
 */
export function nearestDistances(points, others, cap = 10) {
  const cell = (la, lo) => Math.floor(la * 4) + ":" + Math.floor(lo * 4);   // quarter-degree cells
  const grid = new Map();
  others.forEach((p, i) => { const k = cell(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  return points.map(([la, lo, selfId]) => {
    let best = cap;
    const ci = Math.floor(la * 4), cj = Math.floor(lo * 4);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const k of grid.get((ci + i) + ":" + (cj + j)) || []) {
        const o = others[k];
        if (selfId != null && o[2] === selfId) continue;
        const d = distNm(la, lo, o[0], o[1]);
        if (d < best) best = d;
      }
    }
    return Math.round(best * 10) / 10;
  });
}

/** Minimal CSV parser for the FAA files (quoted fields, commas inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}


/* ---------- FAA (NASR) ---------- */


const FAA_CYCLE_ANCHOR = Date.UTC(2026, 9, 1);      // a known NASR effective date; cycles are 28 days
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Effective date (ms, UTC midnight) of the NASR cycle in force at `nowMs`. */
export function faaCycle(nowMs) {
  return FAA_CYCLE_ANCHOR + Math.floor((nowMs - FAA_CYCLE_ANCHOR) / (28 * 86400000)) * 28 * 86400000;
}
/** The airport CSV download for a cycle: .../extra/01_Oct_2026_APT_CSV.zip */
export function faaAptCsvUrl(cycleMs) {
  const d = new Date(cycleMs);
  return `https://nfdc.faa.gov/webContent/28DaySub/extra/${pad(d.getUTCDate())}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}_APT_CSV.zip`;
}

/** One file out of a zip archive (stored or deflated), by name. */
export function unzipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString("latin1", p + 46, p + 46 + nlen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(name + " not in zip");
}

const FAA_ABBR = { Meml: "Memorial", Rgnl: "Regional", Muni: "Municipal", Fld: "Field", Arpt: "Airport", Intl: "International",
  Co: "County", Spb: "Seaplane Base", Arpk: "Airpark", Strp: "Strip" };
/** "THAYER MEML" -> "Thayer Memorial" */
export function faaTitle(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Meml|Rgnl|Muni|Fld|Arpt|Intl|Co|Spb|Arpk|Strp)\b/g, (m) => FAA_ABBR[m]);
}

/**
 * NASR APT_BASE + APT_RWY rows -> Map FAA id -> field. `open` is an airport (A) or seaplane
 * base (C), operational, in the US or a territory; closed fields, heliports, gliderports,
 * ultralight and balloon fields are kept with open false so the daily run can drop them.
 */
export function faaFields(baseRows, rwyRows) {
  const rwy = new Map();
  for (const r of rwyRows) {
    const cur = rwy.get(r.SITE_NO) || { len: 0, paved: 0, lit: 0 };
    cur.len = Math.max(cur.len, parseInt(r.RWY_LEN, 10) || 0);
    if (/^(ASPH|CONC|PEM|BIT)/.test(r.SURFACE_TYPE_CODE)) cur.paved = 1;
    if (r.RWY_LGT_CODE && r.RWY_LGT_CODE !== "NONE") cur.lit = 1;
    rwy.set(r.SITE_NO, cur);
  }
  const out = new Map();
  for (const r of baseRows) {
    out.set(r.ARPT_ID, {
      id: r.ARPT_ID, icao: r.ICAO_ID || "", site: r.SITE_NO,
      open: (r.SITE_TYPE_CODE === "A" || r.SITE_TYPE_CODE === "C") && r.ARPT_STATUS === "O" && r.COUNTRY_CODE === "US" && !!r.STATE_CODE,
      type: r.SITE_TYPE_CODE === "C" ? "w" : "s", siteType: r.SITE_TYPE_CODE, status: r.ARPT_STATUS,
      name: faaTitle(r.ARPT_NAME), city: faaTitle(r.CITY), state: r.STATE_CODE,
      lat: +r.LAT_DECIMAL, lon: +r.LONG_DECIMAL, elev: r.ELEV === "" ? null : Math.round(+r.ELEV),
      use: r.FACILITY_USE_CODE, rwy: rwy.get(r.SITE_NO) || { len: 0, paved: 0, lit: 0 },
    });
  }
  return out;
}

/** The codes a field may be filed as: its ICAO code, its FAA id, and K + a 3-character id. */
export function faaCodes(f) {
  return fieldCodes(f.icao || f.id, f.id);
}

/** X-Plane Scenery Gateway airport list -> Set of codes X-Plane ships (recommended scenery, not deprecated). */
export function xplaneCodes(gateway) {
  const s = new Set();
  for (const a of (gateway && gateway.airports) || []) if (!a.Deprecated && a.RecommendedSceneryId != null) s.add(a.AirportCode);
  return s;
}
