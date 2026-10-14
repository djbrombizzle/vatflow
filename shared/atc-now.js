/**
 * Where's ATC now: for a pilot about to fly, the staffed airports within reach
 * of their departure field, so they can pick a destination with ATC online.
 *
 * The ZDC traffic study (Oct 2026) found a staffed partner field brings about
 * 1.44x the traffic to it; DCA's lead over IAD and BWI is short hops to BOS and
 * NYC. This board puts that choice in front of the pilot.
 *
 * Pure functions on the VATSIM v3 feed. The page (pilot.html) supplies:
 *   airportLL(icao)  -> [lat, lon] | null      (shared/fca-metering.js getAirport)
 *   artccFor(lat, lon) -> "ZDC" | null         (artccLocator over data/artcc-boundaries-low.geojson:
 *                                                the low stratum, since the high one puts some fields,
 *                                                such as MCO and PHL, under the neighbouring center)
 *   traconMap        TRACON_PREFIX_MAP        (approach-sector-data.js)
 *   approachMap      VATSPY_APPROACH_MAP      (approach-sector-data.js: ICAO -> LID)
 */

const AVG_KT = 420;          // block speed for "about N h" (climb and descent included below)
const OVERHEAD_MIN = 25;     // taxi, climb, descent and approach on top of the cruise leg
export const DEFAULT_RADIUS_NM = 800;   // about two hours' flight, same range ATC Ops uses
export const EVENT_SOON_MIN = 180;

/* Big US fields worth listing when only the center above them is online. */
const MAJOR_US = new Set((
  "KPHX KABQ KTUS KORD KMDW KMKE KBOS KBDL KPVD KMHT KDCA KIAD KBWI KRIC KORF KRDU KDEN KCOS KSLC KDFW KDAL " +
  "KOKC KAUS KIAH KHOU KMSY KSAT KIND KCVG KCMH KMCO KJAX KTLH KCHS KSAV KMCI KSTL KOMA KLAX KSAN KSNA KBUR " +
  "KLGB KPSP KLAS KRNO KMIA KFLL KTPA KPBI KRSW KMEM KBNA KMSP KEWR KLGA KJFK KPHL KBUF KSFO KOAK KSJC KSMF " +
  "KCLE KDTW KPIT KSEA KPDX KATL KCLT PANC PHNL").split(" "));

/* Center callsign prefixes that aren't the ARTCC id (same table as ATC Ops). */
const CTR_ALIASES = {
  CHI: "ZAU", C90: "ZAU", ORD: "ZAU", NYC: "ZNY", NY: "ZNY", DC: "ZDC", WAS: "ZDC", JAX: "ZJX",
  HOU: "ZHU", IAH: "ZHU", LA: "ZLA", LAX: "ZLA", LAS: "ZLA", SF: "ZOA", SFO: "ZOA", OAK: "ZOA",
  DEN: "ZDV", DAL: "ZFW", DFW: "ZFW", FTW: "ZFW", MIA: "ZMA", FLL: "ZMA", TPA: "ZMA", BOS: "ZBW",
  SEA: "ZSE", PDX: "ZSE", ATL: "ZTL", CLT: "ZTL", MEM: "ZME", BNA: "ZME", SLC: "ZLC", PHX: "ZAB",
  ABQ: "ZAB", IND: "ZID", CVG: "ZID", CLE: "ZOB", DTW: "ZOB", PIT: "ZOB", MSP: "ZMP", KC: "ZKC",
  STL: "ZKC", ANC: "ZAN", HNL: "ZHN",
};
const US_ARTCCS = new Set("ZAB ZAU ZBW ZDC ZDV ZFW ZHU ZID ZJX ZKC ZLA ZLC ZMA ZME ZMP ZNY ZOA ZOB ZSE ZTL ZAN ZHN".split(" "));
/* Alaska / Hawaii fields keep their 3-letter LID on VATSIM. */
const NON_K = { ANC: "PANC", FAI: "PAFA", JNU: "PAJN", HNL: "PHNL", OGG: "PHOG", KOA: "PHKO", ITO: "PHTO", LIH: "PHLI" };

