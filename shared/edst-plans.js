/**
 * EDST Plans Display: flight plan readouts, trial plans and amendment plans (ERAM RA-Position
 * User Manual, TI 6110.101 ch. 6). Pure text building, no DOM, so it can be tested in node
 * (scripts/test-edst-plans.mjs). The window itself lives in vusalink/edst/index.html.
 *
 * Plan entry (index.html keeps a list of these):
 *   {id, kind: 'current'|'proposed'|'prev'|'trial'|'am', cs, tn (trial number), trial: {alt, int, spd,
 *    route, direct, ptime}, created, expires, accepted, icao}
 */

export const VATSIM_DATA_URL = "https://data.vatsim.net/v3/vatsim-data.json";
export const TRIAL_LIFE_MS = 5 * 60 * 1000;   // a trial plan expires 5 min after it was made
export const AM_KEEP_MS = 30 * 1000;          // an accepted AM plan is removed after 30 s
export const NEW_PROBLEM_MS = 60 * 1000;      // a problem shows NEW for its first minute

// Order of entries in the display (6.1.3): current plans on top, then proposed, previous route,
// trial and amendment plans.
const KIND_ORDER = { current: 0, proposed: 1, prev: 2, trial: 3, am: 4 };
export function sortPlans(plans) {
  return plans.slice().sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.created - b.created));
}