/* Fields whose pilots fly most to these partners (ZDC traffic study, Oct 2026). */
export const PARTNERS = {
  KDCA: ["KBOS", "KJFK", "KLGA", "KEWR", "KATL", "KORD"],
  KIAD: ["KBOS", "KJFK", "KLGA", "KEWR", "KATL", "KORD"],
  KBWI: ["KBOS", "KJFK", "KLGA", "KEWR", "KATL", "KORD"],
};

const RANK = { DEL: 0, GND: 1, TWR: 2, APP: 3, CTR: 4 };

function gcNm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Callsign prefix (ZDC, IAD, KIAD, NY) -> ICAO, or null. */
export function fieldIcao(prefix, airportLL) {
  const p = String(prefix || "").toUpperCase();
  if (NON_K[p]) return NON_K[p];
  if (/^[A-Z]{4}$/.test(p) && airportLL(p)) return p;
  if (/^[A-Z0-9]{3}$/.test(p) && airportLL("K" + p)) return "K" + p;
  return null;
}

/**
 * Index for approach callsigns: approach prefix (PCT, N90, IAD) -> Set of ICAOs it covers.
 * TRACON_PREFIX_MAP lists the prefixes each TRACON uses; VATSPY_APPROACH_MAP gives each field's LID.
 */
export function approachIndex(traconMap = {}, approachMap = {}) {
  const lidToIcaos = {};
  for (const [icao, lid] of Object.entries(approachMap || {})) {
    if (!/^[A-Z0-9]{4}$/.test(icao)) continue;
    const l = String(lid || "").toUpperCase();
    (lidToIcaos[l] = lidToIcaos[l] || []).push(icao);
  }
  const out = {};
  for (const [tid, prefixes] of Object.entries(traconMap || {})) {
    const fields = new Set();
    for (const p of prefixes || []) for (const icao of lidToIcaos[String(p).toUpperCase()] || []) fields.add(icao);
    if (!fields.size) continue;
    for (const p of [tid, ...(prefixes || [])]) {
      const k = String(p).toUpperCase();
      out[k] = out[k] || new Set();
      for (const f of fields) out[k].add(f);
    }
  }
  return out;
}

/** Controller -> { kind: "DEL"|"GND"|"TWR"|"APP"|"CTR", prefix } or null (observers, FSS, supervisors). */
export function parseController(c) {
  const cs = String((c && c.callsign) || "").toUpperCase();
  const m = cs.match(/^([A-Z0-9]+)(?:_[A-Z0-9]+)*_(DEL|GND|TWR|APP|DEP|CTR)$/);
  if (!m || (c.facility != null && c.facility < 2)) return null;
  return { kind: m[2] === "DEP" ? "APP" : m[2], prefix: m[1], callsign: cs, freq: c.frequency || "" };
}

/**
 * Staffed airports within radiusNm of `from`.
 * Returns { from: { icao, ll, positions }, rows: [{ icao, distNm, flightMin, positions: [{ kind, callsign, freq }],
 * levels: ["TWR","APP","CTR"], top, inbound, departing, atis, event, partner }] } best first, or null
 * when `from` isn't a known airport.
 */
export function atcNowBoard({
  feed = {}, from, airportLL, artccFor = () => null, apIdx = {}, events = [], now = Date.now(),
  radiusNm = DEFAULT_RADIUS_NM,
}) {
  const origin = String(from || "").toUpperCase();
  const oll = airportLL(origin);
  if (!oll) return null;

  /* who covers what */
  const byField = new Map();               // icao -> [{ kind, callsign, freq }]
  const ctrs = new Map();                  // ARTCC -> [{ kind, callsign, freq }]
  const add = (icao, p) => { if (!byField.has(icao)) byField.set(icao, []); byField.get(icao).push(p); };
  for (const c of feed.controllers || []) {
    const p = parseController(c);
    if (!p) continue;
    const pos = { kind: p.kind, callsign: p.callsign, freq: p.freq };
    if (p.kind === "CTR") {
      const id = US_ARTCCS.has(p.prefix) ? p.prefix : CTR_ALIASES[p.prefix];
      if (id) { if (!ctrs.has(id)) ctrs.set(id, []); ctrs.get(id).push(pos); }
      continue;
    }
    if (p.kind === "APP") {
      const fields = apIdx[p.prefix];
      if (fields && fields.size) { for (const f of fields) add(f, pos); continue; }
    }
    const icao = fieldIcao(p.prefix, airportLL);
    if (icao) add(icao, pos);
  }
  const atis = {};
  for (const a of feed.atis || []) {
    const m = String(a.callsign || "").toUpperCase().match(/^([A-Z0-9]+)(?:_[AD])?_ATIS$/);
    const icao = m && fieldIcao(m[1], airportLL);
    if (icao && !atis[icao]) atis[icao] = a.atis_code || "";
  }

  /* traffic to and from each field */
  const inbound = {}, departing = {};
  for (const p of feed.pilots || []) {
    const fp = p.flight_plan;
    if (!fp) continue;
    const arr = String(fp.arrival || "").toUpperCase(), dep = String(fp.departure || "").toUpperCase();
    if ((p.groundspeed || 0) >= 50 && arr) inbound[arr] = (inbound[arr] || 0) + 1;
    else if (dep) departing[dep] = (departing[dep] || 0) + 1;
  }

  /* events at a field starting within EVENT_SOON_MIN (or running now) */
  const eventAt = {};
  for (const e of events || []) {
    if (!(e.endMs > now) || e.startMs > now + EVENT_SOON_MIN * 60000) continue;
    for (const a of e.airports || []) if (!eventAt[a] || e.startMs < eventAt[a].startMs) eventAt[a] = e;
  }

  const candidates = new Set([...byField.keys()]);
  if (ctrs.size) for (const icao of MAJOR_US) candidates.add(icao);
  for (const icao of Object.keys(eventAt)) candidates.add(icao);
  candidates.add(origin);
  const partners = new Set(PARTNERS[origin] || []);

  const build = icao => {
    const ll = airportLL(icao);
    if (!ll) return null;
    const positions = [...(byField.get(icao) || [])];
    const artcc = /^(K|PA|PH)/.test(icao) ? artccFor(ll[0], ll[1]) : null;
    if (artcc && ctrs.has(artcc)) positions.push(...ctrs.get(artcc));
    positions.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.callsign.localeCompare(b.callsign));
    const levels = [...new Set(positions.map(p => p.kind === "DEL" || p.kind === "GND" ? "TWR" : p.kind))];
    const local = positions.some(p => p.kind !== "CTR");
    const distNm = Math.round(gcNm(oll[0], oll[1], ll[0], ll[1]));
    return {
      icao, ll, distNm, flightMin: Math.round(distNm / AVG_KT * 60 + OVERHEAD_MIN), positions, artcc,
      levels: ["TWR", "APP", "CTR"].filter(l => levels.includes(l)), local,
      top: positions.length ? positions[0].kind : null,
      inbound: inbound[icao] || 0, departing: departing[icao] || 0, atis: atis[icao] ?? null,
      event: eventAt[icao] || null, partner: partners.has(icao),
    };
  };

  const rows = [];
  for (const icao of candidates) {
    if (icao === origin) continue;
    const r = build(icao);
    if (!r || r.distNm > radiusNm || r.distNm < 40) continue;
    if (!r.positions.length && !r.event) continue;
    rows.push(r);
  }
  /* local ATC first (more layers better), then events, then CTR-only; partners and busier fields lead each group */
  const score = r => (r.local ? 100 : 0) + r.levels.length * 20 + (r.event ? 15 : 0) + (r.partner && r.positions.length ? 30 : 0) + Math.min(r.inbound, 20);
  rows.sort((a, b) => score(b) - score(a) || a.distNm - b.distNm);
  return { from: build(origin), rows };
}

/** ARTCC boundary GeoJSON -> (lat, lon) => ARTCC id | null (ray cast on each polygon's outer ring). */
export function artccLocator(geo) {
  const list = [];
  for (const f of (geo && geo.features) || []) {
    const id = String((f.properties || {}).id || "").toUpperCase();
    const g = f.geometry;
    if (!id || id.includes("-") || !g) continue;
    const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map(p => p[0]) : [];
    for (const r of rings) if (r && r.length > 2) list.push([id, r]);
  }
  const inRing = (lat, lon, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (lat, lon) => {
    for (const [id, r] of list) if (inRing(lat, lon, r)) return id;
    return null;
  };
}

/** "1 h 40" / "55 min" */
export function fmtFlight(min) {
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${min} min`;
}