export function pad3(n) {
  return ("000" + Math.round(Math.abs(+n || 0))).slice(-3);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function hhmm(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

/** CID shown in the plan ID: the CRC CID if CRC told us (QF), else the last 3 digits of the VATSIM CID. */
export function planCid(crcCid, vatsimCid) {
  if (crcCid) return String(crcCid);
  const s = String(vatsimCid || "").replace(/\D/g, "");
  return s ? s.slice(-3).padStart(3, "0") : "---";
}

/** Plan ID suffix: .T1 for trial 1, .AM, .PR (previous route). */
export function planSuffix(p) {
  if (p.kind === "trial") return ".T" + (p.tn || 1);
  if (p.kind === "am") return ".AM";
  if (p.kind === "prev") return ".PR";
  return "";
}

/**
 * Flight plan fields from a VATSIM data-feed pilot or prefile ({callsign, cid, flight_plan}).
 * type is the FAA form without the wake prefix ("H/B744/L" -> "B744/L").
 */
export function fpFromVatsim(p) {
  const fp = (p && p.flight_plan) || {};
  const faa = String(fp.aircraft_faa || fp.aircraft_short || "").trim().toUpperCase();
  const m = faa.match(/^[A-Z]\/(.+)$/);
  return {
    cs: String((p && p.callsign) || "").toUpperCase(),
    vatsimCid: (p && p.cid) || "",
    type: m ? m[1] : faa,
    icaoType: String(fp.aircraft || "").trim().toUpperCase(),
    tas: parseInt(fp.cruise_tas, 10) || 0,
    alt: String(fp.altitude || "").trim().toUpperCase(),
    dep: String(fp.departure || "").toUpperCase(),
    arr: String(fp.arrival || "").toUpperCase(),
    altn: String(fp.alternate || "").toUpperCase(),
    route: String(fp.route || "").trim().toUpperCase().replace(/\s+/g, " "),
    rmk: String(fp.remarks || "").trim().toUpperCase(),
    deptime: String(fp.deptime || "").replace(/\D/g, ""),
    enroute: String(fp.enroute_time || "").replace(/\D/g, ""),
    rules: String(fp.flight_rules || "I").toUpperCase(),
    bcn: /^0+$/.test(String(fp.assigned_transponder || "").trim()) ? "" : String(fp.assigned_transponder || "").trim(),
  };
}

/** Index a VATSIM data feed by callsign (pilots win over prefiles). */
export function indexFeed(feed) {
  const out = new Map();
  for (const pf of (feed && feed.prefiles) || []) {
    const f = fpFromVatsim(pf);
    if (f.cs) out.set(f.cs, f);
  }
  for (const p of (feed && feed.pilots) || []) {
    if (!p.flight_plan) continue;
    const f = fpFromVatsim(p);
    if (f.cs) out.set(f.cs, f);
  }
  return out;
}

let feedCache = { at: 0, map: new Map(), p: null };
/** VATSIM flight plans by callsign, fetched at most every 15 s. */
export async function fetchFlightPlans(force) {
  if (!force && Date.now() - feedCache.at < 15000) return feedCache.map;
  if (feedCache.p) return feedCache.p;
  feedCache.p = (async () => {
    try {
      const r = await fetch(VATSIM_DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error("VATSIM HTTP " + r.status);
      feedCache = { at: Date.now(), map: indexFeed(await r.json()), p: null };
    } catch (e) {
      feedCache.p = null;
      throw e;
    }
    return feedCache.map;
  })();
  return feedCache.p;
}

/**
 * Non-ADS-B (6.1): the ICAO surveillance codes after the second "/" of the equipment
 * ("B738/M-SDE3FGHIRWXY/LB1"). B1/B2 (1090), U1/U2 (UAT) and V1/V2 (VDL4) are ADS-B out.
 * Unknown (no ICAO equipment) is not flagged.
 */
export function isNonAdsb(icaoType) {
  const s = String(icaoType || "").toUpperCase();
  const parts = s.split("/");
  if (parts.length < 3) return false;
  const surv = parts[2];
  return !/[BUV][12]/.test(surv);
}

/** Cruise altitude for the readout: "35000" / "FL350" -> "350", "VFR" kept. */
export function fpAltText(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (/^VFR/.test(s)) return s;
  const fl = s.match(/^F?L?(\d+)$/);
  if (!fl) return s;
  const n = parseInt(fl[1], 10);
  return pad3(n >= 1000 ? Math.round(n / 100) : n);
}

/** Position as an ERAM lat/lon fix: 38.57N 80.67W -> "3834/8040" (DDMM/DDMM, DDDMM past 99W). */
export function latLonFix(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(+lat) || !Number.isFinite(+lon)) return "";
  const dm = (v) => {
    v = Math.abs(+v);
    let d = Math.floor(v), m = Math.round((v - d) * 60);
    if (m === 60) { d++; m = 0; }
    return { d, m };
  };
  const a = dm(lat), o = dm(lon);
  const lonD = o.d >= 100 ? String(o.d) : String(o.d).padStart(2, "0");
  return pad2(a.d) + pad2(a.m) + "/" + lonD + pad2(o.m);
}

// Airway or procedure ("J4", "Q167", "CIVET8", "SSOXS7"): joined with "." in ERAM routes, fixes with "..".
function isPath(x) {
  return /^[A-Z]{1,2}\d{1,4}$/.test(x) || /^[A-Z]{3,6}\d{1,2}[A-Z]?$/.test(x);
}

/** Route tokens, without DCT, speed/level groups ("N0450F350") and "/..." suffixes. */
export function routeTokens(rt) {
  return String(rt || "").trim().toUpperCase().split(/[\s.]+/)
    .map((x) => (/^\d{4}\/\d{4,5}$/.test(x) ? x : x.split("/")[0]))   // keep lat/lon fixes (3834/08040)
    .filter((x) => x && x !== "DCT" && !/^[NKM]\d{3,4}[FAS]\d{3,4}$/.test(x));
}

/** ERAM dotted route: "KBOS SSOXS7 SSOXS Q167 ZIZZI KNUKK" -> "KBOS.SSOXS7.SSOXS.Q167.ZIZZI..KNUKK". */
export function eramRoute(rt) {
  const t = routeTokens(rt);
  return t.map((x, i) => (i === 0 ? x : ((isPath(x) || isPath(t[i - 1])) ? "." : "..") + x)).join("");
}

/**
 * The route still to fly: starts at the first token that is one of the fixes ahead of the aircraft
 * (aheadNames, nearest first). Nothing matched: the whole route.
 */
export function remainingRoute(rt, aheadNames, dep, arr) {
  let t = routeTokens(rt).filter((x) => x !== dep && x !== arr);
  const ahead = new Set((aheadNames || []).map((x) => String(x).toUpperCase()));
  if (ahead.size) {
    const i = t.findIndex((x) => ahead.has(x));
    if (i > 0) t = t.slice(i);
  }
  return t.join(" ");
}

/**
 * Route line of a readout. Airborne (pos given): "DEP./.POS..rest.ARR"; on the ground or proposed:
 * "DEP.route.ARR". ETA ("/1534") is appended when given.
 */
export function readoutRoute({ dep, arr, route, pos, eta }) {
  const t = routeTokens(route);
  if (arr && t[t.length - 1] !== arr) t.push(arr);
  let s;
  if (pos) {
    const body = eramRoute(t.join(" "));
    s = (dep ? dep + "./." : "") + pos + (body ? (isPath(t[0]) ? "." : "..") + body : "");
  } else {
    if (dep && t[0] !== dep) t.unshift(dep);
    s = eramRoute(t.join(" "));
  }
  return s + (eta ? "/" + eta : "");
}

/**
 * Flight plan readout (current or proposed plan): line 1 is TYPE BCN SPD FIX TIM ALT, line 2 the route.
 * fp: fpFromVatsim fields (or what the ACL row has). tim: "E1305" (estimated at the fix, active),
 * "P1530" (proposed departure) or "D1716" (departed).
 */
export function readoutLines(fp, { fix, tim, alt, pos, aheadNames, eta } = {}) {
  const l1 = [fp.type || "----", fp.bcn || "", fp.tas ? pad3(fp.tas) : "", fix || "", tim || "",
    alt != null && alt !== "" ? alt : fpAltText(fp.alt)].filter((x) => x !== "").join(" ");
  const route = pos ? remainingRoute(fp.route, aheadNames, fp.dep, fp.arr) : routeTokens(fp.route)
    .filter((x) => x !== fp.dep && x !== fp.arr).join(" ");
  return [l1, readoutRoute({ dep: fp.dep, arr: fp.arr, route, pos, eta })];
}

/** What a trial or AM plan changes, as ERAM shows it: "AM 321 ALT 290 FIX 3834/8040 TIM E1305". */
export function amLine(cid, trial, { fix, tim } = {}) {
  const parts = ["AM", cid];
  if (trial.alt != null) parts.push(trial.int ? "INT" : "ALT", pad3(trial.alt));
  if (trial.spd != null) parts.push("SPD", trial.mach ? "M" + trial.spd : pad3(trial.spd));
  if (trial.ptime) parts.push("PTIME", "P" + trial.ptime);
  if (fix) parts.push("FIX", fix);
  if (tim) parts.push("TIM", tim);
  return parts.join(" ");
}

/** Trial route after a direct-to: the route from that fix on. */
export function directRoute(rt, fix, dep, arr) {
  const t = routeTokens(rt).filter((x) => x !== dep && x !== arr);
  const i = t.indexOf(String(fix || "").toUpperCase());
  return (i >= 0 ? t.slice(i) : [String(fix || "").toUpperCase()].concat(t)).join(" ");
}

/** The destination the route ends at, if its last token is an airport (4 letters, starts with K/P/C/M/T). */
export function routeDest(rt) {
  const t = routeTokens(rt);
  const last = t[t.length - 1] || "";
  return /^[KPCMT][A-Z]{3}$/.test(last) ? last : "";
}

/** Great-circle distance (NM). */
export function distNm(la1, lo1, la2, lo2) {
  const R = 3440.065, r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** ETA (HHMM Z) at the end of the given fixes ([{lat,lon}]) from (lat,lon) at gs kt. */
export function etaAlong(lat, lon, fixes, gs, now = Date.now()) {
  if (lat == null || lon == null || !(gs > 30) || !fixes || !fixes.length) return "";
  let nm = 0, pa = +lat, po = +lon;
  for (const f of fixes) {
    if (f.lat == null || f.lon == null) continue;
    nm += distNm(pa, po, +f.lat, +f.lon);
    pa = +f.lat; po = +f.lon;
  }
  if (!nm) return "";
  return hhmm(now + (nm / gs) * 3600000);
}

/**
 * Fixes for a trial route: the current fix list re-ordered to follow the trial route's tokens,
 * keeping only fixes whose names are on it (fixes we have no coordinates for are skipped).
 */
export function trialFixes(fixes, route) {
  const byName = new Map();
  for (const f of fixes || []) if (f && f.name && !byName.has(f.name)) byName.set(String(f.name).toUpperCase(), f);
  const out = [];
  for (const t of routeTokens(route)) {
    const f = byName.get(t);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * ICAO data (6.3.13): the FPL fields 7-18 from the VATSIM plan, e.g.
 * "-B738/M-SDE3FGHIRWXY/LB1 -KATL1530 -N0450F350 PENCL3 SOT -KIAD0130 KBWI -RMK/TCAS".
 */
export function icaoLines(fp) {
  if (!fp) return [];
  const lvl = (() => {
    const a = fpAltText(fp.alt);
    if (/^\d{3}$/.test(a)) return "F" + a;
    return a.startsWith("VFR") ? "VFR" : a;
  })();
  const spd = fp.tas ? "N" + String(fp.tas).padStart(4, "0") : "";
  const lines = [
    "-" + fp.cs + "-" + (fp.rules === "V" ? "V" : "I") + "S",
    "-" + (fp.icaoType || fp.type || "ZZZZ"),
    "-" + (fp.dep || "ZZZZ") + (fp.deptime ? fp.deptime.padStart(4, "0") : ""),
    "-" + spd + lvl + " " + (fp.route || "DCT"),
    "-" + (fp.arr || "ZZZZ") + (fp.enroute ? fp.enroute.padStart(4, "0") : "") + (fp.altn ? " " + fp.altn : ""),
  ];
  if (fp.rmk) lines.push("-" + fp.rmk);
  return lines;
}

/** Problem line: "N22T 5 min 1535Z (25)". */
export function problemText(pr, now = Date.now()) {
  const min = Math.max(0, Math.round(pr.tMin || 0));
  return [pr.cs, min + " min", hhmm(now + (pr.tMin || 0) * 60000) + "Z"].join(" ") + (pr.sector ? " (" + pr.sector + ")" : "");
}

/** Countdown box text for a trial plan: "4:59". */
export function countdown(expires, now = Date.now()) {
  const s = Math.max(0, Math.ceil((expires - now) / 1000));
  return Math.floor(s / 60) + ":" + pad2(s % 60);
}

/**
 * CRC commands for an amendment (one per field: CRC's AM takes one field at a time; ERAM command
 * reference, docs.virtualnas.net/crc/eram). {FLID} is replaced by the callsign.
 * changes: {alt, int, spd, mach, route, direct, type, bcn, rmk}
 */
export function crcAmendLines(changes) {
  const c = changes || {};
  const out = [];
  if (c.alt != null) out.push((c.int ? "QQ " : "QZ ") + pad3(c.alt) + " {FLID}");
  if (c.type) out.push("AM {FLID} TYP " + c.type);
  if (c.bcn) out.push("AM {FLID} BCN " + c.bcn);
  if (c.spd != null && !c.mach) out.push("AM {FLID} SPD " + pad3(c.spd));   // CRC has no Mach form
  if (c.direct) out.push("QU " + c.direct + " {FLID}");          // direct-to: ERAM QU, like the ACL Route Menu
  else if (c.route) out.push("AM {FLID} RTE " + eramRoute(c.route));
  if (c.rmk != null) out.push("AM {FLID} RMK" + (c.rmk ? (/\s/.test(c.rmk) ? " ++" + c.rmk + "++" : " " + c.rmk) : ""));
  return out;
}

/** Trial departure time from the menu input: "1545" -> next occurrence (more than 30 min ago = tomorrow). */
export function ptimeMs(hhmmStr, now = Date.now()) {
  const s = String(hhmmStr || "").replace(/\D/g, "");
  if (!/^\d{4}$/.test(s)) return null;
  let h = +s.slice(0, 2);
  const m = +s.slice(2);
  if (h === 24 && m === 0) h = 0;
  if (h > 23 || m > 59) return null;
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  if (t < now - 30 * 60000) t += 86400000;
  return t;
}
